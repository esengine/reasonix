export type CardId = string;

export interface CardBase {
  readonly id: CardId;
  readonly ts: number;
}

export interface UserCard extends CardBase {
  readonly kind: "user";
  readonly text: string;
}

export interface ReasoningCard extends CardBase {
  readonly kind: "reasoning";
  text: string;
  paragraphs: number;
  tokens: number;
  streaming: boolean;
  aborted?: boolean;
  /** Snapshotted at reasoning.start so escalation mid-turn doesn't relabel completed reasoning. */
  model?: string;
  /** Stamped at reasoning.end. Drives the duration badge on the settled header. */
  endedAt?: number;
}

export interface StreamingCard extends CardBase {
  readonly kind: "streaming";
  text: string;
  done: boolean;
  aborted?: boolean;
  /** Snapshotted at streaming.start so escalation mid-turn doesn't relabel completed output. */
  model?: string;
  /** Stamped at streaming.end. */
  endedAt?: number;
}

export interface ToolCard extends CardBase {
  readonly kind: "tool";
  readonly name: string;
  readonly args: unknown;
  output: string;
  done: boolean;
  exitCode?: number;
  elapsedMs: number;
  retry?: { attempt: number; max: number };
  aborted?: boolean;
}

export interface TaskStep {
  readonly id: string;
  readonly title: string;
  status: "queued" | "running" | "done" | "failed";
  elapsedMs?: number;
  toolName?: string;
  detail?: string;
}

export interface TaskCard extends CardBase {
  readonly kind: "task";
  readonly title: string;
  readonly index: number;
  readonly total: number;
  steps: TaskStep[];
  status: "running" | "done" | "failed";
  elapsedMs: number;
}

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  status: "queued" | "running" | "done" | "failed" | "blocked" | "skipped";
}

export interface PlanCard extends CardBase {
  readonly kind: "plan";
  readonly title: string;
  steps: PlanStep[];
  variant: "active" | "resumed" | "replay";
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: ReadonlyArray<{ kind: "ctx" | "add" | "del" | "fold"; text: string }>;
}

export interface DiffCard extends CardBase {
  readonly kind: "diff";
  readonly file: string;
  readonly hunks: DiffHunk[];
  readonly stats: { add: number; del: number };
}

export interface ErrorCard extends CardBase {
  readonly kind: "error";
  readonly title: string;
  readonly message: string;
  readonly stack?: string;
  retries?: number;
}

export interface WarnCard extends CardBase {
  readonly kind: "warn";
  readonly title: string;
  readonly message: string;
  /** Optional right-aligned meta (e.g. "notion · 8.4s elapsed"). */
  readonly detail?: string;
}

export interface UsageCard extends CardBase {
  readonly kind: "usage";
  readonly turn: number;
  readonly tokens: { prompt: number; reason: number; output: number; promptCap: number };
  readonly cacheHit: number;
  readonly cost: number;
  readonly sessionCost: number;
  readonly balance?: number;
  /** Wall-clock for the turn — surfaced as `· 1.2s` in the header meta. */
  readonly elapsedMs?: number;
  /** Auto-emitted per-turn cards render as a single dim row; /cost emits the full breakdown. */
  readonly compact?: boolean;
}

export interface MemoryEntry {
  readonly category: "user" | "feedback" | "project" | "reference";
  readonly summary: string;
}

export interface MemoryCard extends CardBase {
  readonly kind: "memory";
  readonly entries: ReadonlyArray<MemoryEntry>;
  readonly tokens: number;
}

export interface SubAgentCard extends CardBase {
  readonly kind: "subagent";
  readonly name: string;
  readonly task: string;
  readonly depth: number;
  status: "running" | "done" | "failed";
  children: Card[];
  /** Tool names the subagent has access to — surfaced as a "Tools  ..." row in the header block. */
  tools?: ReadonlyArray<string>;
}

export interface SearchHit {
  readonly file: string;
  readonly line: number;
  readonly preview: string;
  readonly matchStart: number;
  readonly matchEnd: number;
}

export interface SearchCard extends CardBase {
  readonly kind: "search";
  readonly query: string;
  readonly hits: ReadonlyArray<SearchHit>;
  readonly elapsedMs: number;
}

export interface ApprovalCard extends CardBase {
  readonly kind: "approval";
  readonly variant: "shell" | "edit" | "plan" | "workspace" | "choice" | "deny";
  readonly title: string;
  readonly options: ReadonlyArray<{ key: string; label: string; hint: string }>;
  readonly payload: unknown;
  resolved?: { choice: string };
}

export type LiveKind =
  | "thinking"
  | "undo"
  | "ctxPressure"
  | "aborted"
  | "retry"
  | "checkpoint"
  | "stepProgress"
  | "mcpEvent"
  | "sessionOp";

export interface LiveCard extends CardBase {
  readonly kind: "live";
  readonly variant: LiveKind;
  readonly text: string;
  readonly tone: "ok" | "warn" | "err" | "info" | "brand" | "accent" | "ghost";
  readonly meta?: string;
}

export interface BranchCard extends CardBase {
  readonly kind: "branch";
  completed: number;
  total: number;
  latestIndex: number;
  latestTemperature: number;
  latestUncertainties: number;
  done: boolean;
  aborted?: boolean;
}

export interface CtxCard extends CardBase {
  readonly kind: "ctx";
  readonly text: string;
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly logTokens: number;
  readonly inputTokens: number;
  readonly ctxMax: number;
  readonly toolsCount: number;
  readonly logMessages: number;
  readonly topTools: ReadonlyArray<{ name: string; tokens: number; turn: number }>;
}

export type Card =
  | UserCard
  | ReasoningCard
  | StreamingCard
  | ToolCard
  | TaskCard
  | PlanCard
  | DiffCard
  | ErrorCard
  | WarnCard
  | UsageCard
  | MemoryCard
  | SubAgentCard
  | SearchCard
  | ApprovalCard
  | LiveCard
  | CtxCard
  | BranchCard
  | DoctorCard;

export interface DoctorCheckEntry {
  readonly label: string;
  readonly level: "ok" | "warn" | "fail";
  readonly detail: string;
}

export interface DoctorCard extends CardBase {
  readonly kind: "doctor";
  readonly checks: ReadonlyArray<DoctorCheckEntry>;
}

export type CardKind = Card["kind"];

export function isCardKind<K extends CardKind>(
  card: Card,
  kind: K,
): card is Extract<Card, { kind: K }> {
  return card.kind === kind;
}
