import { promises as fs } from "node:fs";
import path from "node:path";
import { type ResolvedIndexConfig, defaultIndexConfig } from "../config.js";
import { walkChunks } from "./chunker.js";
import type { CodeChunk, SkipReason } from "./chunker.js";
import { embed, embedAll, probeOllama } from "./embedding.js";
import type { EmbedOptions } from "./embedding.js";
import { normalize, openStore } from "./store.js";
import type { IndexEntry, SearchHit } from "./store.js";

/** Default index dir relative to the project root. */
export const INDEX_DIR_NAME = path.join(".reasonix", "semantic");

export interface BuildOptions extends EmbedOptions {
  /** Lines per window. Default 60. */
  windowLines?: number;
  /** Window overlap. Default 12. */
  overlap?: number;
  /** Force a full rebuild (drop the existing index first). */
  rebuild?: boolean;
  /** Resolved exclude/limit settings. Defaults to package defaults. */
  indexConfig?: ResolvedIndexConfig;
  /** Progress callback for the CLI to render counters. */
  onProgress?: (info: BuildProgress) => void;
}

export type SkipBuckets = Record<SkipReason, number>;

export interface BuildProgress {
  phase: "scan" | "embed" | "write" | "done";
  filesScanned?: number;
  chunksTotal?: number;
  chunksDone?: number;
  filesSkipped?: number;
  filesChanged?: number;
  skipBuckets?: SkipBuckets;
}

export interface BuildResult {
  filesScanned: number;
  filesChanged: number;
  chunksAdded: number;
  chunksRemoved: number;
  /** Chunks that failed to embed (Ollama 500, transient errors) and
   *  were skipped. Reported in the success line so users notice. */
  chunksSkipped: number;
  /** Per-reason file-skip tally from the walk. */
  skipBuckets: SkipBuckets;
  durationMs: number;
}

function emptyBuckets(): SkipBuckets {
  return {
    defaultDir: 0,
    defaultFile: 0,
    binaryExt: 0,
    binaryContent: 0,
    tooLarge: 0,
    gitignore: 0,
    pattern: 0,
    readError: 0,
  };
}

/** Probes Ollama first so a missing daemon fails before any chunking work. */
export async function buildIndex(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const t0 = Date.now();
  const indexDir = path.join(root, INDEX_DIR_NAME);

  const probe = await probeOllama({ baseUrl: opts.baseUrl, signal: opts.signal });
  if (!probe.ok) {
    throw new Error(
      `Ollama is not reachable: ${probe.error}. Install from https://ollama.com, then \`ollama serve\` and \`ollama pull ${opts.model ?? "nomic-embed-text"}\`.`,
    );
  }

  const model = opts.model ?? process.env.REASONIX_EMBED_MODEL ?? "nomic-embed-text";
  const store = await openStore(indexDir, model);
  if (opts.rebuild) await store.wipe();

  // Snapshot the index's per-file mtimes so we can detect (a) changed
  // files (mtime moved) and (b) deleted files (path no longer exists
  // on disk after the walk).
  const lastMtimes = store.fileMtimes();
  const seenPaths = new Set<string>();

  // Buffer chunks per file — partial updates must drop+re-add atomically per file.
  const fileChunks = new Map<string, { chunks: CodeChunk[]; mtimeMs: number }>();
  let filesScanned = 0;
  let filesSkipped = 0;
  const skipBuckets = emptyBuckets();
  for await (const chunk of walkChunks(root, {
    windowLines: opts.windowLines,
    overlap: opts.overlap,
    config: opts.indexConfig ?? defaultIndexConfig(),
    onSkip: (_p, reason) => {
      skipBuckets[reason]++;
    },
  })) {
    seenPaths.add(chunk.path);
    let bucket = fileChunks.get(chunk.path);
    if (!bucket) {
      filesScanned++;
      const abs = path.join(root, chunk.path);
      let mtimeMs = 0;
      try {
        const stat = await fs.stat(abs);
        mtimeMs = stat.mtimeMs;
      } catch {
        continue;
      }
      const last = lastMtimes.get(chunk.path);
      if (last !== undefined && last === mtimeMs && !opts.rebuild) {
        filesSkipped++;
        continue; // Unchanged — skip embedding.
      }
      bucket = { chunks: [], mtimeMs };
      fileChunks.set(chunk.path, bucket);
    }
    bucket.chunks.push(chunk);
    opts.onProgress?.({ phase: "scan", filesScanned });
  }

  const deletedPaths: string[] = [];
  for (const oldPath of lastMtimes.keys()) {
    if (!seenPaths.has(oldPath)) deletedPaths.push(oldPath);
  }
  // Evict old chunks before re-insert — otherwise the same range duplicates.
  const replacePaths = [...fileChunks.keys()].filter((p) => lastMtimes.has(p));
  const removed = await store.remove([...deletedPaths, ...replacePaths]);

  // Per-chunk embed errors are logged + null-slotted so one bad chunk doesn't kill a long build.
  let chunksAdded = 0;
  let chunksSkipped = 0;
  const filesChanged = fileChunks.size;
  let chunksTotal = 0;
  for (const { chunks } of fileChunks.values()) chunksTotal += chunks.length;
  let chunksDone = 0;
  for (const [, bucket] of fileChunks) {
    if (bucket.chunks.length === 0) continue;
    const texts = bucket.chunks.map((c) => c.text);
    const vectors = await embedAll(texts, {
      ...opts,
      onProgress: (done, total) => {
        opts.onProgress?.({
          phase: "embed",
          filesScanned,
          filesChanged,
          chunksTotal,
          chunksDone: chunksDone + done,
        });
        if (done === total) chunksDone += total;
      },
      onError: (idx, err) => {
        chunksSkipped++;
        const c = bucket.chunks[idx];
        const where = c ? `${c.path}:${c.startLine}-${c.endLine}` : `chunk #${idx}`;
        const msg = err instanceof Error ? err.message : String(err);
        // stderr only — non-fatal warnings shouldn't pollute stdout
        // (which the rest of the CLI keeps clean for piping).
        process.stderr.write(`\n  ! skipped ${where}: ${msg}\n`);
      },
    });
    const entries: IndexEntry[] = [];
    for (let i = 0; i < bucket.chunks.length; i++) {
      const vec = vectors[i];
      if (!vec) continue; // skipped due to per-chunk error
      const c = bucket.chunks[i];
      if (!c) continue;
      normalize(vec);
      entries.push({
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        embedding: vec,
        mtimeMs: bucket.mtimeMs,
      });
    }
    if (entries.length > 0) await store.add(entries);
    chunksAdded += entries.length;
  }

  opts.onProgress?.({
    phase: "done",
    filesScanned,
    filesSkipped,
    filesChanged,
    chunksTotal,
    chunksDone,
    skipBuckets,
  });

  return {
    filesScanned,
    filesChanged,
    chunksAdded,
    chunksRemoved: removed,
    chunksSkipped,
    skipBuckets,
    durationMs: Date.now() - t0,
  };
}

export interface QueryOptions extends EmbedOptions {
  topK?: number;
  /** Drop hits below this cosine score. Default 0.3 — anything weaker is noise. */
  minScore?: number;
}

/** Returns null when no index exists, so caller can fall back to grep with a hint. */
export async function querySemantic(
  root: string,
  query: string,
  opts: QueryOptions = {},
): Promise<SearchHit[] | null> {
  const indexDir = path.join(root, INDEX_DIR_NAME);
  const model = opts.model ?? process.env.REASONIX_EMBED_MODEL ?? "nomic-embed-text";
  const store = await openStore(indexDir, model);
  if (store.empty) return null;
  const qvec = await embed(query, opts);
  normalize(qvec);
  return store.search(qvec, opts.topK ?? 8, opts.minScore ?? 0.3);
}

/** Gates `semantic_search` registration — no index → no tool exposed. */
export async function indexExists(root: string): Promise<boolean> {
  const meta = path.join(root, INDEX_DIR_NAME, "index.meta.json");
  try {
    await fs.access(meta);
    return true;
  } catch {
    return false;
  }
}
