/** Harvest-bench runner — writes results.json. CLI flags + sample invocations in benchmarks/README.md. */

import { type WriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
  claudeEquivalentCost,
  loadDotenv,
} from "../../src/index.js";
import { openTranscriptFile, recordFromLoopEvent, writeRecord } from "../../src/transcript/log.js";
import { TASKS } from "./tasks.js";
import type {
  HarvestBenchMeta,
  HarvestBenchReport,
  HarvestMode,
  HarvestRunResult,
  HarvestTask,
} from "./types.js";
import { ALL_MODES } from "./types.js";

loadDotenv();

interface CliArgs {
  taskFilter: string | null;
  modes: HarvestMode[];
  repeats: number;
  outPath: string | null;
  transcriptsDir: string | null;
  /** Per-HTTP-call timeout in ms. Default 300_000 (5 min) — reasoner + harvest runs legitimately need this. */
  timeoutMs: number;
  dry: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    taskFilter: null,
    modes: [...ALL_MODES],
    repeats: 1,
    outPath: null,
    transcriptsDir: null,
    timeoutMs: 300_000,
    dry: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") out.taskFilter = argv[++i] ?? null;
    else if (a === "--mode") {
      const v = (argv[++i] ?? "").toLowerCase() as HarvestMode;
      if ((ALL_MODES as string[]).includes(v)) out.modes = [v];
    } else if (a === "--repeats") out.repeats = Number.parseInt(argv[++i] ?? "1", 10);
    else if (a === "--out") out.outPath = argv[++i] ?? null;
    else if (a === "--transcripts-dir") out.transcriptsDir = argv[++i] ?? null;
    else if (a === "--timeout") {
      // Accept seconds for humans, convert to ms internally.
      const secs = Number.parseInt(argv[++i] ?? "300", 10);
      if (Number.isFinite(secs) && secs > 0) out.timeoutMs = secs * 1000;
    } else if (a === "--dry") out.dry = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
  }
  return out;
}

function modelForMode(mode: HarvestMode): string {
  if (mode === "baseline") return "deepseek-chat";
  return "deepseek-reasoner";
}

function harvestForMode(mode: HarvestMode): boolean {
  return mode === "reasoner-harvest";
}

async function runOnce(
  task: HarvestTask,
  mode: HarvestMode,
  rep: number,
  client: DeepSeekClient,
  transcriptStream: WriteStream | null,
): Promise<HarvestRunResult> {
  const model = modelForMode(mode);
  const harvest = harvestForMode(mode);

  const prefix = new ImmutablePrefix({ system: task.systemPrompt });
  const loop = new CacheFirstLoop({
    client,
    prefix,
    model,
    harvest,
    stream: false,
  });
  const prefixHash = prefix.fingerprint;

  let harvestedTurns = 0;
  let totalSubgoals = 0;
  let totalUncertainties = 0;
  let totalHypotheses = 0;
  let totalRejectedPaths = 0;
  let finalText = "";
  let errorMessage: string | undefined;

  if (transcriptStream) {
    writeRecord(transcriptStream, {
      ts: new Date().toISOString(),
      turn: 1,
      role: "user",
      content: task.prompt,
    });
  }

  try {
    for await (const ev of loop.step(task.prompt)) {
      if (transcriptStream && ev.role !== "assistant_delta") {
        writeRecord(transcriptStream, recordFromLoopEvent(ev, { model, prefixHash }));
      }
      if (ev.role === "assistant_final") {
        finalText = ev.content;
        if (ev.planState) {
          if (
            ev.planState.subgoals.length +
              ev.planState.hypotheses.length +
              ev.planState.uncertainties.length +
              ev.planState.rejectedPaths.length >
            0
          ) {
            harvestedTurns++;
            totalSubgoals += ev.planState.subgoals.length;
            totalHypotheses += ev.planState.hypotheses.length;
            totalUncertainties += ev.planState.uncertainties.length;
            totalRejectedPaths += ev.planState.rejectedPaths.length;
          }
        }
      } else if (ev.role === "done") {
        finalText = ev.content || finalText;
        break;
      } else if (ev.role === "error") {
        throw new Error(ev.error ?? "loop error");
      }
    }
  } catch (err) {
    errorMessage = (err as Error).message;
  }

  const verdict = errorMessage
    ? { verdict: "fail" as const, note: errorMessage }
    : task.check(finalText);

  return {
    taskId: task.id,
    mode,
    repeat: rep + 1,
    verdict: verdict.verdict,
    checkNote: verdict.note,
    finalAgentMessage: finalText,
    turns: loop.stats.turns.length,
    cacheHitRatio: loop.stats.aggregateCacheHitRatio,
    costUsd: loop.stats.totalCost,
    claudeEquivalentUsd: loop.stats.turns.reduce((s, t) => s + claudeEquivalentCost(t.usage), 0),
    harvestedTurns,
    totalSubgoals,
    totalUncertainties,
    totalHypotheses,
    totalRejectedPaths,
    errorMessage,
  };
}

function runDry(args: CliArgs): HarvestBenchReport {
  const tasks = filterTasks(args.taskFilter);
  const results: HarvestRunResult[] = [];
  for (const task of tasks) {
    // Exercise each checker with a deliberately wrong reply so we know
    // the wiring is live — not a pass on empty.
    const sanity = task.check("Answer: this is not the right answer at all");
    console.log(`[${task.id}] checker exercises ok (sanity verdict=${sanity.verdict})`);
    for (const mode of args.modes) {
      results.push({
        taskId: task.id,
        mode,
        repeat: 1,
        verdict: "inconclusive",
        checkNote: "dry-run (no model call)",
        finalAgentMessage: "[dry-run]",
        turns: 0,
        cacheHitRatio: 0,
        costUsd: 0,
        claudeEquivalentUsd: 0,
        harvestedTurns: 0,
        totalSubgoals: 0,
        totalUncertainties: 0,
        totalHypotheses: 0,
        totalRejectedPaths: 0,
      });
    }
  }
  return { meta: buildMeta(args, tasks.length), results };
}

function filterTasks(filter: string | null): HarvestTask[] {
  if (!filter) return TASKS;
  const t = TASKS.find((x) => x.id === filter);
  if (!t) throw new Error(`unknown task: ${filter}`);
  return [t];
}

function buildMeta(args: CliArgs, taskCount: number): HarvestBenchMeta {
  return {
    date: new Date().toISOString(),
    repeatsPerTask: args.repeats,
    taskCount,
    modesRun: args.modes,
    reasonixVersion: "0.2.2",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.dry) {
    const report = runDry(args);
    writeReport(report, args.outPath);
    return;
  }

  const client = new DeepSeekClient({ timeoutMs: args.timeoutMs });
  const tasks = filterTasks(args.taskFilter);

  if (args.transcriptsDir) mkdirSync(args.transcriptsDir, { recursive: true });

  const results: HarvestRunResult[] = [];
  for (const task of tasks) {
    for (let rep = 0; rep < args.repeats; rep++) {
      for (const mode of args.modes) {
        let stream: WriteStream | null = null;
        if (args.transcriptsDir) {
          const fname = `${task.id}.${mode}.r${rep + 1}.jsonl`;
          stream = openTranscriptFile(join(args.transcriptsDir, fname), {
            version: 1,
            source: `harvest-bench/${mode}`,
            model: modelForMode(mode),
            task: task.id,
            mode,
            repeat: rep + 1,
            startedAt: new Date().toISOString(),
          });
        }
        const started = Date.now();
        let result: HarvestRunResult;
        try {
          result = await runOnce(task, mode, rep, client, stream);
        } finally {
          stream?.end();
        }
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const note = result.checkNote ? `  ${result.checkNote}` : "";
        console.log(
          `[${task.id}/${mode}/r${rep + 1}] verdict=${result.verdict} cache=${(result.cacheHitRatio * 100).toFixed(1)}% cost=$${result.costUsd.toFixed(6)} harvest=${result.harvestedTurns}:${result.totalSubgoals}s/${result.totalUncertainties}u (${elapsed}s)${note}`,
        );
        results.push(result);
      }
    }
  }

  const report: HarvestBenchReport = { meta: buildMeta(args, tasks.length), results };
  writeReport(report, args.outPath);
}

function writeReport(report: HarvestBenchReport, outPath: string | null): void {
  const path =
    outPath ?? `benchmarks/harvest/results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`wrote ${path}`);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { main as runHarvestBench };
