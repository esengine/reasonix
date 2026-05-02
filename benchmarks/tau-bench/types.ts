/** Tool-use eval types — shape-compatible with Sierra τ-bench so a later port can drop real tasks in. */

import type { ToolDefinition } from "../../src/index.js";

/** Mutable world state — deep-cloned per run so mutations don't leak across runs. */
export interface WorldState {
  [table: string]: Record<string, Record<string, unknown>>;
}

export interface UserPersona {
  /** Who the user is roleplaying (e.g. "frustrated customer"). */
  style: string;
  /** The concrete goal. The user pursues this until it's met or clearly refused. */
  goal: string;
  /** Facts the simulator may reveal when asked — kept tight; user shouldn't volunteer everything. */
  knowns: Record<string, string>;
}

/** Tool factory — fresh closure over per-run WorldState; bare ToolDefinitions would share DBs. */
export type ToolFactory = (db: WorldState) => ToolDefinition;

export interface TaskDefinition {
  id: string;
  /** One-line human description. Not shown to the model. */
  description: string;
  /** System prompt given to the agent. Kept small so cache-hit ratio is comparable. */
  systemPrompt: string;
  /** Tools built fresh per run against the run's DB snapshot. */
  tools: ToolFactory[];
  /** Initial DB snapshot. Deep-cloned per run. */
  initialDb: WorldState;
  /** Persona + goal for the LLM user simulator. */
  user: UserPersona;
  /** Max turns of (user → agent) before we give up and mark fail. */
  maxTurns?: number;
  /** Success predicate over end-state DB (+ final agent utterance). */
  check: (ctx: { db: WorldState; finalAgentMessage: string; transcript: Turn[] }) => boolean;
}

export interface Turn {
  role: "user" | "agent" | "tool";
  content: string;
  toolName?: string;
}

export type RunMode = "baseline" | "reasonix";

export interface RunResult {
  taskId: string;
  mode: RunMode;
  pass: boolean;
  turns: number;
  toolCalls: number;
  cacheHitRatio: number;
  costUsd: number;
  claudeEquivalentUsd: number;
  promptTokens: number;
  completionTokens: number;
  /** True if the run aborted before the user sim decided to stop. */
  truncated: boolean;
  finalAgentMessage: string;
  errorMessage?: string;
}

export interface BenchMeta {
  date: string;
  model: string;
  userSimModel: string;
  taskCount: number;
  repeatsPerTask: number;
  /** Reasonix version written into the report for reproducibility. */
  reasonixVersion: string;
}

export interface BenchReport {
  meta: BenchMeta;
  results: RunResult[];
}
