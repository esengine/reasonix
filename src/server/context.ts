/**
 * `DashboardContext` — the data + callback surface a server instance
 * needs from its caller. Two callers exist:
 *
 *   1. **Standalone** (`reasonix dashboard`) — boots without a TUI, so
 *      it can only see what's on disk: config, usage.jsonl, sessions
 *      directory. No live loop, no in-flight pending edits.
 *   2. **Attached** (`/dashboard` from the TUI) — runs alongside a
 *      live `CacheFirstLoop` and has access to current state through
 *      the same callbacks `SlashContext` already exposes (so we don't
 *      reinvent how App.tsx surfaces "what's the current edit mode?"
 *      etc).
 *
 * Every callback is optional. Endpoints check presence and return a
 * 503-ish "not available in this mode" body when missing. Concrete
 * handler stubs in `api/*.ts` describe what each endpoint expects.
 *
 * Why pass callbacks rather than the raw loop / app state: the loop
 * is mutable; capturing it once at server-boot would freeze stale
 * data in closures. Callbacks read the live ref every request.
 */

import type { McpServerSummary } from "../cli/ui/slash/types.js";
import type { EditMode } from "../config.js";
import type { CacheFirstLoop } from "../loop.js";
import type { ToolRegistry } from "../tools.js";
import type { JobRegistry } from "../tools/jobs.js";

export interface DashboardContext {
  /**
   * Where to read/write `~/.reasonix/config.json`. Defaulting via
   * `defaultConfigPath()` is the caller's responsibility — the
   * server module deliberately doesn't touch `homedir()` itself so
   * tests can redirect cleanly.
   */
  configPath: string;
  /** Path to the cross-session usage log; same defaulting rule. */
  usageLogPath: string;
  /**
   * Bound mode label — surfaced to the SPA so it can hide controls
   * that need a live loop. `"standalone"` = `reasonix dashboard`,
   * `"attached"` = `/dashboard` slash from inside a live TUI.
   */
  mode: "standalone" | "attached";

  // ---------- Live state (attached mode only) ----------

  /**
   * Live loop reference, captured by the slash handler. Endpoints
   * that need turn-level state (busy flag, current model, log size)
   * read `loop` here; standalone mode leaves it undefined.
   */
  loop?: CacheFirstLoop;
  /**
   * Tool registry — drives the Tools tab. Standalone mode can't
   * surface live tools (the registry is built by the TUI on session
   * start with MCP bridges already resolved); we'd need a dry-run
   * registry build to support it, deferred to v0.13.
   */
  tools?: ToolRegistry;
  /**
   * Bridged MCP servers + their inspection reports. Same pattern as
   * `SlashContext.mcpServers`.
   */
  mcpServers?: McpServerSummary[];
  /**
   * Background-jobs registry. When attached, /api/jobs lists+kills.
   * Standalone has no jobs because no spawn happened.
   */
  jobs?: JobRegistry;

  // ---------- Read callbacks ----------

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
  /**
   * Current session name, or null for ephemeral. Used by the SPA
   * to label "you are here" when a sessions browser lands later.
   */
  getSessionName?: () => string | null;

  // ---------- Mutations ----------

  /**
   * Flip the edit gate. Returns the resolved mode (so the SPA can
   * sync without an extra GET). Throws on an invalid value.
   */
  setEditMode?: (mode: EditMode) => EditMode;
  /**
   * Toggle plan mode. Same semantics as the `/plan` slash.
   */
  setPlanMode?: (on: boolean) => void;
  /**
   * Apply a preset to the LIVE loop — flips `model` + `autoEscalate`
   * + `reasoningEffort` so the next turn picks up the new commitment
   * without a session restart. The user-asks-why moment: switching
   * from auto → pro on the persisted config alone wouldn't change
   * the running session's model. This callback closes that gap.
   *
   * Accepts the new vocabulary (`auto | flash | pro`) and the legacy
   * aliases (`fast | smart | max`); App.tsx canonicalizes via
   * resolvePreset before pushing into the loop.
   */
  applyPresetLive?: (name: string) => void;
  /**
   * Apply reasoning_effort to the LIVE loop. Same rationale —
   * settings POST writes to config, this side-channel flips the
   * running loop so the change is immediate.
   */
  applyEffortLive?: (effort: "high" | "max") => void;
  /**
   * Audit hook fired on every successful mutation. Caller wires this
   * to `~/.reasonix/dashboard-audit.jsonl` writes. Endpoints don't
   * write the log themselves so tests can swap the implementation.
   */
  audit?: (entry: AuditEntry) => void;

  // ---------- Chat bridge (web ↔ live loop) ----------

  /**
   * Snapshot of the rendered conversation in display order. The web
   * Chat tab calls this once at mount for the initial paint, then
   * subscribes to subsequent events via `subscribeEvents`. Each entry
   * is a serializable view of one displayed row — DisplayEvent shapes
   * from the TUI mapped down to JSON. Implementation detail: App.tsx
   * exposes a ref-mirror of `historical`.
   */
  getMessages?: () => DashboardMessage[];
  /**
   * Subscribe to the live loop event stream. Called by the SSE
   * endpoint on connect. Returns an unsubscribe function the endpoint
   * calls on disconnect. App.tsx fans out events into a Set of
   * subscribers from the same point in the render loop where it pushes
   * to historical.
   *
   * Events are JSON-serializable subsets of the TUI's event shapes —
   * not raw `LoopEvent` objects, since some carry React-only state.
   */
  subscribeEvents?: (handler: (event: DashboardEvent) => void) => () => void;
  /**
   * Submit a prompt as if the user typed it in the TUI. Returns
   * `{ accepted: true }` if the loop took it, `{ accepted: false,
   * reason: "..." }` if it's currently busy or otherwise can't take
   * input. Routes through the same `handleSubmit` the TUI uses, so
   * slash commands, `!cmd`, `@path`, plan-mode gating all work
   * identically to typing in the terminal.
   */
  submitPrompt?: (text: string) => SubmitResult;
  /** Abort the current turn (web equivalent of pressing Esc). No-op when idle. */
  abortTurn?: () => void;
  /** True when a turn is in flight; the SPA disables submit button. */
  isBusy?: () => boolean;
  /**
   * Snapshot of the live session stats — what the TUI's StatsPanel
   * already shows. Lets the web Chat tab paint a status bar without
   * piping through SessionSummary's whole shape.
   */
  getStats?: () => DashboardStats | null;

  // ---------- Modal mirroring ----------
  //
  // Each pending* state in App.tsx broadcasts a `modal-up` event; on
  // dismissal a `modal-down` event. The resolve callbacks below let
  // the web POST a choice that drives the same handler the TUI's
  // modal click would. Either surface can resolve; the other's modal
  // disappears via the resulting modal-down event.

  /** Snapshot of any modal currently up (for SSE clients that connect mid-modal). */
  getActiveModal?: () => ActiveModal | null;
  /** Resolve a ShellConfirm. Choice mirrors `ShellConfirmChoice`. */
  resolveShellConfirm?: (choice: "run_once" | "always_allow" | "deny") => void;
  /** Resolve a ChoiceConfirm. */
  resolveChoiceConfirm?: (choice: ChoiceResolution) => void;
  /**
   * Resolve a PlanConfirm. Approve / refine carry an optional free-form
   * text the user typed in PlanRefineInput; cancel ignores it.
   */
  resolvePlanConfirm?: (choice: "approve" | "refine" | "cancel", text?: string) => void;
  /** Resolve an EditConfirm review. */
  resolveEditReview?: (choice: "apply" | "reject" | "apply-rest-of-turn" | "flip-to-auto") => void;

  // ---------- v0.14 mutation surface ----------

  /**
   * Reload hooks from disk + sync into the loop. Mirrors the
   * `/hooks reload` slash. Returns the new active-hook count.
   */
  reloadHooks?: () => number;
  /**
   * Re-bridge the MCP server fleet from current config — used by the
   * MCP panel after `addMcpSpec` / `removeMcpSpec`. Returns how many
   * servers ended up bridged. Optional — when absent the SPA shows
   * "restart session to apply" after edits.
   */
  reloadMcp?: () => Promise<number>;
  /**
   * Invoke a single tool on a connected MCP server, used by the MCP
   * panel's "test invoke" form. Returns the raw JSON-RPC result.
   */
  invokeMcpTool?: (
    serverLabel: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  /**
   * Push a new tool spec onto the live `ImmutablePrefix` so the model
   * sees the tool from the next turn onward. Used by the Semantic
   * panel to register `semantic_search` once an index build finishes
   * — without this hook the tool exists in the registry but the
   * prefix the model is shown stays stale until the user restarts.
   * Returns `true` on add, `false` if a tool with the same name was
   * already present.
   */
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
  /**
   * DeepSeek API balance — array of currency snapshots. Null when the
   * background fetch hasn't resolved or the call failed (offline /
   * auth). The SPA renders the first entry.
   */
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
      /** Block being reviewed — both halves so the dashboard can render
       * a side-by-side diff with syntax highlighting. `preview` stays
       * around for older clients that just stream a flat string. */
      search: string;
      replace: string;
      preview: string;
      total: number;
      remaining: number;
    };

/** One row of the conversation as the SPA renders it. */
export interface DashboardMessage {
  id: string;
  role: "user" | "assistant" | "info" | "warning" | "tool";
  text: string;
  /** When `role === "tool"` — name of the tool that produced this result. */
  toolName?: string;
  /**
   * When `role === "tool"` — raw JSON args the model passed in. Lets the
   * SPA render tool-specific cards (edit_file as a diff, write_file as a
   * code block with the path, etc) instead of a generic blob.
   */
  toolArgs?: string;
  /** Optional reasoning content for assistant messages (R1 / V4 thinking). */
  reasoning?: string;
}

/**
 * Event shape pushed to SSE subscribers. Closely mirrors `LoopEvent`
 * but adds a few app-level kinds (`message-appended`, `busy-change`)
 * so the web client doesn't have to re-derive what the TUI re-derives
 * from raw loop events.
 */
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

/**
 * One row of `~/.reasonix/dashboard-audit.jsonl`. Append-only,
 * never rewritten — same rules as `usage.jsonl`. Lets a user grep
 * "what did the dashboard change last week."
 */
export interface AuditEntry {
  ts: number;
  /** `add-allowlist`, `remove-allowlist`, `set-edit-mode`, etc. */
  action: string;
  /** Free-form payload for the action. Keep PII out (no prompts). */
  payload?: Record<string, unknown>;
}
