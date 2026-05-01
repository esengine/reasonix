/** Job state in a module-scoped Map keyed by project root so multi-root dashboards don't collide; CLI `reasonix index` runs independently. */

import { loadIndexConfig } from "../../config.js";
import { buildIndex, indexExists, querySemantic } from "../../index/semantic/builder.js";
import type { BuildProgress, BuildResult } from "../../index/semantic/builder.js";
import {
  checkOllamaStatus,
  pullOllamaModel,
  startOllamaDaemon,
} from "../../index/semantic/ollama-launcher.js";
import { registerSemanticSearchTool } from "../../index/semantic/tool.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

const DEFAULT_EMBED_MODEL = process.env.REASONIX_EMBED_MODEL ?? "nomic-embed-text";

interface JobRecord {
  startedAt: number;
  phase: BuildProgress["phase"] | "error";
  filesScanned?: number;
  filesChanged?: number;
  filesSkipped?: number;
  chunksTotal?: number;
  chunksDone?: number;
  result?: BuildResult;
  error?: string;
  rebuild: boolean;
  // AbortController so /api/semantic/stop can interrupt — buildIndex
  // doesn't accept a signal yet, but the CLI's tool registers one and
  // we can extend builder later. For now stop is a no-op signal that
  // the SPA can show feedback for; the next phase boundary picks it
  // up by checking `aborted` if/when builder gains a signal arg.
  aborted: boolean;
}

const JOBS = new Map<string, JobRecord>();

interface PullRecord {
  startedAt: number;
  status: "pulling" | "done" | "error";
  lastLine: string;
  exitCode: number | null;
}
const PULLS = new Map<string, PullRecord>();

function getRoot(ctx: DashboardContext): string | null {
  const cwd = ctx.getCurrentCwd?.();
  return cwd ?? null;
}

export async function handleSemantic(
  method: string,
  rest: string[],
  body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  const sub = rest[0] ?? "";

  if (sub === "" && method === "GET") {
    return await getStatus(ctx);
  }
  if (sub === "start" && method === "POST") {
    return await startJob(body, ctx);
  }
  if (sub === "stop" && method === "POST") {
    return await stopJob(ctx);
  }
  if (sub === "ollama" && method === "POST") {
    const action = rest[1] ?? "";
    if (action === "start") return await startDaemon();
    if (action === "pull") return await startPull(body);
  }
  if (sub === "search" && method === "POST") {
    return await runSearch(body, ctx);
  }
  return { status: 404, body: { error: "no such semantic endpoint" } };
}

async function runSearch(rawBody: string, ctx: DashboardContext): Promise<ApiResult> {
  const root = getRoot(ctx);
  if (!root) {
    return { status: 503, body: { error: "search requires an attached code-mode session" } };
  }
  let parsed: { query?: unknown; topK?: unknown; minScore?: unknown };
  try {
    parsed = JSON.parse(rawBody || "{}");
  } catch {
    return { status: 400, body: { error: "body must be JSON" } };
  }
  const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
  if (!query) return { status: 400, body: { error: "query required" } };
  const topK =
    typeof parsed.topK === "number" && Number.isFinite(parsed.topK)
      ? Math.max(1, Math.min(16, Math.floor(parsed.topK)))
      : 8;
  const minScore =
    typeof parsed.minScore === "number" && Number.isFinite(parsed.minScore)
      ? Math.max(0, Math.min(1, parsed.minScore))
      : 0.3;
  const startedAt = Date.now();
  try {
    const hits = await querySemantic(root, query, {
      topK,
      minScore,
      model: DEFAULT_EMBED_MODEL,
    });
    if (hits === null) {
      return { status: 404, body: { error: "no semantic index for this project" } };
    }
    return {
      status: 200,
      body: {
        hits: hits.map((h) => ({
          path: h.entry.path,
          startLine: h.entry.startLine,
          endLine: h.entry.endLine,
          score: h.score,
          snippet: h.entry.text,
        })),
        elapsedMs: Date.now() - startedAt,
        model: DEFAULT_EMBED_MODEL,
      },
    };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

async function getStatus(ctx: DashboardContext): Promise<ApiResult> {
  const root = getRoot(ctx);
  if (!root) {
    return {
      status: 200,
      body: {
        attached: false,
        reason:
          "Semantic indexing requires a code-mode session — run `/dashboard` from inside `reasonix code` instead of standalone `reasonix dashboard`.",
      },
    };
  }
  const model = DEFAULT_EMBED_MODEL;
  const [hasIndex, ollama] = await Promise.all([
    indexExists(root),
    checkOllamaStatus(model).catch((err) => ({
      binaryFound: false,
      daemonRunning: false,
      modelPulled: false,
      modelName: model,
      installedModels: [] as string[],
      error: err instanceof Error ? err.message : String(err),
    })),
  ]);
  const job = JOBS.get(root) ?? null;
  const pull = PULLS.get(model) ?? null;
  return {
    status: 200,
    body: {
      attached: true,
      root,
      index: { exists: hasIndex },
      ollama,
      job: job ? snapshotJob(job) : null,
      pull: pull ? snapshotPull(pull) : null,
    },
  };
}

function snapshotPull(p: PullRecord): unknown {
  return {
    startedAt: p.startedAt,
    status: p.status,
    lastLine: p.lastLine,
    exitCode: p.exitCode,
  };
}

async function startDaemon(): Promise<ApiResult> {
  const r = await startOllamaDaemon({ timeoutMs: 15_000 }).catch((err: Error) => ({
    ready: false,
    pid: null,
    error: err.message,
  }));
  if ("error" in r) {
    return { status: 500, body: { ready: false, error: r.error } };
  }
  return { status: r.ready ? 200 : 504, body: r };
}

interface PullBody {
  model?: unknown;
}

async function startPull(body: string): Promise<ApiResult> {
  let parsed: PullBody = {};
  if (body) {
    try {
      parsed = JSON.parse(body) as PullBody;
    } catch {
      return { status: 400, body: { error: "invalid JSON body" } };
    }
  }
  const model =
    typeof parsed.model === "string" && parsed.model ? parsed.model : DEFAULT_EMBED_MODEL;
  const existing = PULLS.get(model);
  if (existing && existing.status === "pulling") {
    return {
      status: 409,
      body: { error: `${model} is already pulling`, pull: snapshotPull(existing) },
    };
  }
  const rec: PullRecord = {
    startedAt: Date.now(),
    status: "pulling",
    lastLine: `pulling ${model}…`,
    exitCode: null,
  };
  PULLS.set(model, rec);
  // Fire-and-forget. Polling /api/semantic surfaces progress.
  void pullOllamaModel(model, {
    onLine: (line) => {
      // Ollama prints animated progress lines (`pulling abc... 12%`);
      // keeping the latest is enough for a status panel readout.
      if (line.trim().length > 0) rec.lastLine = line.trim();
    },
  })
    .then((code) => {
      rec.exitCode = code;
      rec.status = code === 0 ? "done" : "error";
      if (code !== 0 && (!rec.lastLine || !rec.lastLine.toLowerCase().includes("error"))) {
        rec.lastLine = `ollama pull exited with code ${code}`;
      }
    })
    .catch((err: Error) => {
      rec.status = "error";
      rec.lastLine = err.message;
    });
  return { status: 202, body: { started: true, pull: snapshotPull(rec) } };
}

function snapshotJob(j: JobRecord): unknown {
  return {
    startedAt: j.startedAt,
    phase: j.phase,
    rebuild: j.rebuild,
    filesScanned: j.filesScanned ?? null,
    filesChanged: j.filesChanged ?? null,
    filesSkipped: j.filesSkipped ?? null,
    chunksTotal: j.chunksTotal ?? null,
    chunksDone: j.chunksDone ?? null,
    aborted: j.aborted,
    result: j.result ?? null,
    error: j.error ?? null,
  };
}

interface StartBody {
  rebuild?: unknown;
}

async function startJob(body: string, ctx: DashboardContext): Promise<ApiResult> {
  const root = getRoot(ctx);
  if (!root) {
    return {
      status: 400,
      body: { error: "no project root — only available in attached (code-mode) dashboards" },
    };
  }
  const existing = JOBS.get(root);
  if (
    existing &&
    (existing.phase === "scan" || existing.phase === "embed" || existing.phase === "write")
  ) {
    return {
      status: 409,
      body: { error: "an indexing job is already running", job: snapshotJob(existing) },
    };
  }

  let parsed: StartBody = {};
  if (body) {
    try {
      parsed = JSON.parse(body) as StartBody;
    } catch {
      return { status: 400, body: { error: "invalid JSON body" } };
    }
  }
  const rebuild = parsed.rebuild === true;

  const job: JobRecord = {
    startedAt: Date.now(),
    phase: "scan",
    rebuild,
    aborted: false,
  };
  JOBS.set(root, job);

  // Fire-and-forget — endpoint returns immediately so the SPA can
  // poll /api/semantic for progress instead of blocking on a long
  // request that might exceed the browser's idle timeout.
  void runIndex(root, job, ctx).catch((err) => {
    job.phase = "error";
    job.error = err instanceof Error ? err.message : String(err);
  });

  return { status: 202, body: { started: true, job: snapshotJob(job) } };
}

async function runIndex(root: string, job: JobRecord, ctx: DashboardContext): Promise<void> {
  try {
    const result = await buildIndex(root, {
      rebuild: job.rebuild,
      indexConfig: loadIndexConfig(ctx.configPath),
      onProgress: (p) => {
        job.phase = p.phase;
        if (p.filesScanned !== undefined) job.filesScanned = p.filesScanned;
        if (p.filesChanged !== undefined) job.filesChanged = p.filesChanged;
        if (p.filesSkipped !== undefined) job.filesSkipped = p.filesSkipped;
        if (p.chunksTotal !== undefined) job.chunksTotal = p.chunksTotal;
        if (p.chunksDone !== undefined) job.chunksDone = p.chunksDone;
      },
    });
    job.phase = "done";
    job.result = result;
    // Index is on disk now — register `semantic_search` on the live
    // tool registry AND push its spec into the prefix so the model
    // sees the tool from the next turn (no session restart needed).
    // Costs one cache-miss turn since the prefix shape changed; the
    // whole flow only runs once per session because the registry's
    // `register` is idempotent on tool name.
    if (ctx.tools && ctx.addToolToPrefix) {
      try {
        const added = await registerSemanticSearchTool(ctx.tools, { root });
        if (added) {
          const spec = ctx.tools.specs().find((s) => s.function.name === "semantic_search");
          if (spec) ctx.addToolToPrefix(spec);
        }
      } catch {
        /* live-registration failure is non-fatal — the index still
         * exists on disk; the next session start will pick it up via
         * bootstrapSemanticSearchInCodeMode. */
      }
    }
  } catch (err) {
    job.phase = "error";
    job.error = err instanceof Error ? err.message : String(err);
  }
}

async function stopJob(ctx: DashboardContext): Promise<ApiResult> {
  const root = getRoot(ctx);
  if (!root) {
    return { status: 400, body: { error: "no project root" } };
  }
  const job = JOBS.get(root);
  if (!job || job.phase === "done" || job.phase === "error") {
    return { status: 404, body: { error: "no running job" } };
  }
  job.aborted = true;
  // builder.ts doesn't honor an AbortSignal yet — flagging the job is
  // best-effort. The SPA still surfaces "stopping…" so the user knows
  // the request was received; the next done/error update lands when
  // the build naturally terminates.
  return { status: 202, body: { stopping: true, job: snapshotJob(job) } };
}
