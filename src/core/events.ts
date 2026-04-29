/**
 * Event-log kernel — types only.
 *
 * Single source of truth for session state: every transition appends
 * a typed Event; every view is a pure reducer projection.
 * Reducers MUST NOT perform I/O. The bodies live in core/projections/*.
 */

import type { PlanStep, PlanStepRisk, StepCompletion } from "../tools/plan-types.js";
import type { ChatMessage, RawUsage, ToolCall } from "../types.js";

export type EventId = number;

export interface EventBase {
  id: EventId;
  ts: string;
  turn: number;
}

export interface UserMessageEvent extends EventBase {
  type: "user.message";
  text: string;
  attachments?: ReadonlyArray<{ kind: "file" | "url"; ref: string }>;
}

export interface SlashInvokedEvent extends EventBase {
  type: "slash.invoked";
  name: string;
  args: string;
}

export interface ModelTurnStartedEvent extends EventBase {
  type: "model.turn.started";
  model: string;
  reasoningEffort: "high" | "max";
  prefixHash: string;
}

export interface ModelDeltaEvent extends EventBase {
  type: "model.delta";
  channel: "content" | "reasoning" | "tool_args";
  text: string;
  toolCallIndex?: number;
}

export interface ModelFinalEvent extends EventBase {
  type: "model.final";
  content: string;
  reasoningContent?: string;
  toolCalls: ReadonlyArray<ToolCall>;
  usage: RawUsage;
  costUsd: number;
  /** True iff this was the no-tools wrap-up after budget / abort / context guard. */
  forcedSummary?: boolean;
}

export interface ToolIntentEvent extends EventBase {
  type: "tool.intent";
  callId: string;
  name: string;
  /** JSON string exactly as the model emitted it. */
  args: string;
}

export interface ToolDispatchedEvent extends EventBase {
  type: "tool.dispatched";
  callId: string;
}

export interface ToolDeniedEvent extends EventBase {
  type: "tool.denied";
  callId: string;
  reason: "permission" | "budget" | "policy" | "hook";
}

export interface ToolResultEvent extends EventBase {
  type: "tool.result";
  callId: string;
  ok: boolean;
  output: string;
  truncated?: boolean;
  durationMs: number;
}

export interface FileTouchedEvent extends EventBase {
  type: "effect.file.touched";
  path: string;
  mode: "create" | "edit" | "delete";
  bytes: number;
}

export interface MemoryWrittenEvent extends EventBase {
  type: "effect.memory.written";
  scope: "user" | "project" | "hash";
  key: string;
}

export interface PlanSubmittedEvent extends EventBase {
  type: "plan.submitted";
  steps: ReadonlyArray<PlanStep>;
  body: string;
}

export interface PlanStepCompletedEvent extends EventBase {
  type: "plan.step.completed";
  stepId: string;
  title?: string;
  notes?: string;
  /** Raw payload echoed for replay; mirrors what the tool returned. */
  completion: StepCompletion;
}

export interface CheckpointCreatedEvent extends EventBase {
  type: "checkpoint.created";
  checkpointId: string;
  name: string;
  source: "manual" | "auto-session-start" | "auto-pre-restore";
  fileCount: number;
  bytes: number;
}

export interface CheckpointRestoredEvent extends EventBase {
  type: "checkpoint.restored";
  checkpointId: string;
  restored: number;
  removed: number;
  skipped: number;
}

export interface HookFiredEvent extends EventBase {
  type: "hook.fired";
  hookName: string;
  phase: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
  outcome: "ok" | "blocked" | "modified" | "error";
}

export interface BudgetWarningEvent extends EventBase {
  type: "policy.budget.warning";
  spentUsd: number;
  capUsd: number;
}

export interface BudgetBlockedEvent extends EventBase {
  type: "policy.budget.blocked";
  spentUsd: number;
  capUsd: number;
}

export interface EscalatedEvent extends EventBase {
  type: "policy.escalated";
  fromModel: string;
  toModel: string;
  reason: "self-report" | "failure-threshold" | "user-request";
  /** Optional one-liner rationale from the `<<<NEEDS_PRO: ...>>>` form. */
  rationale?: string;
}

export interface SessionOpenedEvent extends EventBase {
  type: "session.opened";
  name: string;
  resumedFromTurn: number;
}

export interface SessionCompactedEvent extends EventBase {
  type: "session.compacted";
  beforeMessages: number;
  afterMessages: number;
  reason: "user" | "auto-context-pressure";
  /** Post-compact message list. Only event that REPLACES (not appends) the conversation view. */
  replacementMessages: ReadonlyArray<ChatMessage>;
}

export interface CapabilityRegisteredEvent extends EventBase {
  type: "capability.registered";
  name: string;
  permission: "ask" | "allow" | "deny";
}

export interface CapabilityRemovedEvent extends EventBase {
  type: "capability.removed";
  name: string;
}

/** Transient — never persisted, drops on next primary event. */
export interface StatusEvent extends EventBase {
  type: "status";
  text: string;
}

export interface ErrorEvent extends EventBase {
  type: "error";
  message: string;
  recoverable: boolean;
}

export type Event =
  | UserMessageEvent
  | SlashInvokedEvent
  | ModelTurnStartedEvent
  | ModelDeltaEvent
  | ModelFinalEvent
  | ToolIntentEvent
  | ToolDispatchedEvent
  | ToolDeniedEvent
  | ToolResultEvent
  | FileTouchedEvent
  | MemoryWrittenEvent
  | PlanSubmittedEvent
  | PlanStepCompletedEvent
  | CheckpointCreatedEvent
  | CheckpointRestoredEvent
  | HookFiredEvent
  | BudgetWarningEvent
  | BudgetBlockedEvent
  | EscalatedEvent
  | SessionOpenedEvent
  | SessionCompactedEvent
  | CapabilityRegisteredEvent
  | CapabilityRemovedEvent
  | StatusEvent
  | ErrorEvent;

export type EventOf<T extends Event["type"]> = Extract<Event, { type: T }>;

/** Pure projection: folds an event slice into a view. No I/O. */
export type Reducer<TView> = (view: TView, ev: Event) => TView;

export interface ConversationView {
  messages: ReadonlyArray<ChatMessage>;
  pendingToolCalls: ReadonlyArray<{ callId: string; name: string }>;
}

export interface BudgetView {
  spentUsd: number;
  capUsd: number | null;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  warned: boolean;
  blocked: boolean;
}

export interface PlanStepView {
  id: string;
  title: string;
  action: string;
  risk?: PlanStepRisk;
  completed: boolean;
  notes?: string;
}

export interface PlanView {
  steps: ReadonlyArray<PlanStepView>;
  body: string | null;
  submittedTurn: number | null;
}

export interface WorkspaceView {
  filesTouched: ReadonlyMap<string, "create" | "edit" | "delete">;
  lastCheckpointId: string | null;
}

export interface CapabilityView {
  tools: ReadonlyArray<{ name: string; permission: "ask" | "allow" | "deny" }>;
}

export interface StatusView {
  current: string | null;
}

export interface SessionMetaView {
  name: string | null;
  openedAt: string | null;
  resumedFromTurn: number | null;
  currentTurn: number;
  lastError: string | null;
}

export interface ProjectionSet {
  conversation: ConversationView;
  budget: BudgetView;
  plan: PlanView;
  workspace: WorkspaceView;
  capabilities: CapabilityView;
  status: StatusView;
  session: SessionMetaView;
}
