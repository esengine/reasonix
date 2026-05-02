/** Render τ-bench results.json → report.md. CLI usage in benchmarks/README.md. */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { BenchReport, RunMode, RunResult } from "./types.js";

interface CliArgs {
  input: string;
  outPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { input: "", outPath: "benchmarks/tau-bench/report.md" };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.outPath = argv[++i] ?? out.outPath;
    else if (a && !a.startsWith("--")) positional.push(a);
  }
  out.input = positional[0] ?? "";
  if (!out.input) {
    throw new Error(
      "usage: npx tsx benchmarks/tau-bench/report.ts <results.json> [--out report.md]",
    );
  }
  return out;
}

interface Agg {
  runs: number;
  passes: number;
  avgCache: number;
  avgCost: number;
  avgClaudeCost: number;
  avgTurns: number;
  avgToolCalls: number;
}

function aggregate(results: RunResult[]): Agg {
  if (results.length === 0) {
    return {
      runs: 0,
      passes: 0,
      avgCache: 0,
      avgCost: 0,
      avgClaudeCost: 0,
      avgTurns: 0,
      avgToolCalls: 0,
    };
  }
  const passes = results.filter((r) => r.pass).length;
  const mean = (fn: (r: RunResult) => number) =>
    results.reduce((s, r) => s + fn(r), 0) / results.length;
  return {
    runs: results.length,
    passes,
    avgCache: mean((r) => r.cacheHitRatio),
    avgCost: mean((r) => r.costUsd),
    avgClaudeCost: mean((r) => r.claudeEquivalentUsd),
    avgTurns: mean((r) => r.turns),
    avgToolCalls: mean((r) => r.toolCalls),
  };
}

function renderSummary(report: BenchReport): string {
  const byMode: Record<RunMode, RunResult[]> = { baseline: [], reasonix: [] };
  for (const r of report.results) byMode[r.mode].push(r);
  const b = aggregate(byMode.baseline);
  const rx = aggregate(byMode.reasonix);

  const costRatio = b.avgCost > 0 ? rx.avgCost / b.avgCost : 0;
  const claudeSavings = b.avgClaudeCost > 0 ? (1 - rx.avgCost / b.avgClaudeCost) * 100 : 0;

  return `
## Summary

| metric | baseline | reasonix | delta |
|---|---:|---:|---:|
| runs | ${b.runs} | ${rx.runs} | — |
| pass rate | ${pct(b.passes, b.runs)} | ${pct(rx.passes, rx.runs)} | ${signPct(rx.passes, rx.runs, b.passes, b.runs)} |
| cache hit | ${pct1(b.avgCache)} | ${pct1(rx.avgCache)} | **${signPctAbs(rx.avgCache - b.avgCache)}** |
| mean cost / task | $${fmt(b.avgCost, 6)} | $${fmt(rx.avgCost, 6)} | ${costRatio > 0 ? `×${fmt(costRatio, 2)}` : "—"} |
| mean turns | ${fmt(b.avgTurns, 1)} | ${fmt(rx.avgTurns, 1)} | — |
| mean tool calls | ${fmt(b.avgToolCalls, 1)} | ${fmt(rx.avgToolCalls, 1)} | — |

**Reasonix vs Claude Sonnet 4.6 (estimated, same token counts):**
Claude would cost ~$${fmt(rx.avgClaudeCost, 6)} / task, so Reasonix saves ~${fmt(
    claudeSavings,
    1,
  )}%.
(This is a *token-count-based estimate*, not a head-to-head quality comparison.)
`.trim();
}

function renderPerTask(report: BenchReport): string {
  const rowsByTask = new Map<string, RunResult[]>();
  for (const r of report.results) {
    const list = rowsByTask.get(r.taskId) ?? [];
    list.push(r);
    rowsByTask.set(r.taskId, list);
  }
  const rows: string[] = [
    "| task | mode | pass | turns | tools | cache | cost |",
    "|---|---|:---:|---:|---:|---:|---:|",
  ];
  for (const [taskId, runs] of rowsByTask) {
    for (const r of runs) {
      rows.push(
        `| ${taskId} | ${r.mode} | ${r.pass ? "✅" : "❌"} | ${r.turns} | ${r.toolCalls} | ${pct1(
          r.cacheHitRatio,
        )} | $${fmt(r.costUsd, 6)} |${r.errorMessage ? ` err: ${truncate(r.errorMessage, 40)}` : ""}`,
      );
    }
  }
  return `## Per-task breakdown\n\n${rows.join("\n")}`;
}

function renderHeader(report: BenchReport): string {
  const m = report.meta;
  return `# Reasonix tool-use eval (τ-bench-lite)

**Date:** ${m.date}
**Agent model:** \`${m.model}\`
**User-simulator model:** \`${m.userSimModel}\`
**Tasks:** ${m.taskCount}, repeats × ${m.repeatsPerTask}
**Reasonix version:** ${m.reasonixVersion}
`;
}

function renderCaveats(): string {
  return `## Scope & caveats

This is **τ-bench-lite**, not a port of Sierra's upstream τ-bench. Specifically:

- Tasks are hand-authored in the retail domain; the schema mirrors τ-bench
  (stateful tools, LLM user-sim, DB-end-state success predicates), so upstream
  tasks can later be dropped in without harness changes.
- Every pass/fail judgment is a deterministic DB predicate — no LLM judge.
  Refusal tasks pass iff the DB is unchanged.
- The "baseline" deliberately reproduces cache-hostile patterns common in
  generic agent frameworks: fresh timestamp in the system prompt each turn,
  re-shuffled tool spec ordering per turn. It is **not** a benchmark of
  LangChain specifically.
- Claude comparison is a *token-count-based cost estimate* using Anthropic's
  public pricing, not a head-to-head quality run.
- User simulator is DeepSeek V3 at T=0.1. Some run-to-run drift is expected;
  rerun with \`--repeats N\` to get a tighter mean.

## Reproducing

1. \`export DEEPSEEK_API_KEY=sk-...\`
2. \`npm install\`
3. \`npx tsx benchmarks/tau-bench/runner.ts --repeats 3\`
4. \`npx tsx benchmarks/tau-bench/report.ts benchmarks/tau-bench/results-*.json\`
`;
}

export function renderReport(report: BenchReport): string {
  return [
    renderHeader(report),
    renderSummary(report),
    "",
    renderPerTask(report),
    "",
    renderCaveats(),
  ].join("\n");
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "—";
  return `${((num / denom) * 100).toFixed(0)}%`;
}

function signPct(num1: number, denom1: number, num2: number, denom2: number): string {
  if (denom1 === 0 || denom2 === 0) return "—";
  const d = num1 / denom1 - num2 / denom2;
  const s = (d * 100).toFixed(0);
  return `${d >= 0 ? "+" : ""}${s}pp`;
}

function signPctAbs(diff: number): string {
  const s = (diff * 100).toFixed(1);
  return `${diff >= 0 ? "+" : ""}${s}pp`;
}

function pct1(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmt(x: number, digits: number): string {
  return x.toFixed(digits);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = readFileSync(args.input, "utf8");
  const report = JSON.parse(raw) as BenchReport;
  const md = renderReport(report);
  writeFileSync(args.outPath, md, "utf8");
  console.log(`wrote ${args.outPath} (${report.results.length} runs)`);
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
