/**
 * τ-bench-lite runner.
 *
 * Usage:
 *   npx tsx benchmarks/tau-bench/runner.ts                         # all tasks, 1 repeat, both modes
 *   npx tsx benchmarks/tau-bench/runner.ts --task t01_address_happy
 *   npx tsx benchmarks/tau-bench/runner.ts --mode reasonix --repeats 3
 *   npx tsx benchmarks/tau-bench/runner.ts --model deepseek-chat --out results.json
 *   npx tsx benchmarks/tau-bench/runner.ts --dry                   # no API calls, smoke-test plumbing
 *
 * Writes a results-<timestamp>.json file (or whatever --out points at).
 * Run `npx tsx benchmarks/tau-bench/report.ts <results.json>` to render
 * report.md.
 */

import { type WriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
  ToolRegistry,
  VERSION,
  claudeEquivalentCost,
  costUsd,
  loadDotenv,
} from "../../src/index.js";
import {
  openTranscriptFile,
  recordFromLoopEvent,
  writeRecord,
} from "../../src/transcript/log.js";
import { BaselineAgent } from "./baseline.js";
import { cloneDb } from "./db.js";
import { TASKS } from "./tasks.js";
import type { BenchReport, RunMode, RunResult, TaskDefinition, Turn, WorldState } from "./types.js";
import { UserSimulator } from "./user-sim.js";

loadDotenv();

interface CliArgs {
  taskFilter: string | null;
  modes: RunMode[];
  repeats: number;
  model: string;
  userSimModel: string;
  outPath: string | null;
  transcriptsDir: string | null;
  dry: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    taskFilter: null,
    modes: ["baseline", "reasonix"],
    repeats: 1,
    model: "deepseek-chat",
    userSimModel: "deepseek-chat",
    outPath: null,
    transcriptsDir: null,
    dry: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") out.taskFilter = argv[++i] ?? null;
    else if (a === "--mode") {
      const v = (argv[++i] ?? "").toLowerCase();
      if (v === "baseline" || v === "reasonix") out.modes = [v];
    } else if (a === "--repeats") out.repeats = Number.parseInt(argv[++i] ?? "1", 10);
    else if (a === "--model") out.model = argv[++i] ?? out.model;
    else if (a === "--user-model") out.userSimModel = argv[++i] ?? out.userSimModel;
    else if (a === "--out") out.outPath = argv[++i] ?? null;
    else if (a === "--transcripts-dir") out.transcriptsDir = argv[++i] ?? null;
    else if (a === "--dry") out.dry = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
  }
  return out;
}

// ---------- per-run drivers ----------

interface RunContext {
  client: DeepSeekClient;
  task: TaskDefinition;
  db: WorldState;
  transcript: Turn[];
  args: CliArgs;
  /** Open transcript stream, or null if --transcripts-dir was not set. */
  transcriptStream: WriteStream | null;
}

/** Convert a task's tool factories into concrete ToolDefinitions bound to this run's db. */
function buildTools(task: TaskDefinition, db: WorldState) {
  return task.tools.map((factory) => factory(db));
}

async function runReasonix(ctx: RunContext): Promise<RunResult> {
  const { client, task, db, args, transcriptStream } = ctx;
  const tools = buildTools(task, db);
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);

  const prefix = new ImmutablePrefix({
    system: task.systemPrompt,
    toolSpecs: registry.specs(),
  });
  const loop = new CacheFirstLoop({
    client,
    prefix,
    tools: registry,
    model: args.model,
    stream: false,
  });
  const prefixHash = prefix.fingerprint;

  return runAgentLoop(ctx, "reasonix", async (userMsg) => {
    const stepTurns: Turn[] = [];
    let finalText = "";
    for await (const ev of loop.step(userMsg)) {
      if (transcriptStream && ev.role !== "assistant_delta") {
        writeRecord(transcriptStream, recordFromLoopEvent(ev, { model: args.model, prefixHash }));
      }
      if (ev.role === "tool") {
        stepTurns.push({ role: "tool", content: ev.content, toolName: ev.toolName });
      } else if (ev.role === "assistant_final") {
        finalText = ev.content;
      } else if (ev.role === "done") {
        finalText = ev.content || finalText;
        break;
      } else if (ev.role === "error") {
        throw new Error(ev.error ?? "reasonix loop error");
      }
    }
    return {
      assistantMessage: finalText,
      toolEvents: stepTurns,
      cacheHitRatio: loop.stats.aggregateCacheHitRatio,
      costUsd: loop.stats.totalCost,
      claudeEquivalentUsd: loop.stats.totalClaudeEquivalent,
      promptTokens: sumTokens(loop.stats.turns.map((t) => t.usage.promptTokens)),
      completionTokens: sumTokens(loop.stats.turns.map((t) => t.usage.completionTokens)),
    };
  });
}

async function runBaseline(ctx: RunContext): Promise<RunResult> {
  const { client, task, db, args, transcriptStream } = ctx;
  const tools = buildTools(task, db);
  const agent = new BaselineAgent({
    client,
    systemPrompt: task.systemPrompt,
    tools,
    model: args.model,
  });

  return runAgentLoop(ctx, "baseline", async (userMsg, transcript) => {
    const res = await agent.userTurn(userMsg, transcript);

    // Emit one assistant_final + its tool records per sub-call, mirroring
    // Reasonix's per-model-call granularity. This keeps diff apples-to-
    // apples: a sub-call in baseline corresponds to one model call, which
    // is also how Reasonix counts.
    if (transcriptStream) {
      for (const sc of res.subCalls) {
        const ts = new Date().toISOString();
        writeRecord(transcriptStream, {
          ts,
          turn: res.turnNo,
          role: "assistant_final",
          content: sc.content,
          usage: {
            prompt_tokens: sc.usage.promptTokens,
            completion_tokens: sc.usage.completionTokens,
            total_tokens: sc.usage.totalTokens,
            prompt_cache_hit_tokens: sc.usage.promptCacheHitTokens,
            prompt_cache_miss_tokens: sc.usage.promptCacheMissTokens,
          },
          cost: costUsd(args.model, sc.usage),
          model: args.model,
          // No prefixHash: baseline's prefix churns by design.
        });
        for (const tc of sc.toolCalls) {
          writeRecord(transcriptStream, {
            ts,
            turn: res.turnNo,
            role: "tool",
            content: tc.result,
            tool: tc.name,
            args: tc.args,
          });
        }
      }
    }

    return {
      assistantMessage: res.assistantMessage,
      toolEvents: res.toolCallsExecuted.map(
        (x) => ({ role: "tool", content: x.result, toolName: x.name }) as Turn,
      ),
      cacheHitRatio: agent.stats.aggregateCacheHitRatio,
      costUsd: agent.stats.totalCost,
      claudeEquivalentUsd: agent.stats.turns.reduce((s, t) => s + claudeEquivalentCost(t.usage), 0),
      promptTokens: sumTokens(agent.stats.turns.map((t) => t.usage.promptTokens)),
      completionTokens: sumTokens(agent.stats.turns.map((t) => t.usage.completionTokens)),
    };
  });
}

interface AgentTurnOutput {
  assistantMessage: string;
  toolEvents: Turn[];
  cacheHitRatio: number;
  costUsd: number;
  claudeEquivalentUsd: number;
  promptTokens: number;
  completionTokens: number;
}

async function runAgentLoop(
  ctx: RunContext,
  mode: RunMode,
  userTurnFn: (userMsg: string, transcript: Turn[]) => Promise<AgentTurnOutput>,
): Promise<RunResult> {
  const { client, task, db, transcript, args, transcriptStream } = ctx;
  const sim = new UserSimulator(client, task.user, {
    model: args.userSimModel,
    temperature: 0.1,
  });

  const maxTurns = task.maxTurns ?? 8;
  let turns = 0;
  let toolCalls = 0;
  let lastAgentMsg = "";
  let truncated = false;
  let lastAgentOutput: AgentTurnOutput | null = null;
  let errorMessage: string | undefined;

  try {
    while (turns < maxTurns) {
      const userMsg = await sim.next(transcript);
      if (userMsg === null) break;
      transcript.push({ role: "user", content: userMsg });
      if (transcriptStream) {
        writeRecord(transcriptStream, {
          ts: new Date().toISOString(),
          turn: turns + 1,
          role: "user",
          content: userMsg,
        });
      }
      if (args.verbose) console.log(`  [${mode}] USER: ${userMsg}`);

      const out = await userTurnFn(userMsg, transcript);
      lastAgentOutput = out;
      for (const te of out.toolEvents) {
        transcript.push(te);
        toolCalls++;
        if (args.verbose) console.log(`  [${mode}] TOOL ${te.toolName}: ${truncate(te.content)}`);
      }
      transcript.push({ role: "agent", content: out.assistantMessage });
      if (args.verbose) console.log(`  [${mode}] AGENT: ${truncate(out.assistantMessage)}`);
      lastAgentMsg = out.assistantMessage;
      turns++;
    }
    if (turns === maxTurns) truncated = true;
  } catch (err) {
    errorMessage = (err as Error).message;
  }

  const pass =
    errorMessage === undefined
      ? safeCheck(task, { db, finalAgentMessage: lastAgentMsg, transcript })
      : false;

  return {
    taskId: task.id,
    mode,
    pass,
    turns,
    toolCalls,
    cacheHitRatio: lastAgentOutput?.cacheHitRatio ?? 0,
    costUsd: lastAgentOutput?.costUsd ?? 0,
    claudeEquivalentUsd: lastAgentOutput?.claudeEquivalentUsd ?? 0,
    promptTokens: lastAgentOutput?.promptTokens ?? 0,
    completionTokens: lastAgentOutput?.completionTokens ?? 0,
    truncated,
    finalAgentMessage: lastAgentMsg,
    errorMessage,
  };
}

function safeCheck(
  task: TaskDefinition,
  ctx: { db: WorldState; finalAgentMessage: string; transcript: Turn[] },
): boolean {
  try {
    return task.check(ctx);
  } catch {
    return false;
  }
}

function sumTokens(arr: number[]): number {
  return arr.reduce((s, n) => s + n, 0);
}

function truncate(s: string, n = 140): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------- dry mode (stubs the LLM) ----------

async function runDry(args: CliArgs): Promise<BenchReport> {
  const tasks = filterTasks(args.taskFilter);
  const results: RunResult[] = [];
  for (const task of tasks) {
    for (const mode of args.modes) {
      const db = cloneDb(task.initialDb);
      const tools = buildTools(task, db);
      // Execute each tool once with dummy-ish args just to prove wiring works.
      for (const t of tools) {
        try {
          await t.fn(stubArgs(t));
        } catch {
          /* dry mode — ignore tool errors */
        }
      }
      results.push({
        taskId: task.id,
        mode,
        pass: true,
        turns: 0,
        toolCalls: tools.length,
        cacheHitRatio: mode === "reasonix" ? 0.9 : 0.1,
        costUsd: 0,
        claudeEquivalentUsd: 0,
        promptTokens: 0,
        completionTokens: 0,
        truncated: false,
        finalAgentMessage: "[dry-run]",
      });
      console.log(`[${task.id}/${mode}] dry-run ok (${tools.length} tools wired)`);
    }
  }
  return {
    meta: buildMeta(args, tasks.length),
    results,
  };
}

function stubArgs(t: {
  name: string;
  parameters?: { properties?: Record<string, unknown> };
}): unknown {
  const props = t.parameters?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(props)) out[k] = "stub";
  return out;
}

// ---------- main ----------

function filterTasks(filter: string | null): TaskDefinition[] {
  if (!filter) return TASKS;
  const t = TASKS.find((x) => x.id === filter);
  if (!t) throw new Error(`unknown task: ${filter}`);
  return [t];
}

function buildMeta(args: CliArgs, taskCount: number): BenchReport["meta"] {
  return {
    date: new Date().toISOString(),
    model: args.model,
    userSimModel: args.userSimModel,
    taskCount,
    repeatsPerTask: args.repeats,
    reasonixVersion: VERSION,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.dry) {
    const report = await runDry(args);
    writeReport(report, args.outPath);
    return;
  }

  const client = new DeepSeekClient();
  const tasks = filterTasks(args.taskFilter);

  if (args.transcriptsDir) {
    mkdirSync(args.transcriptsDir, { recursive: true });
  }

  const results: RunResult[] = [];
  for (const task of tasks) {
    for (let rep = 0; rep < args.repeats; rep++) {
      for (const mode of args.modes) {
        const db = cloneDb(task.initialDb);
        const transcript: Turn[] = [];

        let transcriptStream: WriteStream | null = null;
        if (args.transcriptsDir) {
          const fname = `${task.id}.${mode}.r${rep + 1}.jsonl`;
          transcriptStream = openTranscriptFile(join(args.transcriptsDir, fname), {
            version: 1,
            source: `bench/${mode}`,
            model: args.model,
            task: task.id,
            mode,
            repeat: rep + 1,
            startedAt: new Date().toISOString(),
          });
        }

        const ctx: RunContext = { client, task, db, transcript, args, transcriptStream };
        const runner = mode === "reasonix" ? runReasonix : runBaseline;
        const started = Date.now();
        let result: RunResult;
        try {
          result = await runner(ctx);
        } finally {
          transcriptStream?.end();
        }
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(
          `[${task.id}/${mode}/r${rep + 1}] pass=${result.pass} turns=${result.turns} ` +
            `cache=${(result.cacheHitRatio * 100).toFixed(1)}% cost=$${result.costUsd.toFixed(
              6,
            )} (${elapsed}s)`,
        );
        results.push(result);
      }
    }
  }

  const report: BenchReport = { meta: buildMeta(args, tasks.length), results };
  writeReport(report, args.outPath);
}

function writeReport(report: BenchReport, outPath: string | null): void {
  const path =
    outPath ??
    `benchmarks/tau-bench/results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
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

export { main as runBench };
