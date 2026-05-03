import type { WriteStream } from "node:fs";
import { Box, Text, useStdout } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type JsonlEventSink,
  eventLogPath,
  openEventSink,
} from "../../adapters/event-sink-jsonl.js";
import { type AtUrlExpansion, expandAtMentions, expandAtUrls } from "../../at-mentions.js";
import { createCheckpoint } from "../../code/checkpoints.js";
import {
  type ApplyResult,
  type EditBlock,
  applyEditBlocks,
  snapshotBeforeEdits,
  toWholeFileEditBlock,
} from "../../code/edit-blocks.js";
import { clearPendingEdits, loadPendingEdits, savePendingEdits } from "../../code/pending-edits.js";
import {
  archivePlanState,
  clearPlanState,
  loadPlanState,
  relativeTime,
  savePlanState,
} from "../../code/plan-store.js";
import {
  type EditMode,
  type PresetName,
  type ReasoningEffort,
  addProjectShellAllowed,
  defaultConfigPath,
  editModeHintShown,
  loadEditMode,
  loadReasoningEffort,
  loadSidebarOpen,
  markEditModeHintShown,
  saveEditMode,
  saveReasoningEffort,
  saveSidebarOpen,
} from "../../config.js";
import { Eventizer } from "../../core/eventize.js";
import { type ResolvedHook, formatHookOutcomeMessage, loadHooks, runHooks } from "../../hooks.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";
import type { LoopEvent } from "../../loop.js";
import {
  deleteSession,
  detectGitBranch,
  type listSessions,
  listSessionsForWorkspace,
  loadSessionMessages,
  loadSessionMeta,
  patchSessionMeta,
  renameSession,
} from "../../memory/session.js";
import type {
  ActiveModal,
  DashboardEvent,
  DashboardMessage,
  SubmitResult,
} from "../../server/context.js";
import { type DashboardServerHandle, startDashboardServer } from "../../server/index.js";
import {
  DEEPSEEK_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  type SessionSummary,
} from "../../telemetry/stats.js";
import { defaultUsageLogPath } from "../../telemetry/usage.js";
import type { ToolRegistry } from "../../tools.js";
import type { ChoiceOption } from "../../tools/choice.js";
import type { PlanStep } from "../../tools/plan.js";
import { formatCommandResult, runCommand } from "../../tools/shell.js";
import { registerSkillTools } from "../../tools/skills.js";
import { formatSubagentResult, spawnSubagent } from "../../tools/subagent.js";
import { webFetch } from "../../tools/web.js";
import { openTranscriptFile, recordFromLoopEvent, writeRecord } from "../../transcript/log.js";
import { AtMentionSuggestions } from "./AtMentionSuggestions.js";
import { ChoiceConfirm, type ChoiceConfirmChoice } from "./ChoiceConfirm.js";
import { EditConfirm, type EditReviewChoice } from "./EditConfirm.js";
import { McpBrowser } from "./McpBrowser.js";
import { type CheckpointChoice, PlanCheckpointConfirm } from "./PlanCheckpointConfirm.js";
import { PlanConfirm, type PlanConfirmChoice } from "./PlanConfirm.js";
import { PlanRefineInput } from "./PlanRefineInput.js";
import { PlanReviseConfirm, type ReviseChoice } from "./PlanReviseConfirm.js";
import { PlanReviseEditor } from "./PlanReviseEditor.js";
import { PromptInput } from "./PromptInput.js";
import { SessionPicker } from "./SessionPicker.js";
import { ShellConfirm, type ShellConfirmChoice, derivePrefix } from "./ShellConfirm.js";
import { SlashArgPicker } from "./SlashArgPicker.js";
import { SlashSuggestions } from "./SlashSuggestions.js";
import { WelcomeBanner } from "./WelcomeBanner.js";
import { detectBangCommand, formatBangUserMessage } from "./bang.js";
import { PlanCard } from "./cards/PlanCard.js";
import { writeClipboard } from "./clipboard.js";
import { formatEditResults, partitionEdits } from "./edit-history.js";
import { loopEventToDashboard } from "./effects/loop-to-dashboard.js";
import { renderFrame } from "./frame-render.js";
import { appendGlobalMemory, appendProjectMemory, detectHashMemory } from "./hash-memory.js";
import { applySlashResult } from "./hooks/apply-slash-result.js";
import { handleAssistantFinal } from "./hooks/handle-assistant-final.js";
import {
  handleErrorEvent,
  handleToolStart,
  handleWarningEvent,
} from "./hooks/handle-stream-events.js";
import { handleToolEvent } from "./hooks/handle-tool-event.js";
import { useAgentSession } from "./hooks/useAgentSession.js";
import { useScrollback } from "./hooks/useScrollback.js";
import { useSyntheticSubmit } from "./hooks/useSyntheticSubmit.js";
import { useKeystroke } from "./keystroke-context.js";
import { CardStream } from "./layout/CardStream.js";
import {
  ModeStatusBar,
  OngoingToolRow,
  SubagentRow,
  ThinkingRow,
  UndoBanner,
} from "./layout/LiveRows.js";
import { SIDEBAR_MIN_TOTAL_COLS, SidebarPanel } from "./layout/SidebarPanel.js";
import { StatusRow } from "./layout/StatusRow.js";
import { ToastRail } from "./layout/ToastRail.js";
import { ViewportBudgetProvider } from "./layout/viewport-budget.js";
import { formatLoopStatus } from "./loop.js";
import { applyMcpAppend } from "./mcp-append.js";
import { handleMcpBrowseSlash } from "./mcp-browse.js";
import { formatLongPaste } from "./paste-collapse.js";
import { resolvePreset } from "./presets.js";
import { type McpServerSummary, handleSlash, parseSlash, suggestSlashCommands } from "./slash.js";
import { TurnTranslator } from "./state/TurnTranslator.js";
import { cardsToDashboardMessages } from "./state/cards-to-messages.js";
import { hydrateCardsFromMessages } from "./state/hydrate.js";
import { AgentStoreProvider, useAgentState, useAgentStore } from "./state/provider.js";
import { COLOR } from "./theme.js";
import { TickerProvider } from "./ticker.js";
import { useCompletionPickers } from "./useCompletionPickers.js";
import { useEditHistory } from "./useEditHistory.js";
import { useSessionInfo } from "./useSessionInfo.js";
import { useSubagent } from "./useSubagent.js";

export interface AppProps {
  model: string;
  system: string;
  transcript?: string;
  harvest?: boolean;
  branch?: number;
  /** Soft USD spend cap; undefined → no cap. See CacheFirstLoopOptions.budgetUsd. */
  budgetUsd?: number;
  session?: string;
  /**
   * Pre-populated tool registry (e.g. from bridgeMcpTools()). When present,
   * its specs are folded into the ImmutablePrefix so the model sees them,
   * and its dispatch is used for tool calls — MCP tools become first-class.
   */
  tools?: ToolRegistry;
  /** Raw `--mcp` / config-derived spec strings, for `/mcp` slash display. */
  mcpSpecs?: string[];
  /**
   * Pre-captured inspection reports for each connected MCP server,
   * collected once at chat startup. Drives the rich `/mcp` slash view
   * (tools + resources + prompts per server).
   */
  mcpServers?: McpServerSummary[];
  /**
   * Shared ref the MCP bridge's onProgress callback writes through.
   * We attach our updater to `progressSink.current` on mount so any
   * `notifications/progress` frame from any bridged tool flows into
   * the UI. `null` allowed — chat mode without MCP leaves it unset.
   */
  progressSink?: {
    current:
      | ((info: { toolName: string; progress: number; total?: number; message?: string }) => void)
      | null;
  };
  /**
   * When set, parse SEARCH/REPLACE blocks from assistant responses and
   * apply them to disk under `rootDir`. Set by `reasonix code`. The
   * optional `jobs` registry enables /jobs + /kill slashes in the TUI
   * and the status-bar "N jobs running" indicator.
   */
  codeMode?: {
    rootDir: string;
    jobs?: import("../../tools/jobs.js").JobRegistry;
    /**
     * `/cwd <path>` callback — re-registers every rootDir-dependent
     * native tool against the new path. Optional: when omitted the
     * slash command degrades to updating hook cwd / memory root only,
     * with file/shell tools still pointing at the original root.
     */
    reregisterTools?: (rootDir: string) => void;
  };
  /**
   * When `true`, suppress the auto-launch of the embedded web dashboard
   * server on TUI mount. Default behavior is to boot the dashboard so
   * the URL shows in the status bar (clickable in OSC-8-aware
   * terminals) — most users had no idea `/dashboard` even existed.
   * `--no-dashboard` is the CLI flag that flips this on for CI / users
   * who don't want a localhost listener.
   */
  noDashboard?: boolean;
  /** Mid-chat session swap — Root remounts App with the new session via key. */
  onSwitchSession?: (name: string | undefined) => void;
}

/**
 * Throttle interval in ms. We flush streaming deltas at most this often to
 * avoid re-rendering the whole UI on every single token from DeepSeek.
 * 33ms ≈ 30Hz, matches the cadence users feel as smooth in modern terminals
 * (Windows Terminal, WezTerm, iTerm2, Alacritty, Ghostty). Override via
 * `REASONIX_FLUSH_MS` if you're on a fragile terminal (winpty/MINTTY) that
 * leaves repaint artifacts at higher refresh rates — bumping back to 100
 * trades smoothness for stability.
 */
const FLUSH_INTERVAL_MS = (() => {
  const raw = process.env.REASONIX_FLUSH_MS;
  if (!raw) return 33;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 16 || parsed > 1000) return 33;
  return Math.round(parsed);
})();

/**
 * True when the user has opted out of live spinner/streaming rows.
 * `REASONIX_UI=plain` suppresses every transient row in the render
 * tree so only the `<Static>` committed history + the input prompt
 * are drawn. Trades liveness for stability on terminals where Ink's
 * cursor-up repaint leaves ghost artifacts.
 */
const PLAIN_UI = process.env.REASONIX_UI === "plain";

/**
 * Single-line status pill rendered below the modeline whenever a /loop
 * is active. Re-renders every second so the countdown ticks.
 */
function LoopStatusRow({
  loop,
}: {
  loop: { prompt: string; intervalMs: number; nextFireAt: number; iter: number };
}) {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const nextFireMs = Math.max(0, loop.nextFireAt - Date.now());
  return (
    <Box>
      <Text color="cyan">{`▸ ${formatLoopStatus(loop.prompt, nextFireMs, loop.iter)} · /loop stop or type to cancel`}</Text>
    </Box>
  );
}

interface StreamingState {
  id: string;
  text: string;
  reasoning: string;
  toolCallBuild?: { name: string; chars: number };
}

export function App(props: AppProps): React.ReactElement {
  const session = useAgentSession({
    sessionId: props.session,
    model: props.model,
    workspace: props.codeMode?.rootDir ?? process.cwd(),
  });
  const initialCards = React.useMemo(
    () => (props.session ? hydrateCardsFromMessages(loadSessionMessages(props.session)) : []),
    [props.session],
  );
  return (
    <AgentStoreProvider session={session} initialCards={initialCards}>
      <AppInner {...props} />
    </AgentStoreProvider>
  );
}

function AppInner({
  model,
  system,
  transcript,
  harvest,
  branch,
  budgetUsd,
  session,
  tools,
  mcpSpecs,
  mcpServers,
  progressSink,
  codeMode,
  noDashboard,
  onSwitchSession,
}: AppProps) {
  const log = useScrollback();
  const agentStore = useAgentStore();
  const hasConversation = useAgentState((s) =>
    s.cards.some((c) => c.kind === "user" || c.kind === "streaming"),
  );
  const isStreaming = useAgentState((s) => s.cards.some((c) => c.kind === "streaming" && !c.done));
  const activePlanCard = useAgentState((s) => {
    for (let i = s.cards.length - 1; i >= 0; i--) {
      const c = s.cards[i];
      if (
        c?.kind === "plan" &&
        c.variant === "active" &&
        c.steps.some((step) => step.status !== "queued") &&
        c.steps.some((step) => step.status !== "done" && step.status !== "skipped")
      ) {
        return c;
      }
    }
    return null;
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Tracks whether the current turn has been aborted via Esc, so the
  // Esc handler only fires once per turn (repeated presses would yield
  // stacked warning events).
  const abortedThisTurn = useRef(false);
  // Mirrors the live `busy` flag for /loop's timer (it has no React
  // closure handle, only refs). Skips the firing when a prior turn is
  // still running rather than queuing a duplicate submit.
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  // Name + truncated args of the tool currently dispatching. Populated
  // on `tool_start`, cleared on `tool` (or error). Drives the
  // "▸ tool<X> running…" pulse-spinner row so long tool calls don't
  // look like the app hung.
  const [ongoingTool, setOngoingTool] = useState<{ name: string; args?: string } | null>(null);
  // Sidebar visibility — persisted in config; default on (panel self-hides when no plan is active).
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    const stored = loadSidebarOpen();
    if (typeof stored === "boolean") return stored;
    return true;
  });
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((cur) => {
      const next = !cur;
      try {
        saveSidebarOpen(next);
      } catch {
        /* config write failures shouldn't break the UI */
      }
      return next;
    });
  }, []);
  // Latest progress frame for the currently-running tool (MCP
  // `notifications/progress`). `null` when no progress has been
  // reported for this tool call — OngoingToolRow still spins, just
  // without a progress number.
  const [toolProgress, setToolProgress] = useState<{
    progress: number;
    total?: number;
    message?: string;
  } | null>(null);
  // stdout handle for `/clear`-style hard screen wipes. Clearing the
  // store alone leaves the terminal scrollback intact — the user keeps
  // seeing prior turns until they scroll past them. Writing CSI 2J + 3J +
  // H genuinely nukes viewport AND scrollback, which is what `/clear`
  // means to a shell user.
  const { stdout } = useStdout();
  // Terminal input modes we opt into at startup, all paired with
  // disable-on-unmount so the user's shell doesn't inherit them:
  //
  //   • Bracketed paste (DECSET 2004) — terminal wraps pasted text
  //     with \x1b[200~ … \x1b[201~ markers so a multi-chunk paste
  //     can't be misread as keystrokes (the trailing \n in a paste
  //     would otherwise fire submit).
  //
  //   • modifyOtherKeys level 2 (CSI > 4 ; 2 m) — terminal encodes
  //     modifier-bearing keypresses (Shift+Enter, Ctrl+Enter, etc.)
  //     as `\x1b[27;<mod>;<key>~` instead of the bare ASCII byte. Our
  //     stdin-reader recognises `27;2;13~` as Shift+Enter and
  //     `27;5;13~` as Ctrl+Enter. Terminals that don't understand the
  //     SGR fall through silently — Shift+Enter just stays
  //     indistinguishable from Enter, no regression.
  useEffect(() => {
    if (!stdout || !stdout.isTTY) return;
    stdout.write("\u001b[?2004h");
    stdout.write("\u001b[>4;2m");
    return () => {
      stdout.write("\u001b[?2004l");
      stdout.write("\u001b[>4m");
    };
  }, [stdout]);

  // Resize-suppression state. While the user is dragging the
  // terminal corner, OS emits a stream of resize events at high
  // frequency. Each one would trigger Ink to re-render — and our
  // per-tick animations (wordmark gradient, prompt bar flow,
  // cursor blink) keep firing at 120 ms — both with stale
  // `eraseLines(N)` counts because the previous frame's logical
  // height is no longer the visible height after wrap reflows.
  // Result: ghost copies of the StatsPanel pile up.
  //
  // Fix: detect resize bursts and freeze the global ticker while
  // they're in flight. With the ticker frozen, no re-render fires
  // from animations during the resize storm. Once the user stops
  // dragging (no resize event for ~400 ms), the ticker resumes
  // and one clean re-render kicks in. The hard-clear in chat.tsx's
  // resize listener handles the single transition ghost.
  const [isResizing, setIsResizing] = useState(false);
  useEffect(() => {
    if (!stdout || !stdout.isTTY) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      setIsResizing(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setIsResizing(false);
        timer = null;
      }, 400);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
      if (timer) clearTimeout(timer);
    };
  }, [stdout]);
  // Subagent UI wiring: live activity row + sink ref the loop closure
  // captures. Must be declared BEFORE loop construction so the
  // subagentRunner closure can read the ref.
  const { activity: subagentActivity, sinkRef: subagentSinkRef } = useSubagent({
    session,
    log,
  });
  // Transient "what's happening" text set by the loop during silent
  // phases (harvest round-trip, between-iteration R1 thinking, forced
  // summary). Rendered as a dim spinner row; auto-cleared on the next
  // primary event.
  const [statusLine, setStatusLine] = useState<string | null>(null);
  // Live working directory for every rootDir-dependent surface:
  // hook cwd, memory root, project shell allowlist root, `@file`
  // mention root, `applyEditBlocks` base, run_command cwd, project-
  // settings hook loader. `/cwd <path>` mutates this state to swap
  // the workspace mid-session; the prop `codeMode.rootDir` stays as
  // the original launch root so it can't accidentally drift (it's
  // used purely for "is this a code-mode session?" checks now).
  const [currentRootDir, setCurrentRootDir] = useState<string>(
    () => codeMode?.rootDir ?? process.cwd(),
  );
  // Loaded user hooks (project + global settings.json). Stays mutable
  // so `/hooks reload` and `/cwd` can rescan disk without
  // reconstructing the loop. The loop holds a parallel reference for
  // its tool-event dispatch; we keep them in sync via the effect below.
  const [hookList, setHookList] = useState<ResolvedHook[]>(() =>
    loadHooks({ projectRoot: codeMode?.rootDir }),
  );
  // Session-scoped edit history + undo banner + /undo, /history, /show
  // handlers. Kept in a custom hook so App.tsx only sees the small API
  // it needs — append an edit, arm the banner, answer the slash
  // callbacks, seal the turn entry, check whether anything's undoable.
  const {
    undoBanner,
    recordEdit,
    armUndoBanner,
    codeUndo,
    codeHistory,
    codeShowEdit,
    sealCurrentEntry,
    hasUndoable,
    touchedPaths,
  } = useEditHistory(codeMode);
  // Pending edit blocks awaiting `/apply` or `/discard`. We do NOT
  // auto-apply — v0.4.1 showed that "model proposed, so apply" turns
  // analysis into unintended edits. The user explicitly confirms now.
  const pendingEdits = useRef<EditBlock[]>([]);
  // Reactive mirror of `pendingEdits.current.length`. Refs don't trigger
  // re-renders, but the bottom mode-status bar needs to show the queue
  // size live — this keeps the number in sync whenever the queue grows
  // (interceptor / text-SEARCH parse / checkpoint restore) or clears
  // (/apply / /discard / /new).
  const [pendingCount, setPendingCount] = useState(0);
  const syncPendingCount = useCallback(() => {
    setPendingCount(pendingEdits.current.length);
    // Bump the tick so the /walk modal re-evaluates "first remaining
    // block" after each per-block apply/discard. Without this the
    // EditConfirm render would keep the OLD block reference and never
    // advance.
    setPendingTick((t) => t + 1);
  }, []);
  // Edit-gate mode. `review` (default) queues edits into pendingEdits;
  // `auto` applies them immediately and exposes an undo banner. Shift+
  // Tab cycles, `/mode <review|auto>` sets explicitly. Persisted so
  // toggling once survives a relaunch.
  const [editMode, setEditMode] = useState<EditMode>(() => (codeMode ? loadEditMode() : "review"));
  const [preset, setPreset] = useState<"auto" | "flash" | "pro">(() => {
    if (model === "deepseek-v4-pro") return "pro";
    return "auto";
  });
  // Interceptor closure reads the live mode through this ref — so we
  // install the registry hook once (in useEffect below) and avoid tearing
  // down + reattaching it every time the user cycles modes.
  const editModeRef = useRef<EditMode>(editMode);
  useEffect(() => {
    editModeRef.current = editMode;
    if (codeMode) saveEditMode(editMode);
  }, [editMode, codeMode]);
  // Refs that mirror state for stable read-callbacks handed to the
  // embedded dashboard server. The server's `getXxx()` closures are
  // captured once at startDashboard time; without ref-mirrors the
  // returned values would freeze at boot. Same pattern as editModeRef.
  const planModeRef = useRef<boolean>(false);
  const currentRootDirRef = useRef<string>("");
  const latestVersionRef = useRef<string | null>(null);
  // Current per-edit confirmation prompt (review mode, tool-call path).
  // Non-null → EditConfirm modal renders, interceptor is suspended on
  // `editReviewResolveRef.current`, other live rows hide. User picks a
  // choice → handleEditReviewChoose resolves the promise, interceptor
  // resumes and returns the tool result the model will see.
  const [pendingEditReview, setPendingEditReview] = useState<EditBlock | null>(null);
  // /walk active flag — when true the App walks pendingEdits one block
  // at a time through EditConfirm. Distinct from `pendingEditReview`,
  // which is the AUTO-mode tool-call interceptor. Walkthrough is
  // user-initiated against the QUEUED pending list, not mid-stream.
  const [walkthroughActive, setWalkthroughActive] = useState(false);
  // Bumped every time codeApply/codeDiscard mutates pendingEdits so the
  // walkthrough render can re-pick "block 0 of the current queue" via
  // a useMemo dep. Without this, walkthroughActive alone wouldn't
  // re-render after a partial apply.
  const [pendingTick, setPendingTick] = useState(0);
  /** Result from the EditConfirm modal: choice plus optional deny context. */
  interface EditReviewResult {
    choice: EditReviewChoice;
    denyContext?: string;
  }
  const editReviewResolveRef = useRef<((r: EditReviewResult) => void) | null>(null);
  // Per-turn override: set by "apply-rest-of-turn" so subsequent edits
  // in the SAME turn skip the modal and land like AUTO. Resets to "ask"
  // at handleSubmit entry so the next user turn starts fresh.
  const turnEditPolicyRef = useRef<"ask" | "apply-all">("ask");
  // Visual highlight on the bottom mode bar for ~1.2s after Shift+Tab /
  // /mode flips the mode — a soft "yes, it changed" signal so the user
  // doesn't have to scan the header to confirm the toggle landed.
  const [modeFlash, setModeFlash] = useState(false);
  const modeFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevEditModeRef = useRef<EditMode>(editMode);
  useEffect(() => {
    if (prevEditModeRef.current === editMode) return;
    prevEditModeRef.current = editMode;
    setModeFlash(true);
    if (modeFlashTimeoutRef.current) clearTimeout(modeFlashTimeoutRef.current);
    modeFlashTimeoutRef.current = setTimeout(() => {
      setModeFlash(false);
      modeFlashTimeoutRef.current = null;
    }, 1200);
  }, [editMode]);
  // Shell command the model asked to run that wasn't on the auto-run
  // allowlist. Non-null renders the ShellConfirm modal and disables
  // the prompt input; the user picks Run once / Always allow in this
  // project / Deny and we feed the result back as a synthetic user
  // message so the model sees what happened.
  const [pendingShell, setPendingShell] = useState<{
    command: string;
    /**
     * Which tool surfaced the NeedsConfirmationError. Drives post-
     * approval dispatch: `run_command` uses the synchronous runCommand
     * (waits for exit); `run_background` spawns via JobRegistry and
     * returns after a ready-signal / waitSec window.
     */
    kind: "run_command" | "run_background";
  } | null>(null);
  // Plan text the model submitted via `submit_plan` while plan mode
  // was active. Non-null renders PlanConfirm; user picks Approve /
  // Refine / Cancel and we drive the loop from there. Separate from
  // `planMode` because a pending plan is a one-shot decision even if
  // plan mode stays on (Refine keeps mode on; Approve/Cancel flip off).
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  /** While the user is interactively editing the proposed plan via PlanReviseEditor; null = not editing. */
  const [pendingReviseEditor, setPendingReviseEditor] = useState<string | null>(null);
  /** True while the SessionPicker is open mid-chat (triggered by `/sessions`). */
  const [pendingSessionsPicker, setPendingSessionsPicker] = useState(false);
  const [sessionsPickerList, setSessionsPickerList] = useState<ReturnType<typeof listSessions>>([]);
  /** True while the McpBrowser modal is open (triggered by `/mcp`). */
  const [pendingMcpBrowser, setPendingMcpBrowser] = useState(false);
  // Stashed plan + intent while the user types free-form feedback
  // (refinement or last instructions on approve). When the picker
  // returns "refine" or "approve", we defer the loop-resume and show
  // PlanRefineInput. User types + Enter → we ship it; Esc → restore
  // pendingPlan and re-show the picker. Letting Approve also take
  // input closes the "model left open questions, user had no place
  // to answer them" hole.
  const [stagedInput, setStagedInput] = useState<{
    plan: string;
    mode: "refine" | "approve";
  } | null>(null);
  // Mid-execution pause from `mark_step_complete` — the model finished
  // a step and the loop is now waiting for the user to pick Continue /
  // Revise / Stop. Distinct from `pendingPlan` because at this point
  // the plan has already been approved and execution is in flight; the
  // picker just checkpoints each step.
  const [pendingCheckpoint, setPendingCheckpoint] = useState<{
    stepId: string;
    title?: string;
    completed: number;
    total: number;
  } | null>(null);
  // Staged entry for the Revise feedback input at a checkpoint. Carries
  // enough context (stepId, title, counters) that Esc can restore the
  // picker instead of dropping back into raw execution. Same two-step
  // pattern as `stagedInput` for plan approvals.
  const [stagedCheckpointRevise, setStagedCheckpointRevise] = useState<{
    stepId: string;
    title?: string;
    completed: number;
    total: number;
  } | null>(null);
  // Plan revision proposal from `revise_plan`. Non-null mounts the
  // PlanReviseConfirm picker showing a step-level diff. Accept replaces
  // remaining steps in planStepsRef; Reject drops the proposal and the
  // model continues with the original plan. The model is most likely
  // to call this in response to the user's checkpoint Revise feedback,
  // but it can fire at any tool-dispatch moment.
  const [pendingRevision, setPendingRevision] = useState<{
    reason: string;
    remainingSteps: PlanStep[];
    summary?: string;
  } | null>(null);
  // Branching question from `ask_choice`. Non-null mounts ChoiceConfirm;
  // user picks an option (synthetic "user picked <id>"), types a
  // custom answer (synthetic "user answered: <text>"), or cancels.
  // Kept separate from pendingPlan / pendingCheckpoint because a
  // branch question is orthogonal to plan state — it can fire in
  // chat mode or mid-plan when the model genuinely needs a decision.
  const [pendingChoice, setPendingChoice] = useState<{
    question: string;
    options: ChoiceOption[];
    allowCustom: boolean;
  } | null>(null);
  // Staged entry for the "Let me type my own answer" path. Same
  // two-step pattern as stagedInput for plan approvals — user picks
  // "custom", we stash the question context, show a free-form input,
  // and Esc restores the picker.
  const [stagedChoiceCustom, setStagedChoiceCustom] = useState<{
    question: string;
    options: ChoiceOption[];
    allowCustom: boolean;
  } | null>(null);
  // Plan-mode indicator — displayed in the StatsPanel, mirrored onto
  // the ToolRegistry so dispatch enforces read-only. Toggled via the
  // `/plan` slash and PlanConfirm picker. Ephemeral — not persisted
  // across launches (you explicitly opt in per session).
  const [planMode, setPlanMode] = useState<boolean>(false);
  // /pro armed — next turn will run on v4-pro. Mirrored here (rather
  // than reading loop.proArmed directly) so state transitions trigger
  // a StatsPanel re-render that picks up the new badge.
  const [proArmed, setProArmed] = useState(false);
  // True while the CURRENT running turn is on v4-pro because of either
  // /pro arming or auto-escalation. Set on turn-start if armed consumed
  // OR any "⇧ pro" warning fires, cleared at turn-end.
  const [turnOnPro, setTurnOnPro] = useState(false);
  // Text waiting to be submitted AFTER the current turn finishes.
  // Set by ShellConfirm's onChoose when the user approves faster than
  // the model's "awaiting confirmation" response. We can't call
  // handleSubmit directly because it early-returns on `busy === true`,
  // so we abort the in-flight turn and let the effect below fire the
  // submit once busy clears.
  const [queuedSubmit, setQueuedSubmit] = useState<string | null>(null);
  // Shell-style history of user prompts. ↑/↓ while idle walks it;
  // submit pushes to the end. Cursor -1 = "live input", 0+ = "N turns
  // back from newest". We don't persist history to disk — sessions
  // already keep the message log, and cross-session bash-style recall
  // would need per-project scoping we haven't designed.
  const promptHistory = useRef<string[]>([]);
  const historyCursor = useRef<number>(-1);
  // Disambiguates <Static> keys when a single turn yields multiple assistant_final events.
  const assistantIterCounter = useRef<number>(0);
  // Per-session @url fetch cache. Keyed by stripped URL; same URL
  // referenced twice in one session fetches once. Not persisted —
  // we deliberately re-fetch on session resume since the page may
  // have changed. Shape mirrors AtUrlExpansion + an optional `body`
  // so the trailing block can be reconstructed from cache alone.
  const atUrlCache = useRef<Map<string, AtUrlExpansion & { body?: string }>>(new Map());
  // Active /loop state. Null when no loop is running. Re-issuing /loop
  // replaces the slot. Cancellation is centralized in stopLoop() so
  // every cancel-trigger (Esc, /clear, /new, user-typed submit, /loop
  // stop, exit) goes through one path. The timer is held in a sibling
  // ref so React effects don't have to re-run on every timer tick.
  const [activeLoop, setActiveLoop] = useState<{
    prompt: string;
    intervalMs: number;
    nextFireAt: number;
    iter: number;
  } | null>(null);
  const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // handleSubmit is defined far below as a useCallback. The /loop timer
  // needs to call the LATEST closure on each firing (config could have
  // shifted mid-loop), so we mirror it through a ref. The mirror is
  // synced in a useEffect once handleSubmit is defined.
  const handleSubmitRef = useRef<((raw: string) => Promise<void>) | null>(null);
  const busyRef = useRef<boolean>(false);
  const activeLoopRef = useRef<typeof activeLoop>(activeLoop);
  // Set true by the loop timer just before it calls handleSubmitRef so
  // handleSubmit's "any user submit cancels the loop" guard knows to
  // skip itself. Reset to false at the top of every handleSubmit.
  const loopFiringRef = useRef<boolean>(false);
  useEffect(() => {
    activeLoopRef.current = activeLoop;
  }, [activeLoop]);
  // Full untruncated tool results, in arrival order. ToolCard clips
  // output at 400 chars for display; `/tool N` reads from this ref to
  // show the real thing. Not persisted — a
  // resumed session replays the log (which has the same content in
  // `tool` messages) but we don't repopulate this ref on resume
  // because the user wouldn't expect `/tool` to reach back across
  // process boundaries.
  const toolHistoryRef = useRef<Array<{ toolName: string; text: string }>>([]);
  // Embedded dashboard server handle. Set when /dashboard boots; null
  // otherwise. Mutations to this ref happen inside the start/stop
  // callbacks; the slash handler uses getDashboardUrl() to surface
  // the current state without triggering re-renders on every poll.
  const dashboardRef = useRef<DashboardServerHandle | null>(null);
  // De-dupe concurrent startDashboard() invocations. Without this, when
  // the auto-start useEffect re-fires (because `startDashboard`'s
  // useCallback deps change mid-mount) the early `if (dashboardRef.current)
  // return` check sees null because the first call hasn't returned from
  // its `await startDashboardServer()` yet — so we'd start two listeners
  // on two ports, leak the first handle, and make the chrome pill flicker
  // between two URLs. Hold the in-flight Promise here and reuse it.
  const dashboardStartingRef = useRef<Promise<string> | null>(null);
  // SSE subscribers attached by /api/events. App.tsx fans out one
  // DashboardEvent per loop event so the web Chat tab updates in
  // sync with the TUI. The Set is keyed by the subscriber function
  // itself; subscribeEvents returns an unsubscribe closure.
  const eventSubscribersRef = useRef<Set<(ev: DashboardEvent) => void>>(new Set());
  // Structured steps captured from the most recent `submit_plan` call.
  // Populated only when the model supplied `steps`; used by the
  // `mark_step_complete` handler to look up the step title and compute
  // the `N/M` counter. Reset on every new plan submission so a
  // revised plan starts fresh — old completions don't spill over.
  const planStepsRef = useRef<PlanStep[] | null>(null);
  const completedStepIdsRef = useRef<Set<string>>(new Set());
  // Markdown body + human-friendly summary captured from submit_plan.
  // Persisted alongside the structured state so a future Time-Travel
  // replay can show the model's full original proposal without re-
  // reading the JSONL log, and so /plans + the resume banner can
  // identify plans by intent rather than by filename.
  const planBodyRef = useRef<string | null>(null);
  const planSummaryRef = useRef<string | null>(null);
  // Wall-clock when the latest tool_start fired. Cleared when the
  // matching `tool` event arrives (or at turn end). Tools are
  // dispatched serially in the loop, so a single ref is enough — no
  // need for a per-toolName map.
  const toolStartedAtRef = useRef<number | null>(null);
  // Persist the active plan state (steps + completedStepIds) to disk
  // whenever it changes, so closing the terminal doesn't lose
  // structured progress. The on-disk format lives in plan-store.ts;
  // we just thread the session name through and call save/clear at
  // the right points. No-op when session is undefined (e.g.
  // ephemeral runs with --no-session).
  const persistPlanState = useCallback(() => {
    if (!session) return;
    const steps = planStepsRef.current;
    if (!steps || steps.length === 0) {
      clearPlanState(session);
      return;
    }
    const extras: { body?: string; summary?: string } = {};
    if (planBodyRef.current) extras.body = planBodyRef.current;
    if (planSummaryRef.current) extras.summary = planSummaryRef.current;
    savePlanState(session, steps, completedStepIdsRef.current, extras);
  }, [session]);
  const [summary, setSummary] = useState<SessionSummary>({
    turns: 0,
    totalCostUsd: 0,
    totalInputCostUsd: 0,
    totalOutputCostUsd: 0,
    claudeEquivalentUsd: 0,
    savingsVsClaudePct: 0,
    cacheHitRatio: 0,
    lastPromptTokens: 0,
    lastTurnCostUsd: 0,
  });

  const transcriptRef = useRef<WriteStream | null>(null);
  if (transcript && !transcriptRef.current) {
    transcriptRef.current = openTranscriptFile(transcript, {
      version: 1,
      source: "reasonix chat",
      model,
      startedAt: new Date().toISOString(),
    });
  }
  // Kernel event log sidecar — opens iff the session has a name (skip
  // ephemeral sessions). Sink + Eventizer share lifetime with App; the
  // for-await consumer below pipes every LoopEvent through them so a
  // typed Event log accumulates at `~/.reasonix/sessions/<name>.events.jsonl`.
  // Old transcript path is unchanged — this is a parallel artifact, not
  // a replacement. Future replay / projection consumers read from here.
  const eventSinkRef = useRef<JsonlEventSink | null>(null);
  const eventizerRef = useRef<Eventizer | null>(null);
  if (session && !eventSinkRef.current) {
    eventSinkRef.current = openEventSink(eventLogPath(session));
    eventizerRef.current = new Eventizer();
    eventSinkRef.current.append(eventizerRef.current.emitSessionOpened(0, session, 0));
  }
  useEffect(() => {
    return () => {
      transcriptRef.current?.end();
      void eventSinkRef.current?.close();
    };
  }, []);

  const loopRef = useRef<CacheFirstLoop | null>(null);
  // hookList + currentRootDir intentionally NOT in deps — they seed
  // the loop on first construction (loopRef guards a single
  // instantiation), and later edits flow in through the mutable
  // `loop.hooks = hookList` / `loop.hookCwd = currentRootDir` effects
  // below. Putting them in deps would tear down the loop on every
  // reload, wiping the append-only log mid-session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hookList — see comment above
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentRootDir — see comment above
  const loop = useMemo(() => {
    if (loopRef.current) return loopRef.current;
    const client = new DeepSeekClient();
    // Register run_skill HERE (not in code.tsx / chat.tsx) because
    // subagent-runAs skills need the client + parent registry to
    // spawn child loops. Wiring lives in App.tsx so the same code
    // path covers both code mode and chat mode.
    //
    // The closure captures `tools` (parent registry), `client`, and
    // the subagent sink ref by lexical scope — `spawnSubagent` reads
    // them per invocation, so a sink handler attached after this
    // registration still receives events.
    if (tools && !tools.has("run_skill")) {
      registerSkillTools(tools, {
        projectRoot: codeMode?.rootDir,
        subagentRunner: async (skill, task, signal) => {
          const result = await spawnSubagent({
            client,
            parentRegistry: tools,
            parentSignal: signal,
            // Skill body is the subagent's persona/playbook; the user-
            // supplied task is what to actually do inside it.
            system: skill.body,
            task,
            // Per-skill model override (frontmatter `model: ...`),
            // else falls through to spawnSubagent's default.
            model: skill.model,
            sink: subagentSinkRef.current,
            // Stamped onto every event so the TUI sink + usage log can
            // attribute the run to a skill without extra bookkeeping.
            skillName: skill.name,
          });
          return formatSubagentResult(result);
        },
      });
    }
    const prefix = new ImmutablePrefix({
      system,
      toolSpecs: tools?.specs(),
    });
    const l = new CacheFirstLoop({
      client,
      prefix,
      tools,
      model,
      harvest,
      branch,
      budgetUsd,
      session,
      hooks: hookList,
      hookCwd: currentRootDir,
      // Restore the user's last-chosen effort cap. Without this a
      // `/effort high` silently reverted to `max` on relaunch — the
      // loop's constructor default wins over persisted state.
      reasoningEffort: loadReasoningEffort(),
    });
    loopRef.current = l;
    return l;
  }, [model, system, harvest, branch, budgetUsd, session, tools, codeMode]);

  // Keep the loop's hook list in sync after a `/hooks reload`. The
  // loop's field is intentionally mutable for exactly this case —
  // construction happens once, hook edits are picked up live.
  useEffect(() => {
    loop.hooks = hookList;
  }, [loop, hookList]);

  // Ambient session info (balance, model catalog, latest published
  // version) — three independent mount-time fetches behind one hook
  // so the refresh callbacks can be wired into handleSubmit's finally
  // (balance) and the slash context (/models, /update).
  const {
    balance,
    models,
    latestVersion,
    updateAvailable,
    refreshBalance,
    refreshModels,
    refreshLatestVersion,
  } = useSessionInfo(loop);

  // Keep the dashboard-server ref-mirrors in sync with their state.
  // These four are the load-bearing live reads for the attached
  // dashboard's read APIs; without these mirrors the captured
  // closures inside startDashboardServer freeze at boot time.
  useEffect(() => {
    planModeRef.current = planMode;
  }, [planMode]);
  useEffect(() => {
    currentRootDirRef.current = currentRootDir;
  }, [currentRootDir]);

  useEffect(() => {
    latestVersionRef.current = latestVersion ?? null;
  }, [latestVersion]);
  // Ref-mirror so getStats() (frozen at startDashboard time) sees fresh
  // balance. useSessionInfo refreshes balance every few minutes; we
  // forward to the dashboard without re-minting startDashboard.
  const balanceRef = useRef<typeof balance>(null);
  useEffect(() => {
    balanceRef.current = balance;
    if (balance) {
      agentStore.dispatch({ type: "session.update", patch: { balance: balance.total } });
    }
  }, [balance, agentStore]);

  // Fan out a DashboardEvent to every web subscriber. No-op when
  // nothing is connected, so the cost of the bridge in the common
  // (no dashboard open) case is one Set.size lookup per event.
  const broadcastDashboardEvent = useCallback((ev: DashboardEvent) => {
    const subs = eventSubscribersRef.current;
    if (subs.size === 0) return;
    for (const h of subs) {
      try {
        h(ev);
      } catch {
        /* one bad subscriber must not stop the others */
      }
    }
  }, []);

  // Broadcast busy-state changes so the web Chat tab can disable its
  // submit button while a turn is in flight. Mirrors what the TUI's
  // `busy` flag already drives for PromptInput.
  useEffect(() => {
    broadcastDashboardEvent({ kind: "busy-change", busy });
  }, [busy, broadcastDashboardEvent]);

  // ---------- Modal mirroring (web parity for ShellConfirm / ChoiceConfirm /
  // PlanConfirm / EditConfirm) ----------
  //
  // Each pending* state is the source of truth on the TUI side. These
  // effects fan it out to web subscribers as `modal-up` events; the
  // useEffect cleanup fires `modal-down` when the modal closes (the
  // user picked from EITHER surface — once a pending state goes null
  // the cleanup runs and both clients see it disappear).
  //
  // The shell + choice + plan paths are straightforward state→event.
  // edit-review is different — its source of truth is `editReviewResolveRef`
  // (a promise the dispatch interceptor is awaiting), wired via a
  // separate `pendingEditReview` state that we already broadcast here.

  useEffect(() => {
    if (!pendingShell) return;
    const modal: ActiveModal = {
      kind: "shell",
      command: pendingShell.command,
      allowPrefix: derivePrefix(pendingShell.command),
      shellKind: pendingShell.kind,
    };
    broadcastDashboardEvent({ kind: "modal-up", modal });
    return () => {
      broadcastDashboardEvent({ kind: "modal-down", modalKind: "shell" });
    };
  }, [pendingShell, broadcastDashboardEvent]);

  useEffect(() => {
    if (!pendingChoice) return;
    const modal: ActiveModal = {
      kind: "choice",
      question: pendingChoice.question,
      options: pendingChoice.options,
      allowCustom: pendingChoice.allowCustom,
    };
    broadcastDashboardEvent({ kind: "modal-up", modal });
    return () => {
      broadcastDashboardEvent({ kind: "modal-down", modalKind: "choice" });
    };
  }, [pendingChoice, broadcastDashboardEvent]);

  useEffect(() => {
    if (!pendingPlan) return;
    broadcastDashboardEvent({
      kind: "modal-up",
      modal: { kind: "plan", body: pendingPlan },
    });
    return () => {
      broadcastDashboardEvent({ kind: "modal-down", modalKind: "plan" });
    };
  }, [pendingPlan, broadcastDashboardEvent]);

  useEffect(() => {
    if (!pendingEditReview) return;
    // Trim the preview — older clients only render this string; newer
    // clients use `search`/`replace` directly to render a side-by-side
    // diff with syntax highlighting (full content, no line cap).
    const previewLines = (pendingEditReview.search || pendingEditReview.replace || "")
      .split("\n")
      .slice(0, 12);
    const preview = previewLines.join("\n");
    broadcastDashboardEvent({
      kind: "modal-up",
      modal: {
        kind: "edit-review",
        path: pendingEditReview.path,
        search: pendingEditReview.search ?? "",
        replace: pendingEditReview.replace ?? "",
        preview,
        total: pendingEdits.current.length,
        remaining: pendingEdits.current.length,
      },
    });
    return () => {
      broadcastDashboardEvent({ kind: "modal-down", modalKind: "edit-review" });
    };
  }, [pendingEditReview, broadcastDashboardEvent]);

  useEffect(() => {
    if (!pendingCheckpoint) return;
    broadcastDashboardEvent({
      kind: "modal-up",
      modal: {
        kind: "checkpoint",
        stepId: pendingCheckpoint.stepId,
        title: pendingCheckpoint.title,
        completed: pendingCheckpoint.completed,
        total: pendingCheckpoint.total,
      },
    });
    return () => {
      broadcastDashboardEvent({ kind: "modal-down", modalKind: "checkpoint" });
    };
  }, [pendingCheckpoint, broadcastDashboardEvent]);

  useEffect(() => {
    if (!pendingRevision) return;
    broadcastDashboardEvent({
      kind: "modal-up",
      modal: {
        kind: "revision",
        reason: pendingRevision.reason,
        remainingSteps: pendingRevision.remainingSteps.map((s) => ({
          id: s.id,
          title: s.title,
          action: s.action,
          ...(s.risk ? { risk: s.risk } : {}),
        })),
        ...(pendingRevision.summary ? { summary: pendingRevision.summary } : {}),
      },
    });
    return () => {
      broadcastDashboardEvent({ kind: "modal-down", modalKind: "revision" });
    };
  }, [pendingRevision, broadcastDashboardEvent]);

  // Three mutually-exclusive input-prefix pickers (slash name, @ file
  // mention, slash argument) — state + memos + commit callbacks live
  // in a dedicated hook so App.tsx only sees the small surface it
  // actually consumes in useInput / handleSubmit / render. Declared
  // after useSessionInfo because the slash-arg picker reads the model
  // catalog for `/model <partial>` completion.
  const {
    slashMatches,
    slashSelected,
    setSlashSelected,
    atPicker,
    atMatches,
    atSelected,
    setAtSelected,
    pickAtMention,
    recordRecentFile,
    slashArgContext,
    slashArgMatches,
    slashArgSelected,
    setSlashArgSelected,
    pickSlashArg,
  } = useCompletionPickers({
    input,
    setInput,
    codeMode,
    rootDir: currentRootDir,
    models,
    mcpServers,
  });

  // Wire the shared progressSink so the bridge's onProgress → us.
  // Only updates progress when the frame belongs to the currently-
  // running tool: late frames from a previous call shouldn't overwrite
  // the spinner of whatever's running next.
  useEffect(() => {
    if (!progressSink) return;
    progressSink.current = (info) => {
      setToolProgress({
        progress: info.progress,
        total: info.total,
        message: info.message,
      });
    };
    return () => {
      if (progressSink.current) progressSink.current = null;
    };
  }, [progressSink]);

  // Surface a one-time banner about session state on first mount.
  const sessionBannerShown = useRef(false);
  useEffect(() => {
    if (sessionBannerShown.current) return;
    sessionBannerShown.current = true;
    if (!session) {
      log.pushInfo("▸ ephemeral chat (no session persistence) — drop --no-session to enable");
    } else if (loop.resumedMessageCount > 0) {
      log.pushInfo(
        `▸ resumed session "${session}" with ${loop.resumedMessageCount} prior messages · /forget to start over · /sessions to list`,
      );
    } else {
      log.pushInfo(
        `▸ session "${session}" (new) — auto-saved as you chat · /forget to delete · /sessions to list`,
      );
    }
    // Restore any pending edit queue from a prior run that was
    // interrupted before /apply or /discard. The checkpoint file sits
    // next to the session log; if present, we re-populate pendingEdits
    // and post an info row so the user knows what's waiting.
    if (session && codeMode) {
      const restored = loadPendingEdits(session);
      if (restored && restored.length > 0) {
        pendingEdits.current = restored;
        syncPendingCount();
        log.pushInfo(
          `▸ restored ${restored.length} pending edit block(s) from an interrupted prior run — /apply to commit or /discard to drop.`,
        );
      }
    }
    // Restore structured plan state from a prior run. plan.json sits
    // next to the session JSONL; if present, populate planStepsRef +
    // completedStepIdsRef and post an info row showing how far along
    // the plan was. Pure-markdown plans don't persist (nothing to
    // restore), so users see this banner only when there's real
    // structured state to pick back up.
    // Guard: skip restoration when the session has zero prior messages
    // (truly fresh). A stale plan file from a prior wipe that wasn't
    // cleaned up is not a real plan to resume — it's a sidecar orphan.
    if (session && loop.resumedMessageCount > 0) {
      const restoredPlan = loadPlanState(session);
      if (restoredPlan && restoredPlan.steps.length > 0) {
        planStepsRef.current = restoredPlan.steps;
        completedStepIdsRef.current = new Set(restoredPlan.completedStepIds);
        planBodyRef.current = restoredPlan.body ?? null;
        planSummaryRef.current = restoredPlan.summary ?? null;
        const when = relativeTime(restoredPlan.updatedAt);
        const done = new Set(restoredPlan.completedStepIds);
        const summary = restoredPlan.summary ? ` — ${restoredPlan.summary}` : "";
        log.showPlan({
          title: `Resumed plan · ${when}${summary}`,
          steps: restoredPlan.steps.map((s) => ({
            id: s.id,
            title: s.title,
            status: done.has(s.id) ? "done" : "queued",
          })),
          variant: "resumed",
        });
      }
    }
    // One-time onboarding tip for the edit-gate keybindings. New users
    // wouldn't otherwise discover Shift+Tab (it's in /keys and the
    // bottom status bar, but both require looking). Shown exactly once
    // per install; the config flag suppresses re-display on every
    // relaunch. Skips chat mode — those shortcuts don't apply there.
    if (codeMode && !editModeHintShown()) {
      log.pushInfo(
        "▸ TIP: edit-gate keybindings\n" +
          "    y / n       accept or drop pending edits\n" +
          "    Shift+Tab   switch review ↔ AUTO (persisted; AUTO applies instantly)\n" +
          "    u           undo the last auto-applied batch (within the 5s banner)\n" +
          "  Current mode is shown in the bottom status bar. Run /keys anytime for the full list.\n" +
          "  (This tip shows once — suppressed after.)",
      );
      markEditModeHintShown();
    }
  }, [session, loop, codeMode, syncPendingCount, log]);

  // Ctrl+C exits, period. SIGINT (cooked-mode terminals + Node's
  // Windows console handler) and \x03 byte (raw-mode stdin) both
  // converge on `quitProcess`. We call `process.exit` directly rather
  // than Ink's `exit()` because the singleton stdin-reader keeps a
  // `data` listener attached — `exit()` would unmount the React tree
  // but the event loop would stay alive and the terminal would hang.
  // Esc handles "abort the current turn" separately; Ctrl+C is the
  // universal "I'm done" key, no banner, no double-press dance.
  const quitProcess = useCallback(() => {
    transcriptRef.current?.end();
    process.exit(0);
  }, []);

  useEffect(() => {
    process.on("SIGINT", quitProcess);
    return () => {
      process.off("SIGINT", quitProcess);
    };
  }, [quitProcess]);

  // Esc during busy → forward to the loop as an abort signal. The loop
  // finishes the tool call in flight (we can't kill subprocess stdio
  // mid-write), then diverts to its no-tools summary path so the user
  // gets an answer instead of a hard stop. Only listens while busy so
  // we don't accidentally hijack Esc in other contexts.
  //
  // Also handles ↑/↓ shell-style history while idle. We don't use
  // ink-text-input's (absent) history support; parent-level useInput
  // is simpler and lets us own the cursor semantics.
  useKeystroke((ev) => {
    // PromptInput consumes its own keystrokes via useKeystroke too,
    // so events fan out to both this handler and PromptInput's. The
    // global hotkeys here only fire when the relevant condition
    // (busy / codeMode / etc.) holds, otherwise they no-op and let
    // PromptInput own the key.
    const chKey = ev.input;
    const key = ev;
    if (ev.paste) {
      // Paste content goes only to PromptInput. Don't run global
      // hotkey logic over it (a `\n` in paste shouldn't fire submit).
      return;
    }
    if (key.ctrl && key.input === "c") {
      quitProcess();
      return;
    }
    if (key.ctrl && key.input === "\\") {
      toggleSidebar();
      return;
    }
    if (key.escape && busy) {
      if (abortedThisTurn.current) return;
      abortedThisTurn.current = true;
      // If an edit-review modal is up, resolve its promise first so the
      // interceptor unblocks — otherwise the tool call hangs past the
      // loop's abort and the next turn can't start. Esc during modal =
      // "reject this edit" (safe default — nothing lands on disk).
      const resolve = editReviewResolveRef.current;
      if (resolve) {
        editReviewResolveRef.current = null;
        setPendingEditReview(null);
        resolve({ choice: "reject" });
      }
      // Esc during a busy turn also kills any active /loop — the user
      // is taking over. Loops persist past plain Esc when the system is
      // idle so a long-cadence loop doesn't die from random key noise.
      if (activeLoopRef.current) stopLoop();
      loop.abort();
      return;
    }
    // Esc when idle ALSO cancels an active loop, since hitting Esc with
    // nothing else going on is a clear "stop whatever's running"
    // gesture. No-op when no loop is active.
    if (key.escape && !busy && activeLoopRef.current) {
      stopLoop();
      return;
    }
    // Esc dismisses any composer-level picker (slash / @ / slash-arg)
    // by clearing the prefix that triggered it. Picker footers advertise
    // "esc cancel" — this binds it.
    if (key.escape && !busy && (slashMatches || atMatches || slashArgContext)) {
      setInput("");
      return;
    }
    // Esc inside a /walk session exits the walk WITHOUT applying or
    // discarding the current block — remaining edits stay queued so
    // the user can resume via /walk or commit via /apply later.
    if (key.escape && walkthroughActive) {
      setWalkthroughActive(false);
      const remaining = pendingEdits.current.length;
      log.pushInfo(
        remaining > 0
          ? `▸ walk cancelled — ${remaining} block(s) still pending.`
          : "▸ walk cancelled.",
      );
      return;
    }
    // Edit-mode cycle: Shift+Tab flips review ↔ auto. Available any
    // time a modal isn't up — including mid-turn — so the user can
    // switch gears without abandoning the in-flight request. Prefer
    // this to typing `/mode <x>`; one keystroke, no command parsing.
    if (
      codeMode &&
      key.shift &&
      key.tab &&
      !pendingShell &&
      !pendingPlan &&
      !pendingReviseEditor &&
      !pendingSessionsPicker &&
      !pendingMcpBrowser &&
      !stagedInput &&
      !pendingEditReview &&
      !walkthroughActive &&
      !pendingCheckpoint &&
      !stagedCheckpointRevise &&
      !pendingChoice &&
      !stagedChoiceCustom &&
      !pendingRevision
    ) {
      // Three-stop cycle: review → auto → yolo → review. yolo also
      // disables shell confirmations so true zero-prompt iteration takes two Shift+Tabs from default.
      const cur = editModeRef.current;
      const next: EditMode = cur === "review" ? "auto" : cur === "auto" ? "yolo" : "review";
      setEditMode(next);
      const message =
        next === "yolo"
          ? "▸ edit mode: YOLO — edits AND shell commands auto-run. /undo still rolls back edits. Use carefully."
          : next === "auto"
            ? "▸ edit mode: AUTO — edits apply immediately; press u within 5s to undo. Shell commands still ask."
            : "▸ edit mode: review — edits queue for /apply (or y) / /discard (or n)";
      log.pushInfo(message);
      return;
    }
    // Undo banner keybind: `u` rolls back the last auto-apply. Gated
    // on an empty prompt buffer so typing "user" into the input doesn't
    // steal from the first keystroke. 5-second window; after that the
    // banner self-dismisses and /undo remains the only path.
    if (
      codeMode &&
      input.length === 0 &&
      (chKey === "u" || chKey === "U") &&
      !pendingShell &&
      !pendingPlan &&
      !pendingReviseEditor &&
      !pendingSessionsPicker &&
      !pendingMcpBrowser &&
      !stagedInput &&
      !pendingEditReview &&
      !walkthroughActive &&
      !pendingCheckpoint &&
      !stagedCheckpointRevise &&
      !pendingChoice &&
      !stagedChoiceCustom &&
      !pendingRevision &&
      // Fire when EITHER the banner is up OR there's any non-undone
      // history entry — the keybind is useful long after the 5-second
      // banner expires, which users rightly want.
      (undoBanner || hasUndoable())
    ) {
      const out = codeUndo([]);
      log.pushInfo(out);
      return;
    }
    if (busy) return;
    // ShellConfirm owns the full keyboard while it's showing. If we
    // kept handling ↑/↓ / Tab here they'd race with its SingleSelect
    // — the picker would move AND history recall would fire into the
    // (hidden) prompt buffer. Bail early.
    if (pendingShell) return;

    // @-mention picker takes the same priority tier as slash. When
    // the user is typing `@…` in code mode and there are file matches,
    // ↑/↓ walk the list and Tab substitutes the selected path. Enter
    // is caught in handleSubmit. Must come BEFORE slash so the two
    // pickers don't fight over arrow keys (mutually exclusive by
    // construction — atPicker is null when slashMatches is set).
    if (atMatches && atMatches.length > 0) {
      if (key.upArrow) {
        setAtSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setAtSelected((i) => Math.min(atMatches.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const sel = atMatches[atSelected] ?? atMatches[0];
        if (sel) pickAtMention(sel);
        return;
      }
    }

    // Slash-argument picker. Fires inside `/<cmd> <partial>` — either
    // a file picker (for /edit), enum picker (for /preset, /model,
    // /plan, /branch, /harvest), or hint-only row. Navigation + Tab
    // substitute the highlighted value at the arg's offset.
    if (slashArgMatches && slashArgMatches.length > 0) {
      if (key.upArrow) {
        setSlashArgSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSlashArgSelected((i) => Math.min(slashArgMatches.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const sel = slashArgMatches[slashArgSelected] ?? slashArgMatches[0];
        if (sel) pickSlashArg(sel);
        return;
      }
    }

    // Slash-suggestion mode takes priority over history recall.
    // When the user is typing a `/…` prefix and there are matches,
    // ↑/↓ walk the suggestion list and Tab snaps the input to the
    // highlighted command. Enter is handled in `handleSubmit` so
    // TextInput's onSubmit still fires cleanly.
    if (slashMatches && slashMatches.length > 0) {
      if (key.upArrow) {
        setSlashSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSelected((i) => Math.min(slashMatches.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const sel = slashMatches[slashSelected] ?? slashMatches[0];
        if (sel) setInput(`/${sel.cmd}`);
        return;
      }
    }

    // History recall (↑/↓) used to live here guarded by `input.length
    // === 0`. It now runs inside PromptInput — the child detects
    // when a buffer-edge arrow key has nowhere left to go (empty
    // buffer, or cursor at first/last line of a multi-line draft)
    // and calls back into `recallPrev` / `recallNext` below. That
    // lets users escape into history from a multi-line draft by
    // pressing ↑ at the first line without first emptying the
    // buffer.
  });

  // History recall callbacks passed into PromptInput. Walking the
  // in-memory `promptHistory` list: ↑ moves backward through prior
  // prompts (increments historyCursor); ↓ moves forward until we
  // fall off the end, then resets to empty. No-op when the history
  // is empty or we're already at the boundary.
  const recallPrev = useCallback(() => {
    const hist = promptHistory.current;
    if (hist.length === 0) return;
    const nextCursor = Math.min(historyCursor.current + 1, hist.length - 1);
    historyCursor.current = nextCursor;
    setInput(hist[hist.length - 1 - nextCursor] ?? "");
  }, []);
  const recallNext = useCallback(() => {
    if (historyCursor.current < 0) return;
    const hist = promptHistory.current;
    const nextCursor = historyCursor.current - 1;
    historyCursor.current = nextCursor;
    setInput(nextCursor < 0 ? "" : (hist[hist.length - 1 - nextCursor] ?? ""));
  }, []);

  // Edit-gate interceptor. Reroutes `edit_file` / `write_file` tool
  // calls through the review queue (in `review` mode) or the auto-apply
  // snapshot/banner path (in `auto` mode) so the model's tool usage
  // respects the same gate as its text-form SEARCH/REPLACE output.
  // Without this, edit_file bypasses `/apply` entirely — which was the
  // bug that made the preview flow feel absent pre-0.5.24.
  //
  // `editModeRef` is read inside the closure so mode cycles don't need
  // to reinstall the hook. Cleanup clears the slot on unmount so a
  // follow-up App instance (tests, HMR) starts with a fresh registry.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: session / setEditMode / syncPendingCount are intentional closure captures — their updaters are stable and we don't want to tear down and rebuild the interceptor on unrelated state churn
  useEffect(() => {
    if (!tools || !codeMode) return;
    tools.setToolInterceptor(async (name, args) => {
      if (name !== "edit_file" && name !== "write_file") return null;
      const rawPath = typeof args.path === "string" ? args.path : "";
      if (!rawPath) return null;
      // Mirror filesystem.ts safePath's leading-slash tolerance so
      // `/src/foo.ts` doesn't get misrouted through applyEditBlock's
      // rootDir-escape check.
      let relPath = rawPath;
      while (relPath.startsWith("/") || relPath.startsWith("\\")) {
        relPath = relPath.slice(1);
      }
      if (!relPath) return null;

      // Read root via ref so a workspace swap (which runs reregisterTools
      // for read_file/run_command) is also visible to this interceptor —
      // otherwise edit_file writes to the OLD root while read_file looks in
      // the NEW one, producing ENOENT on the next read of a just-edited file.
      const rootForEdit = currentRootDirRef.current;
      let block: EditBlock;
      if (name === "edit_file") {
        const search = typeof args.search === "string" ? args.search : "";
        const replace = typeof args.replace === "string" ? args.replace : "";
        if (!search) return null; // let the tool fn surface the "empty search" error
        block = { path: relPath, search, replace, offset: 0 };
      } else {
        // write_file: capture the current content (if any) as SEARCH so
        // the queued block is a literal whole-file overwrite. For new
        // files SEARCH stays empty — applyEditBlock's create-new sentinel.
        const content = typeof args.content === "string" ? args.content : "";
        block = toWholeFileEditBlock(relPath, content, rootForEdit);
      }

      // Helper: apply the current block + record into history + arm
      // undo. Used by auto mode AND by the various "apply" branches
      // of the review modal so we don't duplicate the snapshot /
      // apply / banner logic.
      //
      // Does NOT push an info row to scrollback: the returned string
      // becomes the tool result AND the loop yields a `tool` event right
      // after — ToolCard renders that with the same text. Pushing here
      // would produce "result shown twice".
      const applyNow = (): string => {
        const snaps = snapshotBeforeEdits([block], rootForEdit);
        const results = applyEditBlocks([block], rootForEdit);
        const good = results.some((r) => r.status === "applied" || r.status === "created");
        if (good) {
          recordEdit("auto", [block], results, snaps);
          armUndoBanner(results);
        }
        return formatEditResults(results);
      };

      // yolo behaves like auto for edit application — the only extra
      // power yolo adds is bypassing shell confirmations (handled in
      // shell.ts via the allowAll getter).
      if (editModeRef.current === "auto" || editModeRef.current === "yolo") return applyNow();

      // review mode, tool-call path: suspend the interceptor on the
      // per-edit modal unless the user has already hit "apply-rest-of-
      // turn" earlier in the same turn. Text-form SEARCH/REPLACE blocks
      // in assistant_final still queue for end-of-turn preview — they
      // land all at once with no mid-stream opportunity to prompt.
      if (turnEditPolicyRef.current === "apply-all") return applyNow();

      const { choice, denyContext } = await new Promise<EditReviewResult>((resolveChoice) => {
        editReviewResolveRef.current = resolveChoice;
        setPendingEditReview(block);
      });
      // Clear the pending-review slot synchronously so a rapid-fire next
      // tool call doesn't race the React state settling.
      editReviewResolveRef.current = null;
      setPendingEditReview(null);

      if (choice === "reject") {
        const context = denyContext ? ` because: ${denyContext}` : "";
        log.pushInfo(`▸ rejected edit to ${block.path}${context}`);
        return `User rejected this edit to ${block.path}${context}. Don't retry the same SEARCH/REPLACE — either try a different approach or ask the user what they want instead.`;
      }
      if (choice === "apply-rest-of-turn") {
        turnEditPolicyRef.current = "apply-all";
        log.pushInfo("▸ auto-approving remaining edits for this turn");
        return applyNow();
      }
      if (choice === "flip-to-auto") {
        setEditMode("auto");
        log.pushInfo("▸ flipped to AUTO mode for the rest of the session (persisted)");
        return applyNow();
      }
      // "apply"
      return applyNow();
    });
    return () => {
      tools.setToolInterceptor(null);
    };
  }, [tools, codeMode, session, recordEdit, armUndoBanner, syncPendingCount, setEditMode]);

  /**
   * /apply callback — write pending edit blocks to disk, snapshot
   * beforehand so /undo still works, report per-file results. With
   * `indices` (1-based) only those blocks are applied; the rest stay
   * pending so the user can iterate on them. Empty / undefined indices
   * apply every pending block (the all-or-nothing original behavior).
   */
  const codeApply = useCallback(
    (indices?: readonly number[]): string => {
      if (!codeMode) return "not in code mode";
      const blocks = pendingEdits.current;
      if (blocks.length === 0) {
        return "nothing pending — the model hasn't proposed edits since the last /apply or /discard.";
      }
      const useSubset = indices !== undefined && indices.length > 0;
      const { selected, remaining } = useSubset
        ? partitionEdits(blocks, indices)
        : { selected: blocks, remaining: [] as EditBlock[] };
      if (selected.length === 0) {
        return "▸ no edits matched those indices — nothing applied. Use /apply with no args to commit them all.";
      }
      const snaps = snapshotBeforeEdits(selected, currentRootDir);
      const results = applyEditBlocks(selected, currentRootDir);
      const anyApplied = results.some((r) => r.status === "applied" || r.status === "created");
      if (anyApplied) recordEdit("review-apply", selected, results, snaps);
      pendingEdits.current = remaining;
      if (remaining.length === 0) clearPendingEdits(session ?? null);
      else savePendingEdits(session ?? null, remaining);
      syncPendingCount();
      const tail =
        remaining.length > 0
          ? `\n▸ ${remaining.length} edit block(s) still pending — /apply or /discard to clear them.`
          : "";
      return formatEditResults(results) + tail;
    },
    [codeMode, currentRootDir, session, syncPendingCount, recordEdit],
  );

  /**
   * /discard callback — forget the pending edits without touching
   * disk. With `indices` (1-based) only those blocks are dropped; the
   * rest stay pending. Empty / undefined indices drop everything.
   */
  const codeDiscard = useCallback(
    (indices?: readonly number[]): string => {
      const blocks = pendingEdits.current;
      if (blocks.length === 0) return "nothing pending to discard.";
      const useSubset = indices !== undefined && indices.length > 0;
      const { selected, remaining } = useSubset
        ? partitionEdits(blocks, indices)
        : { selected: blocks, remaining: [] as EditBlock[] };
      if (selected.length === 0) {
        return "▸ no edits matched those indices — nothing discarded.";
      }
      pendingEdits.current = remaining;
      if (remaining.length === 0) clearPendingEdits(session ?? null);
      else savePendingEdits(session ?? null, remaining);
      syncPendingCount();
      const tail =
        remaining.length > 0
          ? `  (${remaining.length} block(s) still pending)`
          : ". Nothing was written to disk.";
      return `▸ discarded ${selected.length} pending edit block(s)${tail}`;
    },
    [session, syncPendingCount],
  );

  const prefixHash = loop.prefix.fingerprint;

  const writeTranscript = useCallback(
    (ev: LoopEvent) => {
      const stream = transcriptRef.current;
      if (!stream) return;
      writeRecord(stream, recordFromLoopEvent(ev, { model, prefixHash }));
    },
    [model, prefixHash],
  );

  /**
   * Toggle plan mode on the local state AND on the ToolRegistry. The
   * registry's copy is what actually gates dispatch; the local state
   * drives the StatsPanel indicator and slash ergonomics. Kept in sync
   * by funneling every toggle through this setter.
   */
  const togglePlanMode = useCallback(
    (on: boolean) => {
      setPlanMode(on);
      tools?.setPlanMode(on);
    },
    [tools],
  );

  /** Clear the pending-plan picker state; safe to call unconditionally. */
  const clearPendingPlan = useCallback(() => {
    setPendingPlan(null);
  }, []);

  /**
   * Cancel the active /loop. Centralized so every cancel-trigger
   * (explicit /loop stop, Esc, /clear, /new, exit, the very first
   * user-typed prompt while a loop is active) goes through one path.
   * Idempotent — calling with no active loop is a no-op.
   */
  const stopLoop = useCallback(() => {
    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }
    const cur = activeLoopRef.current;
    if (!cur) return;
    setActiveLoop(null);
    log.pushInfo(`▸ loop stopped (after ${cur.iter} iter${cur.iter === 1 ? "" : "s"}).`);
  }, [log]);

  /**
   * Start a new /loop. Replaces any prior loop. The actual timer is
   * scheduled by the useEffect downstream that watches `activeLoop`.
   */
  const startLoop = useCallback((intervalMs: number, prompt: string) => {
    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }
    setActiveLoop({
      prompt,
      intervalMs,
      nextFireAt: Date.now() + intervalMs,
      iter: 0,
    });
  }, []);

  /**
   * Mount the per-block walkthrough modal against the pending-edits
   * queue. Returns the info text the slash handler should display.
   * No-op (with explanatory message) when nothing is pending or we're
   * not in code mode.
   */
  const startWalkthrough = useCallback((): string => {
    if (!codeMode) {
      return "/walk is only available inside `reasonix code`.";
    }
    if (pendingEdits.current.length === 0) {
      return "nothing pending — nothing to walk through.";
    }
    setWalkthroughActive(true);
    return `▸ walking ${pendingEdits.current.length} edit block(s) — y apply · n reject · a apply rest · A flip to AUTO · Esc cancels (keeps remaining queued).`;
  }, [codeMode]);

  // Embedded dashboard server lifecycle. Boot is async (server has to
  // bind a port + read static assets); the slash handler kicks this
  // off and reads the URL out of `dashboardRef` once the promise
  // resolves. Tear-down is also async but cheap — close drains
  // in-flight requests within a 1s grace window.
  const startDashboard = useCallback(async (): Promise<string> => {
    if (dashboardRef.current) return dashboardRef.current.url;
    if (dashboardStartingRef.current) return dashboardStartingRef.current;
    const startup = (async () => {
      const handle = await startDashboardServer({
        mode: "attached",
        configPath: defaultConfigPath(),
        usageLogPath: defaultUsageLogPath(),
        loop,
        tools,
        mcpServers,
        getCurrentCwd: () => (codeMode ? currentRootDirRef.current : undefined),
        getEditMode: () => (codeMode ? editModeRef.current : undefined),
        getPlanMode: () => planModeRef.current,
        getPendingEditCount: () => pendingEdits.current.length,
        getLatestVersion: () => latestVersionRef.current,
        getSessionName: () => session ?? null,
        setEditMode: (m: EditMode) => {
          setEditMode(m);
          editModeRef.current = m;
          saveEditMode(m);
          return m;
        },
        setPlanMode: (on: boolean) => {
          if (codeMode) togglePlanMode(on);
        },
        applyPresetLive: (name: string) => {
          const settings = resolvePreset(name as PresetName);
          loop.configure({
            model: settings.model,
            autoEscalate: settings.autoEscalate,
            reasoningEffort: settings.reasoningEffort,
          });
          const canonical: "auto" | "flash" | "pro" =
            settings.model === "deepseek-v4-pro" ? "pro" : settings.autoEscalate ? "auto" : "flash";
          setPreset(canonical);
        },
        applyEffortLive: (effort) => {
          loop.configure({ reasoningEffort: effort });
        },
        // ---------- Chat bridge ----------
        getMessages: (): DashboardMessage[] =>
          cardsToDashboardMessages(agentStore.getState().cards),
        subscribeEvents: (handler) => {
          eventSubscribersRef.current.add(handler);
          return () => {
            eventSubscribersRef.current.delete(handler);
          };
        },
        submitPrompt: (text: string): SubmitResult => {
          if (busyRef.current) {
            return { accepted: false, reason: "loop is busy with a turn" };
          }
          const fn = handleSubmitRef.current;
          if (!fn) return { accepted: false, reason: "TUI not ready" };
          // Fire-and-forget — handleSubmit drives the loop event stream
          // which the web sees via SSE. We don't await it here because
          // a turn can take minutes; the HTTP request would time out.
          fn(text).catch(() => undefined);
          return { accepted: true };
        },
        abortTurn: () => {
          if (busyRef.current) loop.abort();
        },
        isBusy: () => busyRef.current,
        getStats: () => {
          // Pull from the loop's live aggregator (same source the TUI's
          // StatsPanel reads). `balance` comes from useSessionInfo via a
          // ref-mirror so this callback stays cheap.
          const s = loop.stats.summary();
          const ctxCap = DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS;
          return {
            turns: s.turns,
            totalCostUsd: s.totalCostUsd,
            lastTurnCostUsd: s.lastTurnCostUsd,
            totalInputCostUsd: s.totalInputCostUsd,
            totalOutputCostUsd: s.totalOutputCostUsd,
            cacheHitRatio: s.cacheHitRatio,
            lastPromptTokens: s.lastPromptTokens,
            contextCapTokens: ctxCap,
            // useSessionInfo's Balance is a flat { currency, total }; the
            // dashboard wire shape is the richer DeepSeek BalanceInfo
            // array (granted / topped_up split). Convert as a single-
            // entry array so the SPA always reads `balance[0]` shape.
            balance: balanceRef.current
              ? [
                  {
                    currency: balanceRef.current.currency,
                    total_balance: String(balanceRef.current.total),
                  },
                ]
              : null,
          };
        },
        // ---------- Modal mirroring ----------
        getActiveModal: (): ActiveModal | null => {
          // Probe the live state via refs in priority order — only one
          // modal can be up at a time per App invariant.
          const ps = pendingShell;
          if (ps) {
            return {
              kind: "shell",
              command: ps.command,
              allowPrefix: derivePrefix(ps.command),
              shellKind: ps.kind,
            };
          }
          const pc = pendingChoice;
          if (pc) {
            return {
              kind: "choice",
              question: pc.question,
              options: pc.options,
              allowCustom: pc.allowCustom,
            };
          }
          if (pendingPlanRef.current) {
            return { kind: "plan", body: pendingPlanRef.current };
          }
          const er = pendingEditReview;
          if (er) {
            return {
              kind: "edit-review",
              path: er.path,
              search: er.search ?? "",
              replace: er.replace ?? "",
              preview: (er.search || er.replace || "").split("\n").slice(0, 12).join("\n"),
              total: pendingEdits.current.length,
              remaining: pendingEdits.current.length,
            };
          }
          if (pendingCheckpoint) {
            return {
              kind: "checkpoint",
              stepId: pendingCheckpoint.stepId,
              title: pendingCheckpoint.title,
              completed: pendingCheckpoint.completed,
              total: pendingCheckpoint.total,
            };
          }
          if (pendingRevision) {
            return {
              kind: "revision",
              reason: pendingRevision.reason,
              remainingSteps: pendingRevision.remainingSteps.map((s) => ({
                id: s.id,
                title: s.title,
                action: s.action,
                ...(s.risk ? { risk: s.risk } : {}),
              })),
              ...(pendingRevision.summary ? { summary: pendingRevision.summary } : {}),
            };
          }
          return null;
        },
        resolveShellConfirm: (choice) => {
          const fn = handleShellConfirmRef.current;
          if (fn) fn(choice).catch(() => undefined);
        },
        resolveChoiceConfirm: (choice) => {
          const fn = handleChoiceConfirmRef.current;
          if (fn) fn(choice).catch(() => undefined);
        },
        resolvePlanConfirm: (choice, text) => {
          if (choice === "cancel") {
            handlePlanConfirmRef.current("cancel").catch(() => undefined);
            return;
          }
          const plan = pendingPlanRef.current ?? "";
          // Bypass the picker → input two-step on web. The override
          // form of handleStagedInputSubmit takes the plan + mode
          // directly; behaviour matches the TUI's "user typed feedback +
          // pressed Enter" path.
          handleStagedInputSubmitRef
            .current(text ?? "", { plan, mode: choice })
            .catch(() => undefined);
        },
        resolveEditReview: (choice) => {
          const resolve = editReviewResolveRef.current;
          if (resolve) {
            editReviewResolveRef.current = null;
            setPendingEditReview(null);
            resolve({ choice, denyContext: undefined });
          }
        },
        resolveCheckpointConfirm: (choice, text) => {
          // Web's "revise" path sends feedback in one shot; we hand the
          // current pending checkpoint to the submit handler directly,
          // skipping the TUI's staged-input two-step. continue/stop fall
          // through to the regular picker handler.
          if (choice === "revise" && typeof text === "string") {
            const snap = pendingCheckpoint;
            setPendingCheckpoint(null);
            if (!snap) return;
            handleCheckpointReviseSubmitRef.current(text, snap).catch(() => undefined);
            return;
          }
          handleCheckpointConfirmRef.current(choice).catch(() => undefined);
        },
        resolveReviseConfirm: (choice) => {
          handleReviseConfirmRef.current(choice).catch(() => undefined);
        },
        // ---------- v0.14 mutation surface ----------
        reloadHooks: () => {
          const fresh = loadHooks({
            projectRoot: codeMode ? currentRootDirRef.current : undefined,
          });
          setHookList(fresh);
          return fresh.length;
        },
        addToolToPrefix: (spec) => loop.prefix.addTool(spec),
      });
      dashboardRef.current = handle;
      setDashboardUrlState(handle.url);
      return handle.url;
    })();
    dashboardStartingRef.current = startup;
    try {
      return await startup;
    } finally {
      dashboardStartingRef.current = null;
    }
  }, [
    loop,
    tools,
    mcpServers,
    codeMode,
    session,
    togglePlanMode,
    pendingShell,
    pendingChoice,
    pendingEditReview,
    pendingCheckpoint,
    pendingRevision,
    agentStore,
  ]);

  const stopDashboard = useCallback(async (): Promise<void> => {
    const h = dashboardRef.current;
    if (!h) return;
    dashboardRef.current = null;
    setDashboardUrlState(null);
    try {
      await h.close();
    } catch {
      /* swallow — server going down is best-effort */
    }
    log.pushInfo("▸ dashboard stopped.");
  }, [log]);

  const getDashboardUrl = useCallback((): string | null => {
    return dashboardRef.current?.url ?? null;
  }, []);

  // Mirror of the dashboard URL into React state so the StatsPanel
  // header can render a clickable pill the moment the server is up.
  // Updated by both the auto-start effect below and the explicit
  // /dashboard slash path (via startDashboard).
  const [dashboardUrl, setDashboardUrlState] = useState<string | null>(null);

  // Auto-start the dashboard once the TUI is mounted unless the user
  // opted out with --no-dashboard. The whole point is discoverability:
  // most users had no idea /dashboard existed, so the URL needs to be
  // visible from the first render. startDashboard updates the React
  // state itself, so we just fire-and-forget. Failures stay silent —
  // a missing dashboard never blocks the TUI.
  useEffect(() => {
    if (noDashboard) return;
    if (dashboardRef.current) return;
    startDashboard().catch((err) => {
      // Auto-start failure surfaces as a visible warn row. The URL
      // itself is shown on the welcome card (when the server is up),
      // so silence here would leave the user with no way to know the
      // web UI is unreachable — port already in use, permission
      // denied, etc. Don't block the TUI; everything else keeps working.
      const reason = err instanceof Error ? err.message : String(err);
      log.pushInfo(
        `▲ dashboard auto-start failed (${reason}) — try /dashboard, or pass --no-dashboard to silence`,
      );
    });
  }, [noDashboard, startDashboard, log]);

  // Tear the dashboard down on unmount so the port doesn't leak when
  // the TUI exits via /exit, Ctrl+C, etc.
  useEffect(() => {
    return () => {
      const h = dashboardRef.current;
      if (h) {
        dashboardRef.current = null;
        h.close().catch(() => undefined);
      }
    };
  }, []);

  /**
   * onChoose for the walkthrough EditConfirm. Each pick mutates
   * pendingEdits via the existing codeApply/codeDiscard helpers, which
   * also bump pendingTick → the modal re-renders with the next block.
   * When no blocks remain, the modal unmounts.
   */
  const handleWalkChoice = useCallback(
    (choice: EditReviewChoice) => {
      if (choice === "apply") {
        log.pushInfo(codeApply([1]));
      } else if (choice === "reject") {
        log.pushInfo(codeDiscard([1]));
      } else if (choice === "apply-rest-of-turn") {
        // "apply rest" inside a walkthrough = commit every remaining
        // block at once, then exit. Same end state as if the user had
        // typed `/apply` outside the walk.
        log.pushInfo(codeApply());
        setWalkthroughActive(false);
        return;
      } else if (choice === "flip-to-auto") {
        // Flip the gate first, then apply the current block, then exit
        // the walk. Remaining blocks stay pending — the user can keep
        // walking via /walk again or commit them with /apply.
        setEditMode("auto");
        saveEditMode("auto");
        log.pushInfo(codeApply([1]));
        log.pushInfo("▸ flipped to AUTO mode — future edits will apply immediately. Walk exited.");
        setWalkthroughActive(false);
        return;
      }
      // After a per-block apply/reject, check if the queue is empty
      // (codeApply/codeDiscard updated pendingEdits.current). If so,
      // exit; otherwise stay mounted and EditConfirm re-renders against
      // the new first block thanks to pendingTick.
      if (pendingEdits.current.length === 0) setWalkthroughActive(false);
    },
    [codeApply, codeDiscard, log],
  );

  /** Snapshot for the `/loop` (no-arg) status branch. */
  const getLoopStatus = useCallback(() => {
    const cur = activeLoopRef.current;
    if (!cur) return null;
    return {
      prompt: cur.prompt,
      intervalMs: cur.intervalMs,
      iter: cur.iter,
      nextFireMs: Math.max(0, cur.nextFireAt - Date.now()),
    };
  }, []);

  const handleSubmit = useCallback(
    async (raw: string) => {
      let text = raw.trim();
      if (!text) return;
      // Cancel-on-user-input: any user-typed submit cancels an active
      // /loop, regardless of busy state. Loop-fired submits set the
      // `loopFiringRef` flag so the timer's own re-submit doesn't
      // self-cancel.
      if (activeLoopRef.current && !loopFiringRef.current) {
        stopLoop();
      }
      loopFiringRef.current = false;
      if (busy) return;

      // @-mention picker intercept. When the picker is open (trailing
      // `@…` with file matches), Enter substitutes the highlighted
      // path INTO the buffer and does NOT submit — the user almost
      // always types more after a mention ("look at @file.ts and…").
      // Substituting adds a trailing space which dismisses the picker,
      // so the next Enter submits normally.
      if (atMatches && atMatches.length > 0 && atPicker) {
        const sel = atMatches[atSelected] ?? atMatches[0];
        if (sel) {
          pickAtMention(sel);
          return;
        }
      }

      // Slash-argument picker intercept — same shape as @-picker. For
      // file pickers (/edit) we splice + trailing space so the user
      // keeps typing the instruction. For enum pickers (/preset,
      // /model, /plan, …) we splice without trailing space; those
      // commands take no further args, so the user presses Enter a
      // second time to run.
      if (slashArgMatches && slashArgMatches.length > 0 && slashArgContext) {
        const sel = slashArgMatches[slashArgSelected] ?? slashArgMatches[0];
        if (sel) {
          pickSlashArg(sel);
          return;
        }
      }

      // Slash auto-complete on Enter. When the user typed a prefix
      // (e.g. "/he") and the suggestion list is visible, substitute
      // the highlighted match so Enter runs it — same effect as Tab
      // + Enter, one keystroke less. Skip substitution if the user
      // already typed a full, exact command name (respect verbatim
      // input when they know what they want).
      if (text.startsWith("/") && !text.includes(" ")) {
        const typed = text.slice(1).toLowerCase();
        const matches = suggestSlashCommands(typed, !!codeMode);
        const exact = matches.find((m) => m.cmd === typed);
        if (!exact && matches.length > 0) {
          const chosen = matches[slashSelected] ?? matches[0];
          if (chosen) text = `/${chosen.cmd}`;
        }
      }

      setInput("");
      historyCursor.current = -1;

      // Y/N fast-path when edits are pending. One keystroke is all it
      // takes to commit or drop — matches the muscle memory of `git
      // add -p` / most prompts. Deliberately scoped: only when there
      // ARE pending edits, so "y" as a normal message still works
      // when nothing's waiting.
      if (codeMode && pendingEdits.current.length > 0 && (text === "y" || text === "n")) {
        log.pushInfo(text === "y" ? codeApply() : codeDiscard());
        promptHistory.current.push(text);
        return;
      }

      // Hash mode — `#note` (project) and `#g note` (global) append to
      // a REASONIX.md so future sessions pin the note in the immutable
      // prefix. No model round-trip. `\#literal` escape falls through to
      // normal submission with the backslash stripped so the model sees
      // `#literal` verbatim.
      const hashParse = detectHashMemory(text);
      if (hashParse?.kind === "memory" || hashParse?.kind === "memory-global") {
        const isGlobal = hashParse.kind === "memory-global";
        const memRoot = currentRootDir;
        promptHistory.current.push(text);
        try {
          const result = isGlobal
            ? appendGlobalMemory(hashParse.note)
            : appendProjectMemory(memRoot, hashParse.note);
          const verb = result.created ? "created" : "appended to";
          const scopeTag = isGlobal ? "global" : "project";
          log.pushInfo(`▸ noted (${scopeTag}) — ${verb} ${result.path}`);
        } catch (err) {
          log.pushWarning("# memory write failed", (err as Error).message);
        }
        return;
      }
      if (hashParse?.kind === "escape") {
        // Replace the working buffer with the de-escaped form. We don't
        // recurse into handleSubmit to avoid the "still busy" race —
        // just rewrite `text` and let the rest of the pipeline (bang /
        // slash / model) see the literal prompt.
        text = hashParse.text;
      }

      // Bash mode — `!cmd` runs a shell command in the sandbox root
      // immediately (no allowlist gate: user-typed = explicit consent),
      // surfaces the formatted output in the Historical log, and
      // persists a user-role message so the next model turn sees what
      // happened AND the bang exchange survives session resume.
      const bangCmd = detectBangCommand(text);
      if (bangCmd !== null) {
        const bangRoot = currentRootDir;
        promptHistory.current.push(text);
        log.pushUser(text);
        setBusy(true);
        try {
          const result = await runCommand(bangCmd, {
            cwd: bangRoot,
            timeoutSec: 60,
            maxOutputChars: 32_000,
          });
          const formatted = formatCommandResult(bangCmd, result);
          log.pushInfo(formatted);
          loop.appendAndPersist({
            role: "user",
            content: formatBangUserMessage(bangCmd, formatted),
          });
        } catch (err) {
          log.pushWarning("! command failed", (err as Error).message);
        } finally {
          setBusy(false);
        }
        return;
      }

      // MCP resource / prompt browsers — async calls that don't fit the
      // synchronous handleSlash shape, so we intercept the exact command
      // forms here. The slash-command registry still lists them (for
      // /help + argument-level picker completion), but this branch is
      // what actually runs the read/fetch.
      const mcpBrowseMatch = /^\/(resource|prompt)(?:\s+([\s\S]*))?$/.exec(text);
      if (mcpBrowseMatch) {
        const kind = mcpBrowseMatch[1] as "resource" | "prompt";
        const arg = mcpBrowseMatch[2]?.trim() ?? "";
        promptHistory.current.push(text);
        log.pushUser(text);
        await handleMcpBrowseSlash(kind, arg, mcpServers ?? [], log);
        return;
      }

      const slash = parseSlash(text);
      if (slash) {
        const result = handleSlash(slash.cmd, slash.args, loop, {
          mcpSpecs,
          mcpServers,
          codeUndo: codeMode ? codeUndo : undefined,
          codeApply: codeMode ? codeApply : undefined,
          codeDiscard: codeMode ? codeDiscard : undefined,
          codeHistory: codeMode ? codeHistory : undefined,
          codeShowEdit: codeMode ? codeShowEdit : undefined,
          codeRoot: codeMode ? currentRootDir : undefined,
          pendingEditCount: codeMode ? pendingEdits.current.length : undefined,
          toolHistory: () => toolHistoryRef.current,
          memoryRoot: currentRootDir,
          planMode,
          setPlanMode: codeMode ? togglePlanMode : undefined,
          clearPendingPlan: codeMode ? clearPendingPlan : undefined,
          editMode: codeMode ? editMode : undefined,
          setEditMode: codeMode ? setEditMode : undefined,
          touchedFiles: codeMode
            ? () => {
                // Union of (files in completed/undone edit batches) +
                // (paths queued in pendingEdits awaiting /apply). Both
                // represent surface area the user might want to roll
                // back later.
                const set = new Set<string>(touchedPaths());
                for (const b of pendingEdits.current) set.add(b.path);
                return [...set];
              }
            : undefined,
          armPro: () => {
            loop.armProForNextTurn();
            setProArmed(true);
          },
          disarmPro: () => {
            loop.disarmPro();
            setProArmed(false);
          },
          startLoop,
          stopLoop,
          getLoopStatus,
          startWalkthrough: codeMode ? startWalkthrough : undefined,
          startDashboard,
          stopDashboard,
          getDashboardUrl,
          jobs: codeMode?.jobs,
          postInfo: (text: string) => log.pushInfo(text),
          postDoctor: (checks) => log.showDoctor(checks),
          postUsage: (args) => log.showUsageVerbose(args),
          reloadHooks: () => {
            const fresh = loadHooks({ projectRoot: codeMode ? currentRootDir : undefined });
            setHookList(fresh);
            return fresh.length;
          },
          latestVersion,
          refreshLatestVersion,
          models,
          refreshModels,
        });
        if (result.openSessionsPicker) {
          setSessionsPickerList(listSessionsForWorkspace(currentRootDir));
          setPendingSessionsPicker(true);
          promptHistory.current.push(text);
          return;
        }
        if (result.openMcpBrowser) {
          setPendingMcpBrowser(true);
          promptHistory.current.push(text);
          return;
        }
        const outcome = applySlashResult(result, {
          log,
          stdoutWrite: (chunk) => stdout?.write(chunk),
          pendingEdits,
          syncPendingCount,
          session: session ?? null,
          codeModeOn: !!codeMode,
          activeLoopRef,
          stopLoop,
          quitProcess,
          promptHistory,
          text,
        });
        if (outcome.kind === "resubmit") {
          text = outcome.text;
        } else {
          return;
        }
      }

      // UserPromptSubmit hooks. Exit code 2 from any matching hook
      // drops the message entirely (the user's text never reaches
      // the model). Other non-zero exits surface as warning rows but
      // the prompt still goes through. We render every non-pass
      // outcome's stderr inline so a "blocked" choice has a visible
      // explanation.
      if (hookList.some((h) => h.event === "UserPromptSubmit")) {
        const promptReport = await runHooks({
          hooks: hookList,
          payload: { event: "UserPromptSubmit", cwd: currentRootDir, prompt: text },
        });
        for (const o of promptReport.outcomes) {
          if (o.decision === "pass") continue;
          log.pushWarning("UserPromptSubmit hook", formatHookOutcomeMessage(o));
        }
        if (promptReport.blocked) return;
      }

      // Large pastes (stack traces, log dumps, file contents) get a
      // collapsed preview in scrollback; the model still receives the full
      // text below via modelInput.
      promptHistory.current.push(text);
      const pasteDisplay = formatLongPaste(text);
      const userId = log.pushUser(pasteDisplay.displayText);
      broadcastDashboardEvent({ kind: "user", id: userId, text });
      if (session) {
        const existing = loadSessionMeta(session);
        const patch: Parameters<typeof patchSessionMeta>[1] = {};
        if (!existing.summary) patch.summary = text.replace(/\s+/g, " ").slice(0, 80);
        if (!existing.branch) patch.branch = detectGitBranch(currentRootDir);
        if (!existing.workspace) patch.workspace = currentRootDir;
        if (Object.keys(patch).length > 0) patchSessionMeta(session, patch);
      }

      const assistantId = `a-${Date.now()}`;
      const streamRef: StreamingState = { id: assistantId, text: "", reasoning: "" };
      const contentBuf = { current: "" };
      const reasoningBuf = { current: "" };
      const translator = new TurnTranslator(log);
      let branchCardId: string | null = null;
      // Coalesces tool_call_delta events into one re-render per flush tick.
      const toolCallBuildBuf: {
        current: {
          name: string;
          chars: number;
          index?: number;
          readyCount?: number;
        } | null;
      } = {
        current: null,
      };

      setBusy(true);
      abortedThisTurn.current = false;
      // Seal the in-progress history entry so this turn's edits open
      // a new one — prior turns are preserved intact for /history and
      // `/undo` to walk back through independently.
      if (codeMode) sealCurrentEntry();
      // Reset per-turn edit policy so "apply-rest-of-turn" from the
      // previous turn doesn't carry over silently. User expects each
      // new prompt to start with the normal review gate re-armed.
      turnEditPolicyRef.current = "ask";
      // Pro badge state: if /pro was armed, this turn consumes it; the
      // loop emits a "⇧ /pro armed" warning we'll catch below. Clear
      // the armed mirror so the badge flips to "escalated" (via the
      // warning handler) rather than staying at "armed" during the
      // actual run.
      if (proArmed) {
        setProArmed(false);
        setTurnOnPro(true);
      } else {
        setTurnOnPro(false);
      }

      const flush = () => {
        if (!contentBuf.current && !reasoningBuf.current && !toolCallBuildBuf.current) return;
        translator.flushBuffers(reasoningBuf.current, contentBuf.current);
        streamRef.text += contentBuf.current;
        streamRef.reasoning += reasoningBuf.current;
        if (toolCallBuildBuf.current) {
          streamRef.toolCallBuild = toolCallBuildBuf.current;
        }
        contentBuf.current = "";
        reasoningBuf.current = "";
        toolCallBuildBuf.current = null;
      };
      // In PLAIN mode the streaming row is suppressed, so flushing into
      // streamRef does no visible work — skip the interval entirely.
      const timer = PLAIN_UI ? null : setInterval(flush, FLUSH_INTERVAL_MS);

      // Expand `@path/to/file.ts` mentions in code mode: the model
      // gets the inlined content appended under a "Referenced files"
      // block; the Historical row above keeps the user's verbatim text
      // so the display doesn't balloon.
      let modelInput = text;
      if (codeMode) {
        const expanded = expandAtMentions(text, currentRootDir);
        if (expanded.expansions.length > 0) {
          modelInput = expanded.text;
          const inlined = expanded.expansions
            .filter((ex) => ex.ok)
            .map((ex) => `${ex.path} (${(ex.bytes ?? 0).toLocaleString()} bytes)`);
          const skipped = expanded.expansions
            .filter((ex) => !ex.ok)
            .map((ex) => `${ex.path} (${ex.skip})`);
          const parts: string[] = [];
          if (inlined.length > 0) parts.push(`inlined ${inlined.join(", ")}`);
          if (skipped.length > 0) parts.push(`skipped ${skipped.join(", ")}`);
          if (parts.length > 0) log.pushInfo(`▸ @mentions: ${parts.join("; ")}`);
        }
      }
      // Expand `@http(s)://...` URL mentions. Available in any mode (chat
      // OR code) since fetching a URL doesn't need a sandbox root. Awaits
      // the network sequentially across URLs — for a typical 1-2 URLs in
      // a prompt this is fine; if a user pastes 10 URLs the latency adds
      // up but their prompt is also already huge.
      if (/(?:^|\s)@https?:\/\//.test(text)) {
        try {
          const urlExpanded = await expandAtUrls(modelInput, {
            fetcher: webFetch,
            cache: atUrlCache.current,
          });
          if (urlExpanded.expansions.length > 0) {
            modelInput = urlExpanded.text;
            const inlined = urlExpanded.expansions
              .filter((ex) => ex.ok)
              .map((ex) => {
                const tag = ex.title ? `${ex.title} (${ex.url})` : ex.url;
                const trunc = ex.truncated ? " · truncated" : "";
                return `${tag} · ${(ex.chars ?? 0).toLocaleString()} chars${trunc}`;
              });
            const skipped = urlExpanded.expansions
              .filter((ex) => !ex.ok)
              .map((ex) => `${ex.url} (${ex.skip ?? "fetch-error"})`);
            const parts: string[] = [];
            if (inlined.length > 0) parts.push(`inlined ${inlined.join("; ")}`);
            if (skipped.length > 0) parts.push(`skipped ${skipped.join("; ")}`);
            if (parts.length > 0) log.pushInfo(`▸ @url: ${parts.join("; ")}`);
          }
        } catch (err) {
          // expandAtUrls itself only throws on misconfiguration (no
          // fetcher). Per-URL failures are surfaced via the skip path.
          log.pushWarning("@url expansion failed", (err as Error).message);
        }
      }

      try {
        for await (const ev of loop.step(modelInput)) {
          writeTranscript(ev);
          // Mirror to the kernel event log sidecar. Pure passthrough —
          // Eventizer holds the small state (turn boundary detection +
          // tool callId correlation) needed to translate LoopEvent
          // shape into typed Event variants. Sink + eventizer share the
          // App's lifetime; nothing reads the artifact yet (future
          // replay / projection consumers will).
          {
            const sink = eventSinkRef.current;
            const eventizer = eventizerRef.current;
            if (sink && eventizer) {
              const ctx = {
                model: ev.stats?.model ?? loop.model ?? model,
                prefixHash,
                reasoningEffort: loop.reasoningEffort ?? "max",
              };
              for (const out of eventizer.consume(ev, ctx)) sink.append(out);
            }
          }
          if (eventSubscribersRef.current.size > 0) {
            const dashMsg = loopEventToDashboard(ev, { assistantId });
            if (dashMsg) broadcastDashboardEvent(dashMsg);
          }
          // Status lines are transient — any primary event (streaming
          // starts, a tool fires, etc.) means whatever we were waiting
          // FOR has now arrived, so drop the hint. We do this uniformly
          // at the top of the loop body for every role except "status"
          // itself (which SETS the line).
          if (ev.role !== "status") {
            setStatusLine((cur) => (cur ? null : cur));
          }
          if (ev.role === "status") {
            setStatusLine(ev.content);
          } else if (ev.role === "assistant_delta") {
            if (ev.content) contentBuf.current += ev.content;
            if (ev.reasoningDelta) reasoningBuf.current += ev.reasoningDelta;
          } else if (ev.role === "tool_call_delta") {
            if (ev.toolName) {
              toolCallBuildBuf.current = {
                name: ev.toolName,
                chars: ev.toolCallArgsChars ?? 0,
                index: ev.toolCallIndex,
                readyCount: ev.toolCallReadyCount,
              };
            }
          } else if (ev.role === "branch_start") {
            if (ev.branchProgress) {
              branchCardId = log.startBranch(ev.branchProgress.total);
            }
          } else if (ev.role === "branch_progress") {
            if (branchCardId && ev.branchProgress) {
              log.updateBranch(branchCardId, ev.branchProgress);
            }
          } else if (ev.role === "branch_done") {
            if (branchCardId) {
              log.endBranch(branchCardId);
              branchCardId = null;
            }
          } else if (ev.role === "assistant_final") {
            handleAssistantFinal(ev, {
              flush,
              translator,
              streamRef,
              contentBuf,
              reasoningBuf,
              toolCallBuildBuf,
              assistantId,
              setSummary,
              log,
              broadcastDashboardEvent,
              getSessionSummary: () => loop.stats.summary(),
              session: session ?? null,
              assistantIterCounter,
              codeModeOn: !!codeMode,
              currentRootDir,
              editModeRef,
              recordEdit,
              armUndoBanner,
              pendingEdits,
              syncPendingCount,
              ctxMax: DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS,
            });
            if (session) {
              const m = loadSessionMeta(session);
              const cost = (m.totalCostUsd ?? 0) + (ev.stats?.cost ?? 0);
              const turn = (m.turnCount ?? 0) + 1;
              patchSessionMeta(session, { totalCostUsd: cost, turnCount: turn });
            }
          } else if (ev.role === "tool_start") {
            handleToolStart(ev, {
              setOngoingTool,
              setToolProgress,
              toolStartedAtRef,
              translator,
              codeModeOn: !!codeMode,
              recordRecentFile,
            });
          } else if (ev.role === "tool") {
            handleToolEvent(ev, {
              flush,
              translator,
              setOngoingTool,
              setToolProgress,
              toolStartedAtRef,
              toolHistoryRef,
              setPendingShell,
              setPendingPlan,
              setPendingRevision,
              setPendingChoice,
              setPendingCheckpoint,
              planStepsRef,
              completedStepIdsRef,
              planBodyRef,
              planSummaryRef,
              persistPlanState,
              log,
              session: session ?? null,
              codeModeOn: !!codeMode,
            });
          } else if (ev.role === "error") {
            handleErrorEvent(ev, { log });
          } else if (ev.role === "warning") {
            handleWarningEvent(ev, { log, setTurnOnPro });
          }
        }
        flush();

        // Stop hooks — turn has ended (or aborted). Block decisions are
        // meaningless past this point so we treat every non-pass as a
        // warning. Natural place for "after every turn, run the
        // formatter / lint / tests" automation.
        if (hookList.some((h) => h.event === "Stop")) {
          const stopReport = await runHooks({
            hooks: hookList,
            payload: {
              event: "Stop",
              cwd: currentRootDir,
              lastAssistantText: streamRef.text,
              turn: loop.stats.summary().turns,
            },
          });
          for (const o of stopReport.outcomes) {
            if (o.decision === "pass") continue;
            log.pushWarning("Stop hook", formatHookOutcomeMessage(o));
          }
        }
      } finally {
        if (timer) clearInterval(timer);
        // Esc aborted the turn — close any in-flight cards (streaming /
        // reasoning / tool / branch) so they leave the live region. Without
        // this, stranded done=false cards stick in CardStream's live tail.
        if (abortedThisTurn.current) {
          translator.abort();
          if (branchCardId) {
            log.endBranch(branchCardId, true);
            branchCardId = null;
          }
        }
        setOngoingTool(null);
        setToolProgress(null);
        setStatusLine(null);
        setSummary(loop.stats.summary());
        setBusy(false);
        // Clear pro-on-turn badge; armed-for-next-turn already cleared
        // at turn start when it was consumed.
        setTurnOnPro(false);
        // Refresh balance lazily — don't block the return.
        refreshBalance();
      }
    },
    [
      busy,
      clearPendingPlan,
      codeApply,
      codeDiscard,
      codeHistory,
      codeMode,
      codeShowEdit,
      codeUndo,
      currentRootDir,
      quitProcess,
      hookList,
      loop,
      latestVersion,
      mcpSpecs,
      mcpServers,
      models,
      planMode,
      session,
      slashSelected,
      atMatches,
      atPicker,
      atSelected,
      pickAtMention,
      recordRecentFile,
      slashArgMatches,
      slashArgContext,
      slashArgSelected,
      pickSlashArg,
      togglePlanMode,
      writeTranscript,
      recordEdit,
      armUndoBanner,
      sealCurrentEntry,
      editMode,
      syncPendingCount,
      refreshBalance,
      refreshLatestVersion,
      refreshModels,
      proArmed,
      persistPlanState,
      stdout,
      stopLoop,
      startLoop,
      getLoopStatus,
      startWalkthrough,
      startDashboard,
      stopDashboard,
      getDashboardUrl,
      broadcastDashboardEvent,
      touchedPaths,
      model,
      prefixHash,
      log,
    ],
  );

  // Mirror the latest handleSubmit so the /loop timer (set up below)
  // calls the freshest closure on each firing — config changes during
  // the loop (model, mode, etc.) take effect immediately.
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // /loop timer. Re-runs whenever activeLoop's `nextFireAt` shifts —
  // either because startLoop set a fresh schedule or because the
  // previous timer fired and bumped the next-fire time. Cleanup
  // clears the in-flight timer so a stopLoop / replacement doesn't
  // leak a fire after cancel.
  useEffect(() => {
    if (!activeLoop) return;
    const delay = Math.max(0, activeLoop.nextFireAt - Date.now());
    const timer = setTimeout(async () => {
      loopTimerRef.current = null;
      // Skip the firing entirely when a prior turn is still running.
      // Re-arm in 1s so the loop catches up the moment busy clears,
      // rather than waiting a full interval after a slow turn.
      if (busyRef.current) {
        setActiveLoop((cur) => (cur ? { ...cur, nextFireAt: Date.now() + 1000 } : cur));
        return;
      }
      const cur = activeLoopRef.current;
      if (!cur) return;
      const nextIter = cur.iter + 1;
      // Schedule the NEXT firing now (independent of how long this
      // turn takes). Keeps the cadence honest even when individual
      // turns are slow.
      setActiveLoop((c) =>
        c ? { ...c, iter: nextIter, nextFireAt: Date.now() + cur.intervalMs } : c,
      );
      log.pushInfo(`▸ /loop iter ${nextIter} → ${cur.prompt}`);
      loopFiringRef.current = true;
      try {
        await handleSubmitRef.current?.(cur.prompt);
      } catch {
        // Persistent submission errors → kill the loop rather than
        // spam the screen. User can re-issue /loop once they fix
        // whatever's wrong.
        stopLoop();
      } finally {
        loopFiringRef.current = false;
      }
    }, delay);
    loopTimerRef.current = timer;
    return () => clearTimeout(timer);
  }, [activeLoop, stopLoop, log]);

  const syntheticSubmit = useSyntheticSubmit({
    log,
    busy,
    loop,
    setQueuedSubmit,
    handleSubmit,
  });

  /**
   * ShellConfirm callback. Three outcomes, all of them ending with a
   * synthetic user message fed back into the loop so the model sees
   * what happened next turn:
   *   - deny → "I denied running X." and we move on.
   *   - run_once / always_allow → run the command inside the sandbox
   *     root, attach the formatted output as the user turn. In the
   *     always_allow case we also persist the derived prefix to
   *     config so next invocation auto-runs.
   */
  const handleShellConfirm = useCallback(
    async (choice: ShellConfirmChoice, denyContext?: string) => {
      const pending = pendingShell;
      if (!pending || !codeMode) return;
      const { command: cmd, kind } = pending;
      setPendingShell(null);

      let synthetic: string;
      if (choice === "deny") {
        const context = denyContext ? ` because: ${denyContext}` : "";
        log.pushInfo(`▸ denied: ${cmd}${context}`);
        synthetic = `I denied running \`${cmd}\`${context}. Please continue without running it.`;
      } else {
        if (choice === "always_allow") {
          const prefix = derivePrefix(cmd);
          addProjectShellAllowed(currentRootDir, prefix);
          log.pushInfo(`▸ always allowed "${prefix}" for ${currentRootDir}`);
        }
        log.pushInfo(
          kind === "run_background" ? `▸ starting (background): ${cmd}` : `▸ running: ${cmd}`,
        );
        if (kind === "run_background" && codeMode.jobs) {
          // JobRegistry spawn keeps the process running after this handler
          // resolves; the synthetic tells the model the job id for job_output
          // / stop_job follow-ups.
          try {
            const res = await codeMode.jobs.start(cmd, { cwd: currentRootDir });
            const preview = res.preview;
            const header = res.stillRunning
              ? `[job ${res.jobId} started · pid ${res.pid ?? "?"} · ${res.readyMatched ? "READY signal matched" : "running"}]`
              : res.exitCode !== null
                ? `[job ${res.jobId} exited during startup · exit ${res.exitCode}]`
                : `[job ${res.jobId} failed to start]`;
            const body = preview ? `${header}\n${preview}` : header;
            log.pushInfo(body);
            synthetic = `I approved the background spawn. ${header}\n\nStartup preview:\n\n${preview || "(no output yet)"}\n\nThe process is still running — use job_output to read newer logs, stop_job to halt it.`;
          } catch (err) {
            const msg = `$ ${cmd}\n[failed to start] ${(err as Error).message}`;
            log.pushInfo(msg);
            synthetic = `I approved the background spawn but it failed to start:\n\n${msg}`;
          }
        } else {
          // Foreground (run_command) — synchronous; waits for exit.
          let body: string;
          try {
            const res = await runCommand(cmd, { cwd: currentRootDir });
            body = formatCommandResult(cmd, res);
          } catch (err) {
            body = `$ ${cmd}\n[failed to spawn] ${(err as Error).message}`;
          }
          log.pushInfo(body);
          synthetic = `I ran the command you requested. Output:\n\n${body}`;
        }
      }

      await syntheticSubmit.submit(synthetic);
    },
    [pendingShell, codeMode, currentRootDir, syntheticSubmit, log],
  );

  // Drain the shell-confirm queue after the in-flight turn tears down.
  // React closure staleness means handleShellConfirm can't just await
  // the abort itself — this effect is the reliable edge detector.
  useEffect(() => {
    if (!busy && queuedSubmit !== null) {
      const text = queuedSubmit;
      setQueuedSubmit(null);
      void handleSubmit(text);
    }
  }, [busy, queuedSubmit, handleSubmit]);

  /**
   * PlanConfirm callback. Three outcomes, all ending with a synthetic
   * user message so the model sees the verdict on its next turn:
   *   - approve → exit plan mode, tell the model to implement now.
   *   - refine  → stay in plan mode, tell the model to revise.
   *   - cancel  → exit plan mode, tell the model to drop the plan.
   * Mirrors handleShellConfirm's busy-queue dance — if the turn is
   * still streaming "plan submitted, waiting" chatter when the user
   * picks, we abort it and queue the synthetic for the effect above.
   *
   * `approve` is also callable with no pending plan (via the
   * `/apply-plan` slash fallback, used when the model wrote a plan in
   * assistant text instead of calling submit_plan). In that case we
   * just flip plan mode off and push the implement-now message.
   */
  const handlePlanConfirm = useCallback(
    async (choice: PlanConfirmChoice) => {
      const hadPendingPlan = pendingPlan !== null;
      if (!hadPendingPlan && choice !== "approve") {
        // Refine / Cancel without a pending plan is a no-op; only the
        // /apply-plan fallback makes sense without one.
        return;
      }

      if (choice === "refine" || choice === "approve") {
        if (pendingPlan) {
          setStagedInput({ plan: pendingPlan, mode: choice });
          setPendingPlan(null);
        } else if (choice === "approve") {
          setStagedInput({ plan: "", mode: "approve" });
        }
        return;
      }

      if (choice === "revise") {
        if (pendingPlan) {
          setPendingReviseEditor(pendingPlan);
          setPendingPlan(null);
        }
        return;
      }

      // Cancel — no input needed, fire immediately.
      setPendingPlan(null);
      // Drop any structured plan state on disk too — the user explicitly
      // said this isn't the path they want, no point holding onto it.
      planStepsRef.current = null;
      completedStepIdsRef.current = new Set();
      planBodyRef.current = null;
      planSummaryRef.current = null;
      persistPlanState();
      togglePlanMode(false);
      agentStore.dispatch({ type: "plan.drop" });
      await syntheticSubmit.post({
        marker: "▸ plan cancelled",
        synthetic:
          "The plan was cancelled. Drop it entirely. Ask me what I actually want before proposing another plan or making any changes.",
      });
    },
    [pendingPlan, togglePlanMode, syntheticSubmit, persistPlanState, agentStore],
  );

  // Ref-wrapped stable alias. `handlePlanConfirm` has deps that churn
  // every turn (busy toggles while the model is still streaming its
  // wrap-up) — passing it directly to `React.memo(PlanConfirm)` breaks
  // the memo's shallow prop compare, so even without the ticker the
  // picker re-rendered on every parent state change. The ref keeps the
  // identity stable across the whole picker lifetime; the callback
  // itself always reads the latest closure via `.current`.
  const handlePlanConfirmRef = useRef(handlePlanConfirm);
  useEffect(() => {
    handlePlanConfirmRef.current = handlePlanConfirm;
  }, [handlePlanConfirm]);
  const stableHandlePlanConfirm = useCallback(
    async (choice: PlanConfirmChoice) => handlePlanConfirmRef.current(choice),
    [],
  );

  /**
   * Fired when the user submits feedback from the inline input. The
   * staged `mode` decides whether this is a refine or approve: refine
   * stays in plan mode and asks the model to revise; approve exits
   * plan mode and pushes the implement synthetic, with any user
   * guidance (answers to open questions, last-minute preferences)
   * included verbatim.
   */
  const handleStagedInputSubmit = useCallback(
    async (feedback: string, override?: { plan: string; mode: "refine" | "approve" }) => {
      // `override` lets the web `/dashboard` chat-bridge drive the same
      // dispatch path without first having to setStagedInput() (which
      // is async and would race the read below). When the override is
      // present we also clear pendingPlan ourselves since web flow
      // doesn't go through the picker → input two-step.
      const staged = override ?? stagedInput;
      if (override) {
        setPendingPlan(null);
      } else {
        setStagedInput(null);
      }
      if (!staged) return;
      const trimmed = feedback.trim();

      let synthetic: string;
      let marker: string;
      if (staged.mode === "approve") {
        togglePlanMode(false);
        if (trimmed) {
          synthetic = `The plan above has been approved. Implement it now. You are out of plan mode — use edit_file / write_file / run_command as needed.\n\nUser's additional instructions / answers to your open questions:\n\n${trimmed}\n\nFactor these in before the first edit. Stick to the plan unless you discover a concrete reason to deviate; if you do, tell me and wait for a response.`;
          marker = `▸ plan approved + instructions — ${trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed}`;
        } else {
          synthetic =
            "The plan above has been approved. Implement it now. You are out of plan mode — use edit_file / write_file / run_command as needed. If the plan listed open questions and I didn't answer them, default to the safest interpretation and call them out in your first reply. Don't fabricate preferences — if a question is truly unanswerable without me, stop and ask.";
          marker = "▸ plan approved — implementing";
        }
      } else {
        // refine
        if (trimmed) {
          synthetic = `The plan needs refinement. User feedback / answers:\n\n${trimmed}\n\nStay in plan mode — address the feedback (explore more if needed), then submit an improved submit_plan call. Don't propose a near-identical plan unless you explain why the feedback doesn't apply.`;
          marker = `▸ refining — ${trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed}`;
        } else {
          synthetic =
            "The plan needs refinement, but the user didn't give specifics. Ask them one or two concrete questions — scope, approach, file boundaries, or the risks you flagged — then wait for their answer before submitting an updated plan.";
          marker = "▸ refining — asking the model to clarify";
        }
      }

      await syntheticSubmit.post({ marker, synthetic });
    },
    [stagedInput, togglePlanMode, syntheticSubmit],
  );
  // Ref-mirror so startDashboard's resolvePlanConfirm closure can call
  // the latest function — handleStagedInputSubmit's deps churn on every
  // stagedInput change, which would freeze a captured reference.
  const handleStagedInputSubmitRef = useRef(handleStagedInputSubmit);
  useEffect(() => {
    handleStagedInputSubmitRef.current = handleStagedInputSubmit;
  }, [handleStagedInputSubmit]);

  /** Esc on the inline input — restore the picker without resuming. */
  const handleStagedInputCancel = useCallback(() => {
    if (stagedInput?.plan) setPendingPlan(stagedInput.plan);
    setStagedInput(null);
  }, [stagedInput]);

  /**
   * Checkpoint picker callback. Continue / Stop fire a synthetic user
   * message immediately; Revise defers to a feedback input so the user
   * can tell the model what to change before the next step.
   */
  const handleCheckpointConfirm = useCallback(
    async (choice: CheckpointChoice) => {
      const snap = pendingCheckpoint;
      if (!snap) return;
      setPendingCheckpoint(null);
      if (choice === "revise") {
        setStagedCheckpointRevise(snap);
        return;
      }
      // Auto file-snapshot per plan step so /restore can rewind to before this step ran.
      if (codeMode && choice === "continue") {
        const paths = touchedPaths();
        if (paths.length > 0) {
          try {
            const cpName = snap.title ? `${snap.stepId} · ${snap.title}` : snap.stepId;
            const meta = createCheckpoint({
              rootDir: codeMode.rootDir,
              name: cpName.slice(0, 60),
              paths,
              source: "auto-pre-restore",
            });
            log.pushInfo(
              `⛁ checkpoint saved · ${meta.id} · ${meta.fileCount} file${meta.fileCount === 1 ? "" : "s"} · /restore ${meta.id} to roll back this step`,
            );
          } catch {
            /* checkpoint failure is best-effort — don't block the step */
          }
        }
      }
      const label = snap.title ? `${snap.stepId} · ${snap.title}` : snap.stepId;
      const counter = snap.total > 0 ? ` (${snap.completed}/${snap.total})` : "";
      const { marker, synthetic } =
        choice === "continue"
          ? {
              marker: `▸ continuing after ${label}${counter}`,
              synthetic: `Step ${label} is complete. Proceed with the next step of the approved plan. If no steps remain, summarize the whole run.`,
            }
          : {
              marker: `▸ plan stopped at ${label}${counter}`,
              synthetic: `The user stopped the plan after step ${label}. Do not run any more steps and do not call any tools. Write a short summary of what was completed across all finished steps and what's left unfinished.`,
            };
      await syntheticSubmit.post({ marker, synthetic });
    },
    [pendingCheckpoint, syntheticSubmit, codeMode, touchedPaths, log],
  );

  // Same ref-wrap pattern as handlePlanConfirm — keeps the memo'd
  // PlanCheckpointConfirm from re-rendering on every parent tick.
  const handleCheckpointConfirmRef = useRef(handleCheckpointConfirm);
  useEffect(() => {
    handleCheckpointConfirmRef.current = handleCheckpointConfirm;
  }, [handleCheckpointConfirm]);
  const stableHandleCheckpointConfirm = useCallback(
    async (choice: CheckpointChoice) => handleCheckpointConfirmRef.current(choice),
    [],
  );

  /**
   * Revise feedback submitted — push a synthetic adjustment message.
   *
   * Accepts an optional snap override so the web's "revise + text in
   * one shot" path can pass the checkpoint snapshot directly without
   * waiting on a setStagedCheckpointRevise → re-render → ref-mirror
   * round trip. The TUI's two-step path passes no override and falls
   * back to the staged state populated by the picker.
   */
  const handleCheckpointReviseSubmit = useCallback(
    async (feedback: string, snapOverride?: typeof stagedCheckpointRevise) => {
      const snap = snapOverride ?? stagedCheckpointRevise;
      setStagedCheckpointRevise(null);
      if (!snap) return;
      const label = snap.title ? `${snap.stepId} · ${snap.title}` : snap.stepId;
      const trimmed = feedback.trim();
      const synthetic = trimmed
        ? `Step ${label} is complete. Before running the next step, adjust based on this user feedback:\n\n${trimmed}\n\nIf the feedback only tweaks how you execute (extra constraints, style preferences), continue with the updated guidance. If it changes which steps run (skip a step, swap two steps, add a new step), call \`revise_plan\` with the updated remainingSteps — that pops a diff picker the user can accept or reject. Only call submit_plan again if the entire approach has fundamentally changed.`
        : `Step ${label} is complete. Continue with the current plan.`;
      const marker = trimmed
        ? `▸ revising after ${label} — ${trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed}`
        : `▸ continuing after ${label}`;
      await syntheticSubmit.post({ marker, synthetic });
    },
    [stagedCheckpointRevise, syntheticSubmit],
  );

  /** Esc on the revise input — restore the checkpoint picker. */
  const handleCheckpointReviseCancel = useCallback(() => {
    const snap = stagedCheckpointRevise;
    setStagedCheckpointRevise(null);
    if (snap) setPendingCheckpoint(snap);
  }, [stagedCheckpointRevise]);

  /**
   * ChoiceConfirm callback. Pick fires a synthetic "user picked <id>"
   * and lets the model continue down that branch. Custom defers to a
   * free-form input. Cancel drops the question entirely.
   */
  const handleChoiceConfirm = useCallback(
    async (choice: ChoiceConfirmChoice) => {
      const snap = pendingChoice;
      if (!snap) return;
      setPendingChoice(null);
      if (choice.kind === "custom") {
        setStagedChoiceCustom(snap);
        return;
      }
      if (choice.kind === "cancel") {
        await syntheticSubmit.post({
          marker: "▸ choice cancelled",
          synthetic:
            "The user cancelled the choice. Don't act on any of the options you presented. Ask what they actually want before doing anything else.",
        });
        return;
      }
      const picked = snap.options.find((o) => o.id === choice.optionId);
      const label = picked ? `${picked.id} · ${picked.title}` : choice.optionId;
      await syntheticSubmit.post({
        marker: `▸ chose ${label}`,
        synthetic: `The user picked option ${choice.optionId}${picked ? ` ("${picked.title}")` : ""}. Proceed with that branch. Do not re-ask the same question.`,
      });
    },
    [pendingChoice, syntheticSubmit],
  );

  // Ref-wrap to keep ChoiceConfirm's React.memo from re-rendering on
  // every parent tick (same pattern as PlanConfirm / CheckpointConfirm).
  // Stable refs over the modal handlers — used by the web chat-bridge
  // to drive the same code path as a TUI button click without
  // dragging the handlers (and their ever-shifting deps) into
  // startDashboard's useCallback closure.
  const handleShellConfirmRef = useRef(handleShellConfirm);
  useEffect(() => {
    handleShellConfirmRef.current = handleShellConfirm;
  }, [handleShellConfirm]);
  // Ref-mirror of pendingPlan so the web's resolvePlanConfirm callback
  // (registered in startDashboard, frozen at boot) can read the live
  // body when the web resolves an approve/refine.
  const pendingPlanRef = useRef<string | null>(null);
  useEffect(() => {
    pendingPlanRef.current = pendingPlan;
  }, [pendingPlan]);
  const handleChoiceConfirmRef = useRef(handleChoiceConfirm);
  useEffect(() => {
    handleChoiceConfirmRef.current = handleChoiceConfirm;
  }, [handleChoiceConfirm]);
  const stableHandleChoiceConfirm = useCallback(
    async (choice: ChoiceConfirmChoice) => handleChoiceConfirmRef.current(choice),
    [],
  );
  // Ref-mirrors so the web's resolveXxx callbacks (registered in
  // startDashboard, frozen at boot) keep calling the latest handler.
  const handleCheckpointReviseSubmitRef = useRef(handleCheckpointReviseSubmit);
  useEffect(() => {
    handleCheckpointReviseSubmitRef.current = handleCheckpointReviseSubmit;
  }, [handleCheckpointReviseSubmit]);

  /** Custom free-form answer submitted — ship it as a synthetic message. */
  const handleChoiceCustomSubmit = useCallback(
    async (answer: string) => {
      setStagedChoiceCustom(null);
      const trimmed = answer.trim();
      const synthetic = trimmed
        ? `The user answered with a custom reply (none of the pre-defined options fit):\n\n${trimmed}\n\nRead it carefully and proceed — don't snap back to the options you listed unless the user's reply clearly maps to one.`
        : "The user pressed Enter without typing anything. Ask what they actually want.";
      const marker = trimmed
        ? `▸ custom answer — ${trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed}`
        : "▸ custom answer — (blank)";
      await syntheticSubmit.post({ marker, synthetic });
    },
    [syntheticSubmit],
  );

  /** Esc on the custom input — restore the choice picker. */
  const handleChoiceCustomCancel = useCallback(() => {
    const snap = stagedChoiceCustom;
    setStagedChoiceCustom(null);
    if (snap) setPendingChoice(snap);
  }, [stagedChoiceCustom]);

  /**
   * PlanReviseConfirm callback. Accept splices the new remaining
   * steps onto the done prefix and continues. Reject drops the
   * proposal and tells the model to stick with the original plan.
   */
  const handleReviseConfirm = useCallback(
    async (choice: ReviseChoice) => {
      const snap = pendingRevision;
      if (!snap) return;
      setPendingRevision(null);
      if (choice === "reject") {
        await syntheticSubmit.post({
          marker: "▸ revision rejected",
          synthetic:
            "The user rejected the proposed plan revision. Don't apply it. Continue executing the original plan from the next pending step. If you genuinely cannot proceed without the change, stop and explain in plain text why.",
        });
        return;
      }
      // Accept: keep the done-step prefix from the existing plan, replace
      // the rest with the proposed remainingSteps. completedStepIds
      // stays intact — done work isn't undone.
      const completed = completedStepIdsRef.current;
      const oldSteps = planStepsRef.current ?? [];
      const donePrefix = oldSteps.filter((s) => completed.has(s.id));
      const merged: PlanStep[] = [...donePrefix];
      for (const s of snap.remainingSteps) {
        if (completed.has(s.id)) continue; // already done — don't re-queue
        merged.push(s);
      }
      planStepsRef.current = merged;
      persistPlanState();
      const removedCount = oldSteps.filter(
        (s) => !completed.has(s.id) && !snap.remainingSteps.some((n) => n.id === s.id),
      ).length;
      const addedCount = snap.remainingSteps.filter(
        (s) => !oldSteps.some((o) => o.id === s.id),
      ).length;
      const marker = `▸ revision accepted — −${removedCount} +${addedCount}: ${snap.reason}`;
      const synthetic = `Revision accepted. The remaining plan is now:\n${snap.remainingSteps
        .map((s, i) => `  ${i + 1}. ${s.id} · ${s.title} — ${s.action}`)
        .join(
          "\n",
        )}\n\nContinue executing from the next pending step. Call mark_step_complete after each one as before.`;
      await syntheticSubmit.post({ marker, synthetic });
    },
    [pendingRevision, syntheticSubmit, persistPlanState],
  );

  // Ref-wrap to keep PlanReviseConfirm's React.memo from re-rendering.
  const handleReviseConfirmRef = useRef(handleReviseConfirm);
  useEffect(() => {
    handleReviseConfirmRef.current = handleReviseConfirm;
  }, [handleReviseConfirm]);
  const stableHandleReviseConfirm = useCallback(
    async (choice: ReviseChoice) => handleReviseConfirmRef.current(choice),
    [],
  );

  return (
    <>
      <TickerProvider
        disabled={
          PLAIN_UI ||
          isResizing ||
          !!pendingPlan ||
          !!pendingReviseEditor ||
          pendingSessionsPicker ||
          pendingMcpBrowser ||
          !!pendingShell ||
          !!pendingEditReview ||
          walkthroughActive ||
          !!pendingCheckpoint ||
          !!stagedCheckpointRevise ||
          !!pendingChoice ||
          !!stagedChoiceCustom ||
          !!pendingRevision ||
          // Idle gate: when nothing is actively happening, suspend the
          // 8Hz/1Hz heartbeats. The cursor blink, gradient pulse, and
          // spinner glyphs are pure cosmetics — running them at idle
          // forces Ink to repaint the screen ~8x/sec, which erases any
          // text selection the user has made in the terminal. With the
          // ticker paused, an idle TUI is byte-stable and shift-drag /
          // click-drag selections survive until something actually
          // changes (incoming stream, key press, modal popup).
          (!busy && !isStreaming)
        }
      >
        <ViewportBudgetProvider>
          <Box flexDirection="row">
            <Box flexDirection="column" flexGrow={1}>
              <Box flexDirection="column">
                <CardStream excludeId={activePlanCard?.id} />
                {/*
          Welcome card on the empty state. Visible only when nothing
          has happened yet (no past events, nothing in flight, no
          modal up). Removes the "what do I type?" friction without
          surviving past the first turn.
        */}
                {!hasConversation && !busy && !isStreaming ? (
                  <WelcomeBanner inCodeMode={!!codeMode} dashboardUrl={dashboardUrl} />
                ) : null}
                {/*
          Live rows are hidden while the ShellConfirm modal is up — the
          model's concurrent "please confirm" stream is noise the user
          doesn't need, and the picker shouldn't fight it for visual
          attention. They come back naturally once the user chooses and
          the next turn begins.
        */}
                {!PLAIN_UI &&
                !pendingShell &&
                !pendingPlan &&
                !pendingReviseEditor &&
                !pendingSessionsPicker &&
                !pendingMcpBrowser &&
                !stagedInput &&
                !pendingEditReview &&
                !pendingCheckpoint &&
                !stagedCheckpointRevise &&
                ongoingTool ? (
                  <OngoingToolRow tool={ongoingTool} progress={toolProgress} />
                ) : null}
                {!PLAIN_UI &&
                !pendingShell &&
                !pendingPlan &&
                !pendingReviseEditor &&
                !pendingSessionsPicker &&
                !pendingMcpBrowser &&
                !stagedInput &&
                !pendingEditReview &&
                !pendingCheckpoint &&
                !stagedCheckpointRevise &&
                subagentActivity ? (
                  <SubagentRow activity={subagentActivity} />
                ) : null}
                {!PLAIN_UI &&
                !pendingShell &&
                !pendingPlan &&
                !pendingReviseEditor &&
                !pendingSessionsPicker &&
                !pendingMcpBrowser &&
                !stagedInput &&
                !pendingEditReview &&
                !pendingCheckpoint &&
                !stagedCheckpointRevise &&
                !ongoingTool &&
                statusLine ? (
                  <ThinkingRow text={statusLine} />
                ) : null}
                {!PLAIN_UI &&
                undoBanner &&
                !pendingShell &&
                !pendingPlan &&
                !pendingReviseEditor &&
                !pendingSessionsPicker &&
                !pendingMcpBrowser &&
                !stagedInput &&
                !pendingEditReview &&
                !pendingCheckpoint &&
                !stagedCheckpointRevise &&
                !pendingChoice &&
                !stagedChoiceCustom &&
                !pendingRevision ? (
                  <UndoBanner banner={undoBanner} />
                ) : null}
                {/*
          Belt-and-suspenders fallback: if we're busy but NONE of the
          specific indicators (streaming, ongoingTool, statusLine) is
          visible, something is still happening — show a generic
          "processing…" so the user never stares at a silent ticker
          without a label. Catches micro-gaps between events that the
          targeted status lines don't cover.
        */}
                {!PLAIN_UI &&
                !pendingShell &&
                !pendingPlan &&
                !pendingReviseEditor &&
                !pendingSessionsPicker &&
                !pendingMcpBrowser &&
                !stagedInput &&
                !pendingEditReview &&
                !pendingCheckpoint &&
                !stagedCheckpointRevise &&
                busy &&
                !isStreaming &&
                !ongoingTool &&
                !statusLine ? (
                  <ThinkingRow text="processing…" />
                ) : null}
                <ToastRail />
              </Box>
              {!PLAIN_UI && activePlanCard ? (
                <Box flexDirection="column" marginY={1}>
                  <PlanCard card={activePlanCard} />
                </Box>
              ) : null}
              {stagedInput ? (
                <PlanRefineInput
                  mode={stagedInput.mode}
                  onSubmit={handleStagedInputSubmit}
                  onCancel={handleStagedInputCancel}
                />
              ) : stagedCheckpointRevise ? (
                <PlanRefineInput
                  mode="checkpoint-revise"
                  onSubmit={handleCheckpointReviseSubmit}
                  onCancel={handleCheckpointReviseCancel}
                />
              ) : stagedChoiceCustom ? (
                <PlanRefineInput
                  mode="choice-custom"
                  onSubmit={handleChoiceCustomSubmit}
                  onCancel={handleChoiceCustomCancel}
                />
              ) : pendingChoice ? (
                <ChoiceConfirm
                  question={pendingChoice.question}
                  options={pendingChoice.options}
                  allowCustom={pendingChoice.allowCustom}
                  onChoose={stableHandleChoiceConfirm}
                />
              ) : pendingRevision ? (
                <PlanReviseConfirm
                  reason={pendingRevision.reason}
                  oldRemaining={(planStepsRef.current ?? []).filter(
                    (s) => !completedStepIdsRef.current.has(s.id),
                  )}
                  newRemaining={pendingRevision.remainingSteps}
                  summary={pendingRevision.summary}
                  onChoose={stableHandleReviseConfirm}
                />
              ) : pendingCheckpoint ? (
                <PlanCheckpointConfirm
                  stepId={pendingCheckpoint.stepId}
                  title={pendingCheckpoint.title}
                  completed={pendingCheckpoint.completed}
                  total={pendingCheckpoint.total}
                  steps={planStepsRef.current ?? undefined}
                  completedStepIds={completedStepIdsRef.current}
                  onChoose={stableHandleCheckpointConfirm}
                />
              ) : pendingSessionsPicker ? (
                <SessionPicker
                  sessions={sessionsPickerList}
                  workspace={currentRootDir}
                  onChoose={(outcome) => {
                    if (outcome.kind === "open") {
                      setPendingSessionsPicker(false);
                      if (onSwitchSession) {
                        onSwitchSession(outcome.name);
                      } else {
                        log.pushInfo(
                          `▸ to switch to "${outcome.name}", quit and run: reasonix chat --session ${outcome.name}`,
                        );
                      }
                      return;
                    }
                    if (outcome.kind === "new") {
                      setPendingSessionsPicker(false);
                      if (onSwitchSession) {
                        onSwitchSession(undefined);
                      } else {
                        log.pushInfo(
                          "▸ to start a fresh session, quit and run: reasonix chat (no --session flag)",
                        );
                      }
                      return;
                    }
                    if (outcome.kind === "delete") {
                      deleteSession(outcome.name);
                      setSessionsPickerList(listSessionsForWorkspace(currentRootDir));
                      return;
                    }
                    if (outcome.kind === "rename") {
                      renameSession(outcome.name, outcome.newName);
                      setSessionsPickerList(listSessionsForWorkspace(currentRootDir));
                      return;
                    }
                    if (outcome.kind === "quit") {
                      setPendingSessionsPicker(false);
                    }
                  }}
                />
              ) : pendingMcpBrowser ? (
                <McpBrowser
                  servers={mcpServers ?? []}
                  configPath={defaultConfigPath()}
                  onClose={() => setPendingMcpBrowser(false)}
                  postInfo={(text) => log.pushInfo(text)}
                  applyAppend={(target, addedTools) => applyMcpAppend(loop, target, addedTools)}
                />
              ) : pendingPlan ? (
                <PlanConfirm
                  plan={pendingPlan}
                  steps={planStepsRef.current ?? undefined}
                  summary={planSummaryRef.current ?? undefined}
                  onChoose={stableHandlePlanConfirm}
                  projectRoot={currentRootDir}
                />
              ) : pendingReviseEditor ? (
                <PlanReviseEditor
                  steps={planStepsRef.current ?? []}
                  completedStepIds={completedStepIdsRef.current}
                  onAccept={(revised, skippedIds) => {
                    planStepsRef.current = revised;
                    for (const id of skippedIds) completedStepIdsRef.current.add(id);
                    persistPlanState();
                    const planText = pendingReviseEditor;
                    setPendingReviseEditor(null);
                    setPendingPlan(planText);
                  }}
                  onCancel={() => {
                    const planText = pendingReviseEditor;
                    setPendingReviseEditor(null);
                    setPendingPlan(planText);
                  }}
                />
              ) : pendingShell ? (
                <ShellConfirm
                  command={pendingShell.command}
                  allowPrefix={derivePrefix(pendingShell.command)}
                  kind={pendingShell.kind}
                  onChoose={handleShellConfirm}
                />
              ) : pendingEditReview ? (
                <EditConfirm
                  block={pendingEditReview}
                  onChoose={(choice, denyContext) => {
                    const resolve = editReviewResolveRef.current;
                    if (resolve) {
                      editReviewResolveRef.current = null;
                      resolve({ choice, denyContext });
                    }
                  }}
                />
              ) : walkthroughActive && pendingEdits.current.length > 0 ? (
                <EditConfirm
                  // pendingTick re-keys the modal so each apply/discard
                  // forces a remount with the NEW first block. Without it,
                  // EditConfirm's internal scroll state would persist
                  // across blocks, which is the wrong UX.
                  key={`walk-${pendingTick}`}
                  block={pendingEdits.current[0]!}
                  onChoose={handleWalkChoice}
                />
              ) : (
                <>
                  {codeMode ? (
                    <ModeStatusBar
                      editMode={editMode}
                      pendingCount={pendingCount}
                      flash={modeFlash}
                      planMode={planMode}
                      undoArmed={!!undoBanner || hasUndoable()}
                      jobs={codeMode.jobs}
                    />
                  ) : null}
                  {activeLoop ? <LoopStatusRow loop={activeLoop} /> : null}
                  <StatusRow />
                  <PromptInput
                    value={input}
                    onChange={setInput}
                    onSubmit={handleSubmit}
                    disabled={busy}
                    onHistoryPrev={recallPrev}
                    onHistoryNext={recallNext}
                  />
                  {slashMatches !== null ? (
                    <SlashSuggestions matches={slashMatches} selectedIndex={slashSelected} />
                  ) : null}
                  {atMatches !== null ? (
                    <AtMentionSuggestions
                      matches={atMatches}
                      selectedIndex={atSelected}
                      query={atPicker?.query ?? ""}
                    />
                  ) : null}
                  {slashArgContext ? (
                    <SlashArgPicker
                      matches={slashArgMatches}
                      selectedIndex={slashArgSelected}
                      spec={slashArgContext.spec}
                      kind={slashArgContext.kind}
                      partial={slashArgContext.partial}
                    />
                  ) : null}
                  {/* CtxFooter retired — UsageCard auto-emits per turn covers the same data */}
                </>
              )}
            </Box>
            {!PLAIN_UI &&
            sidebarOpen &&
            (process.stdout.columns ?? 80) >= SIDEBAR_MIN_TOTAL_COLS ? (
              <SidebarPanel ongoingTool={ongoingTool} subagentActivity={subagentActivity} />
            ) : null}
          </Box>
        </ViewportBudgetProvider>
      </TickerProvider>
    </>
  );
}
