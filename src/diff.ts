/**
 * Diff — compare two transcripts and produce a summary + divergence report.
 *
 * Two transcripts are "comparable" when they stem from the same task (or
 * the same user prompt). Alignment is by turn number: assistant_final #N
 * in A pairs with assistant_final #N in B. If one side ran more turns, the
 * extras are labeled "only in A" / "only in B".
 *
 * What we compute:
 *   - Aggregate deltas: turns, tool calls, cache hit, cost, token counts
 *   - First divergence: the lowest turn where A and B's tool calls or
 *     assistant text differ meaningfully
 *   - Prefix-stability story: how many unique prefix hashes each side used
 *
 * Non-goals (deliberately):
 *   - LLM-judge quality comparison
 *   - Per-token delta rendering — not useful at the fidelity we're at
 *   - Embedding similarity — Levenshtein ratio is cheap and good enough
 */

import { type ReplayStats, computeReplayStats } from "./replay.js";
import type { ReadTranscriptResult, TranscriptRecord } from "./transcript.js";

export interface DiffSide {
  label: string;
  meta: ReadTranscriptResult["meta"];
  records: TranscriptRecord[];
  stats: ReplayStats;
}

export interface TurnPair {
  turn: number;
  aAssistant?: TranscriptRecord;
  bAssistant?: TranscriptRecord;
  aTools: TranscriptRecord[];
  bTools: TranscriptRecord[];
  /**
   * Classification of the pair:
   *   "match"      — both sides present, text & tool calls within threshold
   *   "diverge"    — both sides present, but text or tool calls differ
   *   "only_in_a"  — assistant_final in A but not B
   *   "only_in_b"  — assistant_final in B but not A
   */
  kind: "match" | "diverge" | "only_in_a" | "only_in_b";
  /** When kind === "diverge", a short one-liner pointing at what differs. */
  divergenceNote?: string;
}

export interface DiffReport {
  a: DiffSide;
  b: DiffSide;
  pairs: TurnPair[];
  firstDivergenceTurn: number | null;
}

// ---------- navigation helpers (used by the Ink diff TUI) ----------

/**
 * Find the next pair (strictly after `fromIdx`) whose kind is not "match".
 * Returns -1 when no later divergence exists. Used by DiffApp's `n` key.
 */
export function findNextDivergence(pairs: TurnPair[], fromIdx: number): number {
  for (let i = fromIdx + 1; i < pairs.length; i++) {
    if (pairs[i]!.kind !== "match") return i;
  }
  return -1;
}

/**
 * Find the previous pair (strictly before `fromIdx`) whose kind is not
 * "match". Returns -1 when no earlier divergence exists. Used by
 * DiffApp's `N` / `p` key.
 */
export function findPrevDivergence(pairs: TurnPair[], fromIdx: number): number {
  const start = Math.min(fromIdx - 1, pairs.length - 1);
  for (let i = start; i >= 0; i--) {
    if (pairs[i]!.kind !== "match") return i;
  }
  return -1;
}

export function diffTranscripts(
  a: { label: string; parsed: ReadTranscriptResult },
  b: { label: string; parsed: ReadTranscriptResult },
): DiffReport {
  const aSide: DiffSide = {
    label: a.label,
    meta: a.parsed.meta,
    records: a.parsed.records,
    stats: computeReplayStats(a.parsed.records),
  };
  const bSide: DiffSide = {
    label: b.label,
    meta: b.parsed.meta,
    records: b.parsed.records,
    stats: computeReplayStats(b.parsed.records),
  };

  const aByTurn = groupByTurn(a.parsed.records);
  const bByTurn = groupByTurn(b.parsed.records);
  const turns = [...new Set([...aByTurn.keys(), ...bByTurn.keys()])].sort((x, y) => x - y);

  const pairs: TurnPair[] = [];
  let firstDivergenceTurn: number | null = null;
  for (const turn of turns) {
    const aGroup = aByTurn.get(turn) ?? { assistant: undefined, tools: [] };
    const bGroup = bByTurn.get(turn) ?? { assistant: undefined, tools: [] };
    const aAssistant = aGroup.assistant;
    const bAssistant = bGroup.assistant;
    const aTools = aGroup.tools;
    const bTools = bGroup.tools;

    let kind: TurnPair["kind"];
    let divergenceNote: string | undefined;
    if (!aAssistant && bAssistant) kind = "only_in_b";
    else if (aAssistant && !bAssistant) kind = "only_in_a";
    else if (!aAssistant && !bAssistant)
      kind = "diverge"; // tool-only turn (rare)
    else {
      divergenceNote = classifyDivergence(aAssistant!, bAssistant!, aTools, bTools);
      kind = divergenceNote ? "diverge" : "match";
    }

    if (kind !== "match" && firstDivergenceTurn === null) firstDivergenceTurn = turn;
    pairs.push({ turn, aAssistant, bAssistant, aTools, bTools, kind, divergenceNote });
  }

  return { a: aSide, b: bSide, pairs, firstDivergenceTurn };
}

// ---------- divergence classification ----------

/**
 * Return a short reason string if two sides meaningfully disagree, or
 * undefined if they're close enough to call a match.
 *
 * Ranking of divergence signals (cheapest first):
 *   1. Different set of tool names → clearest diff
 *   2. Different tool args for the same tool → second-clearest
 *   3. Text similarity below threshold → fuzziest
 */
function classifyDivergence(
  a: TranscriptRecord,
  b: TranscriptRecord,
  aTools: TranscriptRecord[],
  bTools: TranscriptRecord[],
): string | undefined {
  const aNames = aTools.map((t) => t.tool ?? "").sort();
  const bNames = bTools.map((t) => t.tool ?? "").sort();
  if (aNames.join(",") !== bNames.join(",")) {
    return `tool calls differ: A=[${aNames.join(",") || "—"}] B=[${bNames.join(",") || "—"}]`;
  }
  // Same tool names — did they pass different args?
  for (let i = 0; i < aTools.length; i++) {
    const at = aTools[i]!;
    const bt = bTools[i]!;
    if (at.tool !== bt.tool) continue;
    if ((at.args ?? "") !== (bt.args ?? "")) {
      return `"${at.tool}" args differ`;
    }
  }
  const simRatio = similarity(a.content, b.content);
  if (simRatio < 0.75) return `text similarity ${(simRatio * 100).toFixed(0)}%`;
  return undefined;
}

/**
 * Normalized Levenshtein similarity ratio in [0, 1]. 1 = identical.
 * Early-exits for long strings (> 2000 chars) with a cheap token-overlap
 * estimate to keep diff fast on chatty transcripts.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen > 2000) return tokenOverlap(a, b);
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ---------- grouping ----------

interface TurnGroup {
  assistant?: TranscriptRecord;
  tools: TranscriptRecord[];
}

function groupByTurn(records: TranscriptRecord[]): Map<number, TurnGroup> {
  const out = new Map<number, TurnGroup>();
  for (const rec of records) {
    if (rec.role === "user") continue; // user msg is input to the turn, not its output
    const g = out.get(rec.turn) ?? { tools: [] };
    if (rec.role === "assistant_final") g.assistant = rec;
    else if (rec.role === "tool") g.tools.push(rec);
    out.set(rec.turn, g);
  }
  return out;
}

// ---------- rendering ----------

export interface RenderOptions {
  /** Monochrome output (for file redirection or piping). Defaults to true. */
  monochrome?: boolean;
}

export function renderSummaryTable(report: DiffReport, _opts: RenderOptions = {}): string {
  const a = report.a;
  const b = report.b;
  const lines: string[] = [];
  lines.push("Comparing:");
  lines.push(`  A  ${a.label}`);
  lines.push(`  B  ${b.label}`);
  lines.push("");
  lines.push(row(["", "A", "B", "Δ"], [20, 14, 14, 14]));
  lines.push(
    row(["─".repeat(20), "─".repeat(14), "─".repeat(14), "─".repeat(14)], [20, 14, 14, 14]),
  );
  lines.push(statRow("model calls", a.stats.turns, b.stats.turns));
  lines.push(statRow("user turns", a.stats.userTurns, b.stats.userTurns));
  lines.push(statRow("tool calls", a.stats.toolCalls, b.stats.toolCalls));
  lines.push(
    row(
      [
        "cache hit",
        `${pct(a.stats.cacheHitRatio)}`,
        `${pct(b.stats.cacheHitRatio)}`,
        signPct(b.stats.cacheHitRatio - a.stats.cacheHitRatio),
      ],
      [20, 14, 14, 14],
    ),
  );
  lines.push(
    row(
      [
        "cost (USD)",
        `$${a.stats.totalCostUsd.toFixed(6)}`,
        `$${b.stats.totalCostUsd.toFixed(6)}`,
        costDelta(a.stats.totalCostUsd, b.stats.totalCostUsd),
      ],
      [20, 14, 14, 14],
    ),
  );
  lines.push(statRow("prefix hashes", a.stats.prefixHashes.length, b.stats.prefixHashes.length));
  lines.push("");

  // Prefix stability story — the headline finding when comparing bench modes.
  const aPrefixStable = a.stats.prefixHashes.length <= 1;
  const bPrefixStable = b.stats.prefixHashes.length <= 1;
  if (aPrefixStable !== bPrefixStable) {
    const stable = aPrefixStable ? "A" : "B";
    const churn = aPrefixStable ? "B" : "A";
    const churnCount = aPrefixStable ? b.stats.prefixHashes.length : a.stats.prefixHashes.length;
    lines.push(
      `prefix stability: ${stable} stayed byte-stable across ${Math.max(
        a.stats.turns,
        b.stats.turns,
      )} turns; ${churn} churned ${churnCount} distinct prefixes.`,
    );
    lines.push("");
  } else if (a.stats.prefixHashes[0] && a.stats.prefixHashes[0] === b.stats.prefixHashes[0]) {
    lines.push(
      `prefix: A and B share the same prefix hash (${a.stats.prefixHashes[0].slice(0, 12)}…) — cache delta is attributable to log stability, not prompt change.`,
    );
    lines.push("");
  }

  if (report.firstDivergenceTurn !== null) {
    const p = report.pairs.find((p) => p.turn === report.firstDivergenceTurn);
    lines.push(
      `first divergence: turn ${report.firstDivergenceTurn} — ${p?.divergenceNote ?? "?"}`,
    );
    if (p?.aAssistant) lines.push(`  A → ${truncate(p.aAssistant.content, 100)}`);
    if (p?.bAssistant) lines.push(`  B → ${truncate(p.bAssistant.content, 100)}`);
  } else {
    lines.push("no material divergence detected (texts within similarity threshold).");
  }

  return lines.join("\n");
}

export function renderMarkdown(report: DiffReport): string {
  const a = report.a;
  const b = report.b;
  const out: string[] = [];
  out.push(`# Transcript diff: ${a.label} vs ${b.label}`);
  out.push("");
  if (a.meta || b.meta) {
    out.push("## Meta");
    out.push("");
    out.push(`| | ${a.label} | ${b.label} |`);
    out.push("|---|---|---|");
    out.push(`| source | ${a.meta?.source ?? "—"} | ${b.meta?.source ?? "—"} |`);
    out.push(`| model | ${a.meta?.model ?? "—"} | ${b.meta?.model ?? "—"} |`);
    out.push(`| task | ${a.meta?.task ?? "—"} | ${b.meta?.task ?? "—"} |`);
    out.push(`| startedAt | ${a.meta?.startedAt ?? "—"} | ${b.meta?.startedAt ?? "—"} |`);
    out.push("");
  }

  out.push("## Summary");
  out.push("");
  out.push(`| metric | ${a.label} | ${b.label} | delta |`);
  out.push("|---|---:|---:|---:|");
  out.push(
    `| model calls | ${a.stats.turns} | ${b.stats.turns} | ${signed(b.stats.turns - a.stats.turns)} |`,
  );
  out.push(
    `| user turns | ${a.stats.userTurns} | ${b.stats.userTurns} | ${signed(b.stats.userTurns - a.stats.userTurns)} |`,
  );
  out.push(
    `| tool calls | ${a.stats.toolCalls} | ${b.stats.toolCalls} | ${signed(b.stats.toolCalls - a.stats.toolCalls)} |`,
  );
  out.push(
    `| cache hit | ${pct(a.stats.cacheHitRatio)} | ${pct(b.stats.cacheHitRatio)} | **${signPct(b.stats.cacheHitRatio - a.stats.cacheHitRatio)}** |`,
  );
  out.push(
    `| cost (USD) | $${a.stats.totalCostUsd.toFixed(6)} | $${b.stats.totalCostUsd.toFixed(6)} | ${costDelta(a.stats.totalCostUsd, b.stats.totalCostUsd)} |`,
  );
  out.push(
    `| prefix hashes | ${a.stats.prefixHashes.length} | ${b.stats.prefixHashes.length} | — |`,
  );
  out.push("");

  out.push("## Turn-by-turn");
  out.push("");
  out.push(`| turn | kind | ${a.label} tool calls | ${b.label} tool calls | note |`);
  out.push("|---:|:---:|---|---|---|");
  for (const p of report.pairs) {
    const aTools =
      p.aTools
        .map((t) => t.tool)
        .filter(Boolean)
        .join(", ") || "—";
    const bTools =
      p.bTools
        .map((t) => t.tool)
        .filter(Boolean)
        .join(", ") || "—";
    out.push(`| ${p.turn} | ${p.kind} | ${aTools} | ${bTools} | ${p.divergenceNote ?? ""} |`);
  }
  out.push("");

  if (report.firstDivergenceTurn !== null) {
    const p = report.pairs.find((x) => x.turn === report.firstDivergenceTurn);
    out.push(`## First divergence (turn ${report.firstDivergenceTurn})`);
    out.push("");
    out.push(p?.divergenceNote ?? "");
    out.push("");
    if (p?.aAssistant) {
      out.push(`**${a.label}:**`);
      out.push("");
      out.push("```");
      out.push(p.aAssistant.content);
      out.push("```");
      out.push("");
    }
    if (p?.bAssistant) {
      out.push(`**${b.label}:**`);
      out.push("");
      out.push("```");
      out.push(p.bAssistant.content);
      out.push("```");
      out.push("");
    }
  }
  return out.join("\n");
}

// ---------- formatting helpers ----------

function row(cols: string[], widths: number[]): string {
  return cols.map((c, i) => padRight(c, widths[i] ?? c.length)).join(" ");
}

function statRow(label: string, av: number, bv: number): string {
  return row([label, `${av}`, `${bv}`, signed(bv - av)], [20, 14, 14, 14]);
}

function padRight(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function signed(n: number): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : ""}${n}`;
}

function signPct(diff: number): string {
  if (diff === 0) return "0pp";
  const s = (diff * 100).toFixed(1);
  return `${diff > 0 ? "+" : ""}${s}pp`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function costDelta(a: number, b: number): string {
  if (a === 0 && b === 0) return "—";
  if (a === 0) return "new";
  const pctChange = ((b - a) / a) * 100;
  return `${pctChange > 0 ? "+" : ""}${pctChange.toFixed(1)}%`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
