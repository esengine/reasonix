import type { EditMode } from "../../../config.js";
import type { InspectionReport } from "../../../mcp/inspect.js";
import type { BridgeEnv, McpClientHost } from "../../../mcp/registry.js";
import type { JobRegistry } from "../../../tools/jobs.js";
import type { PlanStep } from "../../../tools/plan.js";

export interface SlashResult {
  /** Text to display back to the user as a system/info line. */
  info?: string;
  /** Open the SessionPicker modal mid-chat — used by `/sessions` slash. */
  openSessionsPicker?: boolean;
  /** Open the MCP browser modal — used by `/mcp` slash in interactive contexts. */
  openMcpBrowser?: boolean;
  /** Open the arg-completer picker for this command (e.g. `/language` → language picker). */
  openArgPickerFor?: string;
  /** Exit the app. */
  exit?: boolean;
  /** Clear the visible history. */
  clear?: boolean;
  /** Unknown command — display usage hint. */
  unknown?: boolean;
  /** `/retry` re-submit text — pushed back through the normal submit flow after log truncation. */
  resubmit?: string;
  /** Structured `/context` payload — `info` text can't carry per-segment color for the stacked bar. */
  ctxBreakdown?: {
    systemTokens: number;
    toolsTokens: number;
    logTokens: number;
    inputTokens: number;
    ctxMax: number;
    toolsCount: number;
    logMessages: number;
    topTools: Array<{ name: string; tokens: number; turn: number }>;
  };
  /** `/replay [N]` archived-plan payload — display-only, NEVER executed. */
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

export interface SlashContext {
  mcpSpecs?: string[];
  codeUndo?: (args: readonly string[]) => string;
  codeApply?: (indices?: readonly number[]) => string;
  codeDiscard?: (indices?: readonly number[]) => string;
  codeHistory?: () => string;
  codeShowEdit?: (args: readonly string[]) => string;
  codeRoot?: string;
  pendingEditCount?: number;
  toolHistory?: () => Array<{ toolName: string; text: string }>;
  mcpServers?: McpServerSummary[];
  /** Absent → tests context; `/memory` MUST reply "root unknown" rather than silently reading wrong dir. */
  memoryRoot?: string;
  planMode?: boolean;
  editMode?: EditMode;
  setEditMode?: (mode: EditMode) => void;
  touchedFiles?: () => string[];
  /** stop_job is async; handlers return synchronously and let the registry resolve in the background. */
  jobs?: JobRegistry;
  postInfo?: (text: string) => void;
  /** Push a structured Doctor card with check-by-check status; used by `/doctor`. */
  postDoctor?: (
    checks: ReadonlyArray<{ label: string; level: "ok" | "warn" | "fail"; detail: string }>,
  ) => void;
  /** Push a verbose Usage card (full bars) — used by `/cost`; auto-emitted per-turn cards stay compact. */
  postUsage?: (args: {
    turn: number;
    promptTokens: number;
    reasonTokens: number;
    outputTokens: number;
    promptCap: number;
    cacheHit: number;
    cost: number;
    sessionCost: number;
    balance?: number;
    elapsedMs?: number;
  }) => void;
  dispatch?: (event: import("../state/events.js").AgentEvent) => void;
  setPlanMode?: (on: boolean) => void;

  /** `/apply-plan` clears the picker so its own `resubmit` doesn't double-fire approval. */
  clearPendingPlan?: () => void;
  reloadHooks?: () => number;
  /** `null` → still in flight OR offline; consumers can't distinguish, so always offer `refreshLatestVersion`. */
  latestVersion?: string | null;
  refreshLatestVersion?: () => void;
  /** `null` → in flight / failed; `[]` → API answered empty. `/model <id>` warn-only since list can lag. */
  models?: string[] | null;
  refreshModels?: () => void;
  armPro?: () => void;
  disarmPro?: () => void;
  startLoop?: (intervalMs: number, prompt: string) => void;
  stopLoop?: () => void;
  getLoopStatus?: () => {
    prompt: string;
    intervalMs: number;
    iter: number;
    nextFireMs: number;
  } | null;
  startWalkthrough?: () => string;
  startDashboard?: () => Promise<string>;
  /** Tear the dashboard server down. Mirrors stopLoop's shape; no-op when not running. */
  stopDashboard?: () => Promise<void>;
  /** Snapshot the dashboard's URL when running, null otherwise. */
  getDashboardUrl?: () => string | null;
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
  /** Mutable client handle so `/mcp reconnect` can swap the underlying socket without re-bridging tools. */
  host: McpClientHost;
  /** Captured at first-bridge time so append-drift reconnects can register newly-added tools with the same options. */
  bridgeEnv: BridgeEnv;
}

export interface SlashCommandSpec {
  cmd: string;
  summary: string;
  contextual?: "code";
  /** If the command takes args, hint text shown after the name. */
  argsHint?: string;
  /** First-arg picker source — file paths intentionally absent (use `@path` mentions instead). */
  argCompleter?: "models" | "mcp-resources" | "mcp-prompts" | readonly string[];
}

export interface SlashArgContext {
  spec: SlashCommandSpec;
  partial: string;
  partialOffset: number;
  kind: "picker" | "hint";
}
