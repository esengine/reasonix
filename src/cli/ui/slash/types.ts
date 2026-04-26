import type { EditMode } from "../../../config.js";
import type { McpClient } from "../../../mcp/client.js";
import type { InspectionReport } from "../../../mcp/inspect.js";
import type { JobRegistry } from "../../../tools/jobs.js";
import type { PlanStep } from "../../../tools/plan.js";

export interface SlashResult {
  /** Text to display back to the user as a system/info line. */
  info?: string;
  /** Exit the app. */
  exit?: boolean;
  /** Clear the visible history. */
  clear?: boolean;
  /** Unknown command — display usage hint. */
  unknown?: boolean;
  /**
   * Re-submit this text as a user message after displaying `info`.
   * Used by `/retry` — the slash command truncates the log, then
   * asks the TUI to push the original text back through the normal
   * submit flow so a fresh turn runs.
   */
  resubmit?: string;
  /**
   * Render an archived plan as a read-only "Time Travel" block in
   * scrollback. Populated by `/replay [N]`. The TUI mounts it as a
   * `plan-replay` DisplayEvent so the same step-list / risk gutter
   * styling gets reused. Strictly a display payload — no execution.
   */
  replayPlan?: {
    summary?: string;
    body?: string;
    steps: PlanStep[];
    completedStepIds: string[];
    completedAt: string;
    relativeTime: string;
    archiveBasename: string;
    /** 1-based index in `/plans` listing — surfaced in the header. */
    index: number;
    /** Total archives at the time of the lookup; helps the user navigate. */
    total: number;
  };
}

/**
 * Extra runtime context a slash handler may care about but that isn't
 * already on the loop. Kept as an optional object so tests that only
 * need loop-scoped commands can skip it, and callers only populate the
 * slots that apply to their session.
 */
export interface SlashContext {
  /**
   * The exact `--mcp` / config-derived spec strings that were bridged
   * into this session (one entry per server). Used by `/mcp`. Empty or
   * omitted → no MCP servers attached.
   */
  mcpSpecs?: string[];
  /**
   * Callback for `/undo` — provided by the TUI when it's running in
   * code mode. Returns a human-readable report of what was restored.
   * Absent outside code mode → `/undo` replies "not available here".
   * Accepts slash args: `[id]`, `[id, path]`.
   */
  codeUndo?: (args: readonly string[]) => string;
  /**
   * Callback for `/apply [N|N,M|N-M]` — commits pending edit blocks to
   * disk. Returns a report of what landed. With no `indices` (or `[]`),
   * applies every pending block; with explicit 1-based indices, applies
   * just those and leaves the rest pending. Absent → `/apply` replies
   * "nothing pending" or "not available outside code mode".
   */
  codeApply?: (indices?: readonly number[]) => string;
  /**
   * Callback for `/discard [N|N,M|N-M]` — drops the pending edit blocks
   * without touching disk. Same indices semantics as `codeApply`: empty
   * means "drop all pending"; explicit indices drop just those.
   */
  codeDiscard?: (indices?: readonly number[]) => string;
  /**
   * Callback for `/history` — returns a human-readable list of every
   * edit batch this session, newest last. Includes entry ids (for
   * `/show`) and undone status.
   */
  codeHistory?: () => string;
  /**
   * Callback for `/show [id] [path]` — with no args, shows a per-file
   * summary of the newest non-undone entry. With id only, the entry's
   * per-file summary. With id + path, the full diff of that single
   * file in that entry.
   */
  codeShowEdit?: (args: readonly string[]) => string;
  /**
   * Root directory passed by `reasonix code`. Enables `/commit`, which
   * runs `git add -A && git commit` in this directory. Missing → `/commit`
   * replies "only available in code mode".
   */
  codeRoot?: string;
  /**
   * How many edit blocks are currently pending `/apply` or `/discard`.
   * Surfaced by `/status`. TUI populates it live from its pending ref;
   * omitted → treat as 0 (chat-only session).
   */
  pendingEditCount?: number;
  /**
   * Callback returning every tool result seen this session in
   * chronological order (oldest first). Powers `/tool [N]` for
   * inspecting the full untruncated output that `EventLog` clips at
   * 400 chars for display. Absent → `/tool` replies "not available".
   */
  toolHistory?: () => Array<{ toolName: string; text: string }>;
  /**
   * Pre-captured inspection reports for each connected MCP server.
   * Populated once at chat startup (chat.tsx) so `/mcp` can render
   * tools + resources + prompts synchronously without needing async
   * handler support.
   */
  mcpServers?: McpServerSummary[];
  /**
   * Directory `/memory` should resolve `REASONIX.md` from. In code
   * mode this is the rootDir the filesystem tools are pinned to; in
   * plain chat this is `process.cwd()` at launch time. Absent → the
   * TUI is running in some non-cwd context (tests) and `/memory`
   * replies "root unknown" instead of silently reading a different dir.
   */
  memoryRoot?: string;
  /**
   * Current plan-mode state, surfaced in `/status` and toggled by
   * `/plan`. Present iff the session is a `reasonix code` run — chat
   * mode doesn't have plan mode.
   */
  planMode?: boolean;
  /**
   * Current edit-gate mode (`review` or `auto`). Surfaced in `/status`,
   * toggled by `/mode`, also flipped by the Shift+Tab keybind in the
   * TUI. Absent → not in `reasonix code`.
   */
  editMode?: EditMode;
  /**
   * Set the edit-gate mode. Callback rather than raw state so App can
   * also persist the choice to config and echo the change in historical.
   */
  setEditMode?: (mode: EditMode) => void;
  /**
   * Background-process registry backing /jobs / /kill / /logs. Present
   * iff the session is a `reasonix code` run. Slash handlers expect
   * synchronous info strings, but stop_job is async — we return a
   * "stopping, watch /jobs" info and let the registry do its thing.
   */
  jobs?: JobRegistry;
  /**
   * Async-late append to the historical log. /kill uses this to
   * surface "job N stopped" the moment stop() actually resolves,
   * rather than leaving the user to poll /jobs themselves.
   */
  postInfo?: (text: string) => void;
  /**
   * Callback the `/plan` slash uses to flip plan mode on/off. Also
   * mirrors the state to the underlying ToolRegistry so dispatch
   * enforcement follows. Absent → `/plan` replies "only available in
   * code mode".
   */
  setPlanMode?: (on: boolean) => void;
  /**
   * Callback that clears a pending-plan picker state. Called by
   * `/apply-plan` so that when the user force-approves, the picker
   * dismisses without also firing its own approval synthetic (the
   * slash returns its own `resubmit` instead). Safe to call with no
   * pending plan.
   */
  clearPendingPlan?: () => void;
  /**
   * Re-load `~/.reasonix/settings.json` + `<project>/.reasonix/settings.json`
   * and update both the App's hook state and the loop's mutable hook
   * list. Returns the new hook count so the slash can echo a sane
   * confirmation. Absent → `/hooks reload` replies "not available".
   */
  reloadHooks?: () => number;
  /**
   * Latest published version if App's background registry check
   * has completed, `null` otherwise (still in flight OR offline).
   * Drives `/update` — the slash shows whatever the async check
   * already resolved, so the command is fully synchronous.
   */
  latestVersion?: string | null;
  /**
   * Fire-and-forget: kick off a fresh registry fetch. `/update`
   * calls this whenever it encounters `latestVersion === null`
   * so the user can rerun the slash a few seconds later and see
   * a concrete answer. Absent → the slash just reports "pending"
   * with no retry path.
   */
  refreshLatestVersion?: () => void;
  /**
   * Model catalog fetched from DeepSeek's `/models` endpoint at App
   * mount. `null` → still in flight or the call failed (auth / offline);
   * `[]` → the API answered with zero entries. `/models` uses this to
   * render the list, and `/model <id>` uses it for soft validation
   * (warn-only — we still switch even on unknown ids since the list
   * can lag a newly-released model).
   */
  models?: string[] | null;
  /**
   * Fire-and-forget refresh for the models list. Lets `/models` retry
   * after a flaky first fetch without needing async slash support.
   */
  refreshModels?: () => void;
  /**
   * Arm pro for the next turn. Called by `/pro`. The TUI wires this
   * to both `loop.armProForNextTurn()` and its React mirror state so
   * the StatsPanel badge flips immediately. Absent → the handler
   * calls `loop.armProForNextTurn()` directly and the badge updates
   * on the next render tick (slightly laggy but still correct).
   */
  armPro?: () => void;
  /** Cancel a pending /pro arming. Mirrors `armPro` semantics. */
  disarmPro?: () => void;
}

export interface McpServerSummary {
  /** Short label shown in the `/mcp` output (server namespace or "anon"). */
  label: string;
  /** Original --mcp spec string. */
  spec: string;
  /** Count of tools bridged into the Reasonix registry from this server. */
  toolCount: number;
  /** Full inspection snapshot — used for the resources + prompts sections. */
  report: InspectionReport;
  /**
   * Live MCP client, kept so `/resource` and `/prompt` can call
   * `readResource` / `getPrompt` against this server. Omitted by
   * callers that only build the summary for display; those slashes
   * fall back to "not available" when the client is missing.
   */
  client?: McpClient;
}

/**
 * Slash command registry. Drives `/help`, the on-type suggestion
 * popup (`SlashSuggestions`), and auto-complete. Kept as data rather
 * than derived from the `handleSlash` switch so summaries can be
 * user-facing rather than code comments.
 *
 * `contextual` gates commands that only make sense in certain modes:
 *   - `"code"` — only show when the TUI is running `reasonix code`
 *   - absent → always shown
 */
export interface SlashCommandSpec {
  cmd: string;
  summary: string;
  contextual?: "code";
  /** If the command takes args, hint text shown after the name. */
  argsHint?: string;
  /**
   * How the first argument position should autocomplete. Shapes the
   * picker that appears below the prompt once the user types `/<cmd>`
   * + space:
   *   - `"models"`         → DeepSeek model-id list fetched at startup.
   *   - `"mcp-resources"`  → live URIs aggregated across connected MCP servers.
   *   - `"mcp-prompts"`    → live prompt names aggregated across MCP servers.
   *   - `string[]`         → small enum of literal values (e.g. `["on", "off"]`).
   *   - omitted            → no picker; a persistent usage hint shows the
   *                          argsHint + summary so the user knows what to type.
   *
   * File-path completion is deliberately NOT offered here. Users who
   * want to reference a file in a prompt use `@path/to/file` (0.5.5);
   * the `@` picker already surfaces files with mtime + recently-used
   * ranking. Adding a second file-picker surface for slash commands
   * would split the UX without adding leverage.
   */
  argCompleter?: "models" | "mcp-resources" | "mcp-prompts" | readonly string[];
}

/**
 * Shape describing what the prompt buffer is asking for AFTER the
 * user has committed to a slash command (`/<cmd>`) and started
 * typing its first argument. Consumed by the TUI to drive an
 * argument-level picker.
 */
export interface SlashArgContext {
  /** The command spec (looked up by name from SLASH_COMMANDS). */
  spec: SlashCommandSpec;
  /** The partial first-argument text, possibly empty. */
  partial: string;
  /**
   * Buffer offset where `partial` begins. Used by the TUI to splice
   * a picked completion back in at the right position.
   */
  partialOffset: number;
  /**
   * Classification of what the caller should show:
   *   - `"picker"` → an interactive picker (file / enum / models). The
   *     caller uses `spec.argCompleter` to pick the data source and
   *     filters against `partial`.
   *   - `"hint"`   → past the completable position (additional args or
   *     no completer declared). Caller shows a dim usage hint only.
   */
  kind: "picker" | "hint";
}
