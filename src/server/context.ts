/** Callbacks (not refs) so endpoints read live loop state per request, not a frozen closure. */

import type { McpServerSummary } from "../cli/ui/slash/types.js";
import type { EditMode } from "../config.js";
import type { CacheFirstLoop } from "../loop.js";
import type { ToolRegistry } from "../tools.js";
import type { JobRegistry } from "../tools/jobs.js";

export interface DashboardContext {
  /** Caller resolves via `defaultConfigPath()`; module deliberately avoids `homedir()` so tests can redirect. */
  configPath: string;
  usageLogPath: string;
  /** Override the sessions dir (events.jsonl readers); production reads `~/.reasonix/sessions`. */
  sessionsDir?: string;
  mode: "standalone" | "attached";

  loop?: CacheFirstLoop;
  tools?: ToolRegistry;
  mcpServers?: McpServerSummary[];
  jobs?: JobRegistry;

  /** Current code-mode root, if any. Drives the project-scoped allowlist. */
  getCurrentCwd?: () => string | undefined;
  /** Current edit gate. */
  getEditMode?: () => EditMode | undefined;
  /** Plan-mode toggle state. */
  getPlanMode?: () => boolean;
  /** Current pending-edit-block count. */
  getPendingEditCount?: () => number;
  /** Latest published version (background-fetched by App). Null = pending/offline. */
  getLatestVersion?: () => string | null;
  getSessionName?: () => string | null;

  setEditMode?: (mode: EditMode) => EditMode;
  setPlanMode?: (on: boolean) => void;
  /** Flips live loop model + escalation; persisted config alone wouldn't affect the running session. */
  applyPresetLive?: (name: string) => void;
  /** Side-channel to live loop — settings POST persists, this flips the running session. */
  applyEffortLive?: (effort: "high" | "max") => void;
  /** Endpoints don't write the audit log themselves so tests can swap the implementation. */
  audit?: (entry: AuditEntry) => void;

  getMessages?: () => DashboardMessage[];
  /** Events are JSON-serializable subsets — raw `LoopEvent` carries React-only state. */
  subscribeEvents?: (handler: (event: DashboardEvent) => void) => () => void;
  /** Routes through the TUI's `handleSubmit` so slashes, `!cmd`, `@path`, plan-mode gating all match. */
  submitPrompt?: (text: string) => SubmitResult;
  abortTurn?: () => void;
  isBusy?: () => boolean;
  getStats?: () => DashboardStats | null;

  /** Snapshot of any modal currently up (for SSE clients that connect mid-modal). */
  getActiveModal?: () => ActiveModal | null;
  resolveShellConfirm?: (choice: "run_once" | "always_allow" | "deny") => void;
  resolveChoiceConfirm?: (choice: ChoiceResolution) => void;
  resolvePlanConfirm?: (choice: "approve" | "refine" | "cancel", text?: string) => void;
  resolveEditReview?: (choice: "apply" | "reject" | "apply-rest-of-turn" | "flip-to-auto") => void;
  resolveCheckpointConfirm?: (choice: "continue" | "revise" | "stop", text?: string) => void;
  resolveReviseConfirm?: (choice: "accept" | "reject") => void;

  reloadHooks?: () => number;
  reloadMcp?: () => Promise<number>;
  invokeMcpTool?: (
    serverLabel: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Without this, registry has the tool but the prefix shown to the model stays stale until restart. */
  addToolToPrefix?: (spec: import("../types.js").ToolSpec) => boolean;
}

export type ChoiceResolution =
  | { kind: "pick"; optionId: string }
  | { kind: "custom"; text: string }
  | { kind: "cancel" };

export interface DashboardStats {
  /** Total turns this session. */
  turns: number;
  /** Cumulative session cost in USD. */
  totalCostUsd: number;
  /** Cost of the most recent turn. */
  lastTurnCostUsd: number;
  /** Input + output split — drives "in $X · out $Y" rendering. */
  totalInputCostUsd: number;
  totalOutputCostUsd: number;
  /** Cache hit ratio across the session, 0..1. */
  cacheHitRatio: number;
  /** Prompt tokens of the most recent turn — feeds the ctx gauge. */
  lastPromptTokens: number;
  /** Per-model context cap in tokens (1_000_000 for V4). */
  contextCapTokens: number;
  /** Null while background fetch pending OR on offline/auth failure — SPA renders first entry. */
  balance: Array<{
    currency: string;
    total_balance: string;
    granted_balance?: string;
    topped_up_balance?: string;
  }> | null;
}

/** Active modal snapshot — same shape as a `modal-*-up` SSE event payload. */
export type ActiveModal =
  | {
      kind: "shell";
      command: string;
      allowPrefix: string;
      shellKind: "run_command" | "run_background";
    }
  | {
      kind: "choice";
      question: string;
      options: Array<{ id: string; title: string; summary?: string }>;
      allowCustom: boolean;
    }
  | { kind: "plan"; body: string }
  | {
      kind: "edit-review";
      path: string;
      /** Both halves for side-by-side diff; `preview` kept for older flat-string clients. */
      search: string;
      replace: string;
      preview: string;
      total: number;
      remaining: number;
    }
  | {
      kind: "checkpoint";
      stepId: string;
      title?: string;
      completed: number;
      total: number;
    }
  | {
      kind: "revision";
      reason: string;
      remainingSteps: Array<{
        id: string;
        title: string;
        action: string;
        risk?: "low" | "med" | "high";
      }>;
      summary?: string;
    };

/** One row of the conversation as the SPA renders it. */
export interface DashboardMessage {
  id: string;
  role: "user" | "assistant" | "info" | "warning" | "tool";
  text: string;
  /** When `role === "tool"` — name of the tool that produced this result. */
  toolName?: string;
  /** Raw JSON args (role=tool) — lets SPA render tool-specific cards instead of a generic blob. */
  toolArgs?: string;
  /** Optional reasoning content for assistant messages (R1 / V4 thinking). */
  reasoning?: string;
}

export type DashboardEvent =
  | {
      kind: "assistant_delta";
      id: string;
      contentDelta?: string;
      reasoningDelta?: string;
    }
  | { kind: "assistant_final"; id: string; text: string; reasoning?: string }
  | { kind: "tool_start"; id: string; toolName: string; args?: string }
  | { kind: "tool"; id: string; toolName: string; content: string; args?: string }
  | { kind: "warning"; id: string; text: string }
  | { kind: "error"; id: string; text: string }
  | { kind: "info"; id: string; text: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "busy-change"; busy: boolean }
  | { kind: "status"; text: string }
  | { kind: "modal-up"; modal: ActiveModal }
  | { kind: "modal-down"; modalKind: ActiveModal["kind"] }
  | { kind: "ping" };

export interface SubmitResult {
  accepted: boolean;
  reason?: string;
}

/** Append-only — same rules as `usage.jsonl`, never rewritten. */
export interface AuditEntry {
  ts: number;
  /** `add-allowlist`, `remove-allowlist`, `set-edit-mode`, etc. */
  action: string;
  /** Free-form payload for the action. Keep PII out (no prompts). */
  payload?: Record<string, unknown>;
}
