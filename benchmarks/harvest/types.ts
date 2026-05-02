/** Harvest-bench types — single-turn Q/A with deterministic checkers; isolates Pillar 2 the way τ-bench-lite isolates Pillar 1. */

export type HarvestMode =
  /** deepseek-chat, no Reasonix tricks. Floor reference for answer quality on reasoning tasks (V3 at its best). */
  | "baseline"
  /** deepseek-reasoner, no harvest. Isolates "does reasoner help over chat on these problems?" */
  | "reasoner"
  /** deepseek-reasoner + harvest. Isolates "does the extra V3 harvest call add quality / change behavior?" */
  | "reasoner-harvest";

export const ALL_MODES: HarvestMode[] = ["baseline", "reasoner", "reasoner-harvest"];

/** Checker verdict — `inconclusive` reserves room for "right shape, can't verify without running it". */
export type CheckVerdict = "pass" | "fail" | "inconclusive";

export interface HarvestTask {
  id: string;
  /** One-line human description, not shown to the model. */
  description: string;
  /** System prompt. Kept minimal so harvest signal can be attributed to the model, not to prompt engineering. */
  systemPrompt: string;
  /** The single question. */
  prompt: string;
  /** Pure + deterministic — no LLM calls, no file I/O. Verdict + optional one-line note. */
  check: (agentReply: string) => { verdict: CheckVerdict; note?: string };
}

export interface HarvestRunResult {
  taskId: string;
  mode: HarvestMode;
  repeat: number;
  verdict: CheckVerdict;
  checkNote?: string;
  finalAgentMessage: string;
  /** Turns the loop completed (usually 1 for a single-shot Q/A, > 1 if tool-calls happen). */
  turns: number;
  cacheHitRatio: number;
  costUsd: number;
  claudeEquivalentUsd: number;
  /** Harvest-specific — only non-zero on reasoner-harvest mode. */
  harvestedTurns: number;
  totalSubgoals: number;
  totalUncertainties: number;
  totalHypotheses: number;
  totalRejectedPaths: number;
  /** Optional error message if the run crashed (model down, timeout, etc). */
  errorMessage?: string;
}

export interface HarvestBenchMeta {
  date: string;
  repeatsPerTask: number;
  taskCount: number;
  modesRun: HarvestMode[];
  reasonixVersion: string;
}

export interface HarvestBenchReport {
  meta: HarvestBenchMeta;
  results: HarvestRunResult[];
}
