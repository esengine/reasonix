/** Line-window chunker (not AST) — language-agnostic, every chunk carries exact startLine/endLine for cite-back. */

import { promises as fs } from "node:fs";
import path from "node:path";
import { type GitignoreLayer, ignoredByLayers, loadGitignoreAt } from "../../gitignore.js";
import {
  type IndexFilters,
  type ResolvedIndexConfig,
  compileFilters,
  defaultIndexConfig,
} from "../config.js";

export interface CodeChunk {
  /** Path relative to the index root, forward slashes. Stable across OS. */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}

export type SkipReason =
  | "defaultDir"
  | "defaultFile"
  | "binaryExt"
  | "binaryContent"
  | "tooLarge"
  | "gitignore"
  | "pattern"
  | "readError";

export interface ChunkOptions {
  /** Lines per window. Default 60. */
  windowLines?: number;
  /** Lines of overlap between consecutive windows. Default 12. */
  overlap?: number;
  /** Default 4000 — keeps unicode-heavy slices under nomic-embed-text's 8K-token window. */
  maxChunkChars?: number;
  /** Resolved exclude/limit settings. Falls back to package defaults when omitted. */
  config?: ResolvedIndexConfig;
  /** Tally callback for files that didn't make it into the index. */
  onSkip?: (relPath: string, reason: SkipReason) => void;
}

/** Default character cap per chunk — sized for nomic-embed-text. */
export const DEFAULT_MAX_CHUNK_CHARS = 4000;

export function chunkText(
  text: string,
  filePath: string,
  windowLines: number,
  overlap: number,
  maxChunkChars: number = DEFAULT_MAX_CHUNK_CHARS,
): CodeChunk[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return [];
  const stride = Math.max(1, windowLines - overlap);
  const chunks: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(lines.length, start + windowLines);
    const slice = lines.slice(start, end).join("\n").trim();
    if (slice.length === 0) {
      if (end >= lines.length) break;
      continue;
    }
    const window: CodeChunk = {
      path: filePath,
      startLine: start + 1,
      endLine: end,
      text: slice,
    };
    for (const sub of safeSplit(window, maxChunkChars)) chunks.push(sub);
    if (end >= lines.length) break;
  }
  return chunks;
}

function safeSplit(chunk: CodeChunk, maxChars: number): CodeChunk[] {
  if (chunk.text.length <= maxChars) return [chunk];
  const lines = chunk.text.split("\n");
  const out: CodeChunk[] = [];
  let bufLines: string[] = [];
  let bufStart = chunk.startLine;
  let bufLen = 0;
  const flush = (untilLineNo: number): void => {
    if (bufLines.length === 0) return;
    out.push({
      path: chunk.path,
      startLine: bufStart,
      endLine: untilLineNo,
      text: bufLines.join("\n"),
    });
    bufLines = [];
    bufLen = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineLen = line.length + 1;
    if (lineLen > maxChars) {
      flush(chunk.startLine + i - 1);
      out.push({
        path: chunk.path,
        startLine: chunk.startLine + i,
        endLine: chunk.startLine + i,
        text: line.slice(0, maxChars),
      });
      bufStart = chunk.startLine + i + 1;
      continue;
    }
    if (bufLen + lineLen > maxChars && bufLines.length > 0) {
      flush(chunk.startLine + i - 1);
      bufStart = chunk.startLine + i;
    }
    bufLines.push(line);
    bufLen += lineLen;
  }
  flush(chunk.endLine);
  return out;
}

function toForwardRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

interface WalkFrame {
  dir: string;
  layers: readonly GitignoreLayer[];
}

export async function* walkChunks(
  root: string,
  opts: ChunkOptions = {},
): AsyncGenerator<CodeChunk> {
  const windowLines = opts.windowLines ?? 60;
  const overlap = Math.min(opts.overlap ?? 12, Math.max(0, windowLines - 1));
  const maxChunkChars = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const filters: IndexFilters = compileFilters(opts.config ?? defaultIndexConfig());
  const onSkip = opts.onSkip ?? (() => {});

  const initial: GitignoreLayer[] = [];
  if (filters.respectGitignore) {
    const rootIg = await loadGitignoreAt(root);
    if (rootIg) initial.push({ dirAbs: root, ig: rootIg });
  }

  const stack: WalkFrame[] = [{ dir: root, layers: initial }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { dir, layers } = frame;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      const abs = path.join(dir, name);
      const rel = toForwardRel(root, abs);
      if (entry.isDirectory()) {
        if (filters.dirSet.has(name)) {
          onSkip(rel, "defaultDir");
          continue;
        }
        if (filters.respectGitignore && ignoredByLayers(layers, abs, true)) {
          onSkip(rel, "gitignore");
          continue;
        }
        if (filters.patternMatch(`${rel}/`) || filters.patternMatch(rel)) {
          onSkip(rel, "pattern");
          continue;
        }
        const childLayers = filters.respectGitignore ? await extendLayers(layers, abs) : layers;
        stack.push({ dir: abs, layers: childLayers });
        continue;
      }
      if (!entry.isFile()) continue;
      if (filters.fileSet.has(name)) {
        onSkip(rel, "defaultFile");
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      if (filters.extSet.has(ext)) {
        onSkip(rel, "binaryExt");
        continue;
      }
      if (filters.respectGitignore && ignoredByLayers(layers, abs, false)) {
        onSkip(rel, "gitignore");
        continue;
      }
      if (filters.patternMatch(rel)) {
        onSkip(rel, "pattern");
        continue;
      }
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(abs);
      } catch {
        onSkip(rel, "readError");
        continue;
      }
      if (stat.size > filters.maxFileBytes) {
        onSkip(rel, "tooLarge");
        continue;
      }
      let text: string;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        onSkip(rel, "readError");
        continue;
      }
      if (text.indexOf("\0") !== -1) {
        onSkip(rel, "binaryContent");
        continue;
      }
      for (const chunk of chunkText(text, rel, windowLines, overlap, maxChunkChars)) {
        yield chunk;
      }
    }
  }
}

async function extendLayers(
  layers: readonly GitignoreLayer[],
  dirAbs: string,
): Promise<readonly GitignoreLayer[]> {
  const ig = await loadGitignoreAt(dirAbs);
  return ig ? [...layers, { dirAbs, ig }] : layers;
}

export async function chunkDirectory(root: string, opts: ChunkOptions = {}): Promise<CodeChunk[]> {
  const out: CodeChunk[] = [];
  for await (const c of walkChunks(root, opts)) out.push(c);
  return out;
}
