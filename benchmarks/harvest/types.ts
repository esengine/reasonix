/**
 * Types for the harvest eval harness.
 *
 * Scope: this is deliberately NOT τ-bench-lite. These tasks:
 *   - are single-turn Q/A (no user simulator, no DB)
 *   - target reasoning-heavy problems (math, logic, planning)
 *   - use deterministic checkers (regex extraction + set/value compare),
 *     never an LLM judge
 *
 * The point is to measure Pillar 2 (harvest) the same way τ-bench-lite
 * measures Pillar 1 (cache-first): isolate one variable, produce numbers
 * anyone can reproduce.
 */

export type HarvestMode =
  /** deepseek-chat, no Reasonix tricks. Floor reference for answer quality on reasoning tasks (V3 at its best). */
  | "baseline"
  /** deepseek-reasoner, no harvest. Isolates "does reasoner help over chat on these problems?" */
  | "reasoner"
  /** deepseek-reasoner + harvest. Isolates "does the extra V3 harvest call add quality / change behavior?" */
  | "reasoner-harvest";

export const ALL_MODES: HarvestMode[] = ["baseline", "reasoner", "reasoner-harvest"];

/**
 * Checker verdict. We don't use boolean directly because "maybe" is real
 * — e.g. "answer in the right shape but can't verify without running the
 * program". For v0.3 we only use {pass, fail}, but the shape leaves room.
 */
export type CheckVerdict = "pass" | "fail" | "inconclusive";

export interface HarvestTask {
  id: string;
  /** One-line human description, not shown to the model. */
  description: string;
  /** System prompt. Kept minimal so harvest signal can be attributed to the model, not to prompt engineering. */
  systemPrompt: string;
  /** The single question. */
  prompt: string;
  /**
   * Check the agent's final reply. Returns pass/fail/inconclusive plus an
   * optional one-line explanation the report can surface.
   *
   * IMPORTANT: must be pure and deterministic. No LLM calls, no file I/O.
   */
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
