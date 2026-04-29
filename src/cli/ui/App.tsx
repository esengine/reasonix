import type { WriteStream } from "node:fs";
import * as pathMod from "node:path";
import { Box, Text, useStdout } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AtUrlExpansion, expandAtMentions, expandAtUrls } from "../../at-mentions.js";
import {
  type ApplyResult,
  type EditBlock,
  applyEditBlocks,
  parseEditBlocks,
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
  markEditModeHintShown,
  saveEditMode,
  saveReasoningEffort,
} from "../../config.js";
import { type ResolvedHook, formatHookOutcomeMessage, loadHooks, runHooks } from "../../hooks.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";
import type { LoopEvent } from "../../loop.js";
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
} from "../../telemetry.js";
import type { ToolRegistry } from "../../tools.js";
import type { ChoiceOption } from "../../tools/choice.js";
import type { PlanStep, StepCompletion } from "../../tools/plan.js";
import { formatCommandResult, runCommand } from "../../tools/shell.js";
import { registerSkillTools } from "../../tools/skills.js";
import { formatSubagentResult, spawnSubagent } from "../../tools/subagent.js";
import { webFetch } from "../../tools/web.js";
import { registerWorkspaceTool } from "../../tools/workspace.js";
import { openTranscriptFile, recordFromLoopEvent, writeRecord } from "../../transcript.js";
import { appendUsage, defaultUsageLogPath } from "../../usage.js";
import { AtMentionSuggestions } from "./AtMentionSuggestions.js";
import { ChoiceConfirm, type ChoiceConfirmChoice } from "./ChoiceConfirm.js";
import { ChromeBar } from "./ChromeBar.js";
import { EditConfirm, type EditReviewChoice } from "./EditConfirm.js";
import { type DisplayEvent, EventRow } from "./EventLog.js";
import { ModeStatusBar, OngoingToolRow, StatusRow, SubagentRow, UndoBanner } from "./LiveRows.js";
import { type CheckpointChoice, PlanCheckpointConfirm } from "./PlanCheckpointConfirm.js";
import { PlanConfirm, type PlanConfirmChoice } from "./PlanConfirm.js";
import { PlanRefineInput } from "./PlanRefineInput.js";
import { PlanReviseConfirm, type ReviseChoice } from "./PlanReviseConfirm.js";
import { PromptInput } from "./PromptInput.js";
import { ShellConfirm, type ShellConfirmChoice, derivePrefix } from "./ShellConfirm.js";
import { SlashArgPicker } from "./SlashArgPicker.js";
import { SlashSuggestions } from "./SlashSuggestions.js";
import { WelcomeBanner } from "./WelcomeBanner.js";
import { WorkspaceConfirm, type WorkspaceConfirmChoice } from "./WorkspaceConfirm.js";
import { useAltScreen } from "./alt-screen.js";
import { detectBangCommand, formatBangUserMessage } from "./bang.js";
import {
  describeRepair,
  formatEditResults,
  formatPendingPreview,
  partitionEdits,
} from "./edit-history.js";
import { renderFrame } from "./frame-render.js";
import { appendGlobalMemory, appendProjectMemory, detectHashMemory } from "./hash-memory.js";
import { useKeystroke } from "./keystroke-context.js";
import { eventsToAtoms, renderViewport, viewportLog } from "./log-frame.js";
import { BottomHint } from "./log-rows.js";
import { formatLoopStatus } from "./loop.js";
import { handleMcpBrowseSlash } from "./mcp-browse.js";
import { formatLongPaste } from "./paste-collapse.js";
import { resolvePreset } from "./presets.js";
import { type McpServerSummary, handleSlash, parseSlash, suggestSlashCommands } from "./slash.js";
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

export function App({
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
}: AppProps) {
  // Take over the alt screen on mount so the TUI gets the entire
  // terminal viewport: sticky StatsPanel at row 1, scrollable log in
  // the middle, sticky PromptInput at the last row. Restored on unmount
  // (and on SIGINT/SIGTERM/exit) so the user's terminal returns to its
  // pre-launch state.
  useAltScreen();
  const [historical, setHistorical] = useState<DisplayEvent[]>([]);
  const [streaming, setStreaming] = useState<DisplayEvent | null>(null);

  // Log scroll state — number of events skipped from the END.
  //   0   → at bottom (always show latest, auto-track new events)
  //   N>0 → user scrolled up; new events drift visible-window forward
  //         but the scroll offset stays put until the user presses End
  //         to jump back to latest. Mimics the chat-app pattern where
  //         "I'm reading old messages" pauses the auto-scroll.
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  // Smooth-scroll engine — every key/wheel scroll sets a target offset
  // and a setInterval ease-towards loop interpolates the displayed
  // offset over ~6-8 frames at 30fps. Wheel ticks queue: rapid wheels
  // bump the target further before the previous animation finishes,
  // so the eye sees one continuous glide rather than discrete jumps.
  const scrollAnimRef = useRef<NodeJS.Timeout | null>(null);
  const scrollTargetRef = useRef<number>(0);
  const scrollDisplayedRef = useRef<number>(0);
  // Row-pipeline mirrors. The slicer fills these on every render so
  // the keystroke handler can clamp scroll inputs without recomputing
  // event row counts.
  const scrollMaxRowsRef = useRef<number>(0);
  // Cumulative row count over `historical` from the previous render —
  // used by the append-anchor effect below to bump `scrollTargetRef`
  // by the row-delta (not event-delta) when content arrives while the
  // user is scrolled up.
  const lastTotalRowsRef = useRef<number>(0);
  useEffect(() => {
    return () => {
      if (scrollAnimRef.current) {
        clearInterval(scrollAnimRef.current);
        scrollAnimRef.current = null;
      }
    };
  }, []);
  // Set a new target. `next` is either a number or an updater function
  // — same shape as React state setters. The animation easing handles
  // the transition.
  const animateScrollTo = useCallback((next: number | ((prev: number) => number)) => {
    const newTarget = typeof next === "function" ? next(scrollTargetRef.current) : next;
    scrollTargetRef.current = Math.max(0, newTarget);
    // If already running, the existing interval picks up the new
    // target on its next tick — no need to restart.
    if (scrollAnimRef.current) return;
    scrollAnimRef.current = setInterval(() => {
      const target = scrollTargetRef.current;
      const cur = scrollDisplayedRef.current;
      const diff = target - cur;
      // Snap when within 1 unit — finer steps would just round to
      // the same integer.
      if (Math.abs(diff) < 1) {
        scrollDisplayedRef.current = target;
        setLogScrollOffset(target);
        if (scrollAnimRef.current) {
          clearInterval(scrollAnimRef.current);
          scrollAnimRef.current = null;
        }
        return;
      }
      // Ease-out: move 25% of remaining distance per frame, with a
      // minimum 1-step nudge so big distances still finish in a
      // bounded number of frames.
      const step =
        diff > 0 ? Math.max(1, Math.ceil(diff * 0.25)) : Math.min(-1, Math.floor(diff * 0.25));
      scrollDisplayedRef.current = cur + step;
      setLogScrollOffset(scrollDisplayedRef.current);
    }, 33);
  }, []);
  // No-op kept for compat with any remaining call sites; the animation
  // loop now owns its lifecycle.
  const stopScrollAnimation = useCallback(() => {
    /* animateScrollTo handles its own teardown on each new target */
  }, []);
  // Anchor + clamp the visible window when historical changes:
  //   · GROWS while the user is scrolled up — bump offset by the ROWS
  //     of newly-appended content so the same lines stay framed.
  //     Without this, every appended turn slides the window forward
  //     and pushes what the user was reading off-screen. Row-deltas
  //     are exact (computed from the row pipeline) so a 50-row diff
  //     bumps the offset by 50, not 1.
  //   · SHRINKS (e.g. /new wipes log) — clamp offset to the slicer's
  //     new `maxScrollRows`. Otherwise the user is left looking at an
  //     empty middle.
  const lastHistoricalLenRef = useRef(0);
  useEffect(() => {
    const prevLen = lastHistoricalLenRef.current;
    const curLen = historical.length;
    lastHistoricalLenRef.current = curLen;
    if (curLen > prevLen && scrollTargetRef.current > 0) {
      // Row-deltas: convert each newly-appended event to its Atom
      // representation and sum the rows. Exact for `frame` atoms
      // (frame.rows.length is precise); estimated for `ink` atoms
      // (`atom.rows`). projectRoot only matters when the atom is
      // RENDERED — we're only counting here, so undefined is fine.
      const cols = stdout?.columns ?? 80;
      let deltaRows = 0;
      for (const a of eventsToAtoms(historical.slice(prevLen, curLen), undefined, cols)) {
        deltaRows += a.kind === "frame" ? a.frame.rows.length : a.rows;
      }
      if (deltaRows > 0) {
        scrollTargetRef.current += deltaRows;
        scrollDisplayedRef.current += deltaRows;
        setLogScrollOffset((p) => p + deltaRows);
      }
    } else if (curLen < prevLen) {
      const newMax = scrollMaxRowsRef.current;
      if (scrollTargetRef.current > newMax) {
        scrollTargetRef.current = newMax;
        scrollDisplayedRef.current = newMax;
        setLogScrollOffset(newMax);
      }
    }
  }, [historical]);
  // Belt-and-suspenders clamp: if `logScrollOffset` ever ends up past
  // the slicer's `maxScrollRows` (terminal resize, role-rendering
  // height changes mid-stream, anything that perturbs the row total),
  // snap it back. Without this the user can wheel into "empty
  // viewport" territory because the row-pipeline's `LogBlock` height
  // estimates can drift from what's actually rendered. The slicer
  // itself clamps internally for picking items, but the React state
  // (which the ScrollBar reads) must mirror the same upper bound or
  // the thumb shows a confusing "scrolling past content" position.
  useEffect(() => {
    const max = scrollMaxRowsRef.current;
    if (logScrollOffset > max) {
      scrollTargetRef.current = max;
      scrollDisplayedRef.current = max;
      setLogScrollOffset(max);
    }
  }, [logScrollOffset]);
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
  // Latest progress frame for the currently-running tool (MCP
  // `notifications/progress`). `null` when no progress has been
  // reported for this tool call — OngoingToolRow still spins, just
  // without a progress number.
  const [toolProgress, setToolProgress] = useState<{
    progress: number;
    total?: number;
    message?: string;
  } | null>(null);
  // stdout handle for `/clear`-style hard screen wipes. Clearing only
  // React state (setHistorical([])) leaves the terminal scrollback
  // intact — the user keeps seeing prior turns until they scroll past
  // them. Writing CSI 2J + 3J + H genuinely nukes viewport AND
  // scrollback, which is what `/clear` means to a shell user.
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
    setHistorical,
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
  // The latest `change_workspace` request awaiting user approval.
  // Populated from the WorkspaceConfirmationError surfaced in the
  // tool result; cleared once the user picks Switch / Deny in
  // WorkspaceConfirm. Mutually exclusive with pendingShell — only
  // one modal can be open at a time, and we gate input + render on
  // both flags wherever pendingShell is gated.
  const [pendingWorkspace, setPendingWorkspace] = useState<{ path: string } | null>(null);
  // Plan text the model submitted via `submit_plan` while plan mode
  // was active. Non-null renders PlanConfirm; user picks Approve /
  // Refine / Cancel and we drive the loop from there. Separate from
  // `planMode` because a pending plan is a one-shot decision even if
  // plan mode stays on (Refine keeps mode on; Approve/Cancel flip off).
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
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
  // Full untruncated tool results, in arrival order. The EventLog
  // renderer clips tool output at 400 chars for display; `/tool N`
  // reads from this ref to show the real thing. Not persisted — a
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
  // Mirror of `historical` so /api/messages can snapshot synchronously
  // without hopping through the React render scheduler. Update happens
  // in a useEffect right after every state change.
  const historicalRef = useRef<DisplayEvent[]>([]);
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
  useEffect(() => {
    return () => {
      transcriptRef.current?.end();
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
        subagentRunner: async (skill, task) => {
          const result = await spawnSubagent({
            client,
            parentRegistry: tools,
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
    // `change_workspace` — model-callable workspace switching, gated
    // on a confirmation modal driven by App.tsx (see pendingWorkspace
    // state below). Tool fn validates the path and throws
    // WorkspaceConfirmationError; the actual swap happens when the
    // user approves. Registered here (not in code.tsx) so chat-mode
    // sessions also expose it — `setCwd` works in chat mode too,
    // just doesn't have a tool sandbox to re-register.
    if (tools && !tools.has("change_workspace")) {
      registerWorkspaceTool(tools);
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

  // Shared cwd-switch implementation — drives BOTH the `/cwd` slash
  // command and the `change_workspace` tool's confirmation handler.
  // Returns a multi-line info string the caller can surface to the
  // user (slash) or fold into a synthetic message (tool). Idempotent
  // on the same path.
  const applyCwdChange = useCallback(
    (newRoot: string): string => {
      // Update the React state — every memoized derivation that reads
      // `currentRootDir` (memoryRoot, hookCwd via useEffect,
      // applyEditBlocks paths, mention root, run_command cwd) picks
      // up the new path on the next render.
      setCurrentRootDir(newRoot);
      // Reload hooks against the new project (different
      // .reasonix/settings.json may exist there).
      const fresh = loadHooks({ projectRoot: codeMode ? newRoot : undefined });
      setHookList(fresh);
      // Re-register every rootDir-dependent native tool so file
      // reads/writes and shell calls land in the new sandbox. Only
      // available in code mode (chat mode has no rootDir-bound tools
      // beyond memory, which we re-register inline below).
      const codeRebound = codeMode?.reregisterTools !== undefined;
      if (codeMode?.reregisterTools) {
        codeMode.reregisterTools(newRoot);
      }
      // Keep `run_skill`'s closured projectRoot in sync too. It's
      // owned by App.tsx (the subagent runner needs in-process refs),
      // so the codeMode reregister hook above doesn't touch it. Safe
      // to re-register: the registry overwrites by tool name, the
      // spec is identical, prefix cache stays.
      if (tools) {
        registerSkillTools(tools, {
          projectRoot: codeMode ? newRoot : undefined,
          subagentRunner: async (skill, task) => {
            const result = await spawnSubagent({
              client: loop.client,
              parentRegistry: tools,
              system: skill.body,
              task,
              model: skill.model,
              sink: subagentSinkRef.current,
              skillName: skill.name,
            });
            return formatSubagentResult(result);
          },
        });
      }
      const lines = [`▸ cwd → ${newRoot}`, `  hooks reloaded (${fresh.length} active)`];
      if (codeMode) {
        lines.push(
          codeRebound
            ? "  filesystem / shell / memory tools rebound to new root"
            : "  warning: reregisterTools callback missing — tool sandbox unchanged",
        );
        lines.push(
          "  note: system prompt context (gitignore, REASONIX.md stack) was",
          "        baked at session start and still references the original root.",
        );
      }
      return lines.join("\n");
    },
    [codeMode, loop, tools, subagentSinkRef],
  );

  // Mirror `currentRootDir` into the loop's mutable `hookCwd` so
  // `/cwd` switches the path threaded into every hook's stdin
  // envelope without reconstructing the loop. Same shape as the
  // hookList sync above — the loop holds a parallel mutable copy.
  useEffect(() => {
    loop.hookCwd = currentRootDir;
  }, [loop, currentRootDir]);

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
  }, [balance]);
  useEffect(() => {
    historicalRef.current = historical;
  }, [historical]);

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
    if (!pendingWorkspace) return;
    broadcastDashboardEvent({
      kind: "modal-up",
      modal: { kind: "workspace", path: pendingWorkspace.path },
    });
    return () => {
      broadcastDashboardEvent({ kind: "modal-down", modalKind: "workspace" });
    };
  }, [pendingWorkspace, broadcastDashboardEvent]);

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
      setHistorical((prev) => [
        ...prev,
        {
          id: `sys-session-${Date.now()}`,
          role: "info",
          text: "▸ ephemeral chat (no session persistence) — drop --no-session to enable",
        },
      ]);
    } else if (loop.resumedMessageCount > 0) {
      setHistorical((prev) => [
        ...prev,
        {
          id: `sys-resume-${Date.now()}`,
          role: "info",
          text: `▸ resumed session "${session}" with ${loop.resumedMessageCount} prior messages · /forget to start over · /sessions to list`,
        },
      ]);
    } else {
      setHistorical((prev) => [
        ...prev,
        {
          id: `sys-newsession-${Date.now()}`,
          role: "info",
          text: `▸ session "${session}" (new) — auto-saved as you chat · /forget to delete · /sessions to list`,
        },
      ]);
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
        setHistorical((prev) => [
          ...prev,
          {
            id: `sys-pending-${Date.now()}`,
            role: "info",
            text: `▸ restored ${restored.length} pending edit block(s) from an interrupted prior run — /apply to commit or /discard to drop.`,
          },
        ]);
      }
    }
    // Restore structured plan state from a prior run. plan.json sits
    // next to the session JSONL; if present, populate planStepsRef +
    // completedStepIdsRef and post an info row showing how far along
    // the plan was. Pure-markdown plans don't persist (nothing to
    // restore), so users see this banner only when there's real
    // structured state to pick back up.
    if (session) {
      const restoredPlan = loadPlanState(session);
      if (restoredPlan && restoredPlan.steps.length > 0) {
        planStepsRef.current = restoredPlan.steps;
        completedStepIdsRef.current = new Set(restoredPlan.completedStepIds);
        planBodyRef.current = restoredPlan.body ?? null;
        planSummaryRef.current = restoredPlan.summary ?? null;
        const when = relativeTime(restoredPlan.updatedAt);
        setHistorical((prev) => [
          ...prev,
          {
            id: `sys-plan-${Date.now()}`,
            role: "plan-resumed",
            text: "",
            resumedPlan: {
              steps: restoredPlan.steps,
              completedStepIds: restoredPlan.completedStepIds,
              relativeTime: when,
              summary: restoredPlan.summary,
            },
          },
        ]);
      }
    }
    // One-time onboarding tip for the edit-gate keybindings. New users
    // wouldn't otherwise discover Shift+Tab (it's in /keys and the
    // bottom status bar, but both require looking). Shown exactly once
    // per install; the config flag suppresses re-display on every
    // relaunch. Skips chat mode — those shortcuts don't apply there.
    if (codeMode && !editModeHintShown()) {
      setHistorical((prev) => [
        ...prev,
        {
          id: `sys-edittip-${Date.now()}`,
          role: "info",
          text:
            "▸ TIP: edit-gate keybindings\n" +
            "    y / n       accept or drop pending edits\n" +
            "    Shift+Tab   switch review ↔ AUTO (persisted; AUTO applies instantly)\n" +
            "    u           undo the last auto-applied batch (within the 5s banner)\n" +
            "  Current mode is shown in the bottom status bar. Run /keys anytime for the full list.\n" +
            "  (This tip shows once — suppressed after.)",
        },
      ]);
      markEditModeHintShown();
    }
  }, [session, loop, codeMode, syncPendingCount]);

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
    // Log-scroll keys + mouse wheel — fire ahead of any PromptInput
    // consumption so the user can read history while the input is
    // focused. Scroll unit is ROWS (lines), not events: a single tall
    // entry — long assistant reply, big diff — can be wheeled through
    // one piece at a time. Step sizes match OS conventions:
    //   · wheel tick    →  3 rows  (matches Linux/Mac line-step)
    //   · PgUp / PgDn   →  ~viewport, leaving a 2-row overlap so the
    //                       reader doesn't lose context across a jump
    //   · Home / End    →  oldest / newest
    // `maxScrollRows` is set by the slicer on every render and lives
    // in a ref so this handler doesn't have to recompute heights.
    const maxOffset = scrollMaxRowsRef.current;
    const viewportRows = Math.max(8, (stdout?.rows ?? 30) - 10);
    if (ev.mouseScrollUp) {
      if (maxOffset === 0) return;
      animateScrollTo((prev) => Math.min(maxOffset, prev + 3));
      return;
    }
    if (ev.mouseScrollDown) {
      if (maxOffset === 0) return;
      animateScrollTo((prev) => Math.max(0, prev - 3));
      return;
    }
    if (ev.pageUp) {
      if (maxOffset === 0) return;
      animateScrollTo((prev) => Math.min(maxOffset, prev + (viewportRows - 2)));
      return;
    }
    if (ev.pageDown) {
      if (maxOffset === 0) return;
      animateScrollTo((prev) => Math.max(0, prev - (viewportRows - 2)));
      return;
    }
    if (ev.home) {
      if (maxOffset === 0) return;
      animateScrollTo(() => maxOffset);
      return;
    }
    if (ev.end) {
      if (maxOffset === 0) return;
      animateScrollTo(() => 0);
      return;
    }
    // Mouse click events are intentionally ignored — having the app
    // intercept clicks fights the user's text-selection workflow
    // (which most terminals route through the same mouse-tracking
    // channel). Wheel events still work for scrolling. To copy
    // text, hold Shift while dragging — that bypasses the mouse-
    // tracking layer in iTerm2 / Windows Terminal / WezTerm /
    // gnome-terminal / VS Code's integrated terminal. End / Home
    // keys cover the "jump to latest" UX without the click hazard.
    // Ctrl+C → exit. Always. Same target as the SIGINT path above —
    // whichever route delivers Ctrl+C on the user's terminal wins.
    if (key.ctrl && key.input === "c") {
      quitProcess();
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
    // Esc inside a /walk session exits the walk WITHOUT applying or
    // discarding the current block — remaining edits stay queued so
    // the user can resume via /walk or commit via /apply later.
    if (key.escape && walkthroughActive) {
      setWalkthroughActive(false);
      const remaining = pendingEdits.current.length;
      setHistorical((prev) => [
        ...prev,
        {
          id: `walk-esc-${Date.now()}`,
          role: "info",
          text:
            remaining > 0
              ? `▸ walk cancelled — ${remaining} block(s) still pending.`
              : "▸ walk cancelled.",
        },
      ]);
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
      !pendingWorkspace &&
      !pendingPlan &&
      !stagedInput &&
      !pendingEditReview &&
      !walkthroughActive &&
      !pendingCheckpoint &&
      !stagedCheckpointRevise &&
      !pendingChoice &&
      !stagedChoiceCustom &&
      !pendingRevision
    ) {
      setEditMode((m) => {
        // Three-stop cycle: review → auto → yolo → review. yolo also
        // disables shell confirmations (read live by registerShellTools'
        // allowAll getter), so users who want true zero-prompt iteration
        // can hit Shift+Tab twice from the default.
        const next: EditMode = m === "review" ? "auto" : m === "auto" ? "yolo" : "review";
        const message =
          next === "yolo"
            ? "▸ edit mode: YOLO — edits AND shell commands auto-run. /undo still rolls back edits. Use carefully."
            : next === "auto"
              ? "▸ edit mode: AUTO — edits apply immediately; press u within 5s to undo. Shell commands still ask."
              : "▸ edit mode: review — edits queue for /apply (or y) / /discard (or n)";
        setHistorical((prev) => [
          ...prev,
          { id: `mode-${Date.now()}`, role: "info", text: message },
        ]);
        return next;
      });
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
      !pendingWorkspace &&
      !pendingPlan &&
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
      setHistorical((prev) => [...prev, { id: `undo-${Date.now()}`, role: "info", text: out }]);
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
        block = toWholeFileEditBlock(relPath, content, currentRootDir);
      }

      // Helper: apply the current block + record into history + arm
      // undo. Used by auto mode AND by the various "apply" branches
      // of the review modal so we don't duplicate the snapshot /
      // apply / banner logic.
      //
      // Does NOT push an info row to scrollback: the caller is inside
      // a tool-dispatch frame, so the returned string becomes the
      // tool result AND the loop yields a `tool` event right after —
      // which EventLog renders as a `▣ edit_file → …` block
      // containing the same text. Pushing an info row here produced
      // the "result shown twice" bug reported in 0.6 (one dim info
      // row, then a nearly identical tool row directly below).
      const applyNow = (): string => {
        const snaps = snapshotBeforeEdits([block], currentRootDir);
        const results = applyEditBlocks([block], currentRootDir);
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
        setHistorical((prev) => [
          ...prev,
          {
            id: `er-${Date.now()}-${Math.random()}`,
            role: "info",
            text: `▸ rejected edit to ${block.path}${context}`,
          },
        ]);
        return `User rejected this edit to ${block.path}${context}. Don't retry the same SEARCH/REPLACE — either try a different approach or ask the user what they want instead.`;
      }
      if (choice === "apply-rest-of-turn") {
        turnEditPolicyRef.current = "apply-all";
        setHistorical((prev) => [
          ...prev,
          {
            id: `er-${Date.now()}-${Math.random()}`,
            role: "info",
            text: "▸ auto-approving remaining edits for this turn",
          },
        ]);
        return applyNow();
      }
      if (choice === "flip-to-auto") {
        setEditMode("auto");
        setHistorical((prev) => [
          ...prev,
          {
            id: `er-${Date.now()}-${Math.random()}`,
            role: "info",
            text: "▸ flipped to AUTO mode for the rest of the session (persisted)",
          },
        ]);
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
    setActiveLoop((cur) => {
      if (!cur) return cur;
      // Inform the user — the cancel may not have come from /loop stop
      // (could be Esc, /new, or just typing). Better one extra info row
      // than a silent disappearance.
      setHistorical((prev) => [
        ...prev,
        {
          id: `loop-stop-${Date.now()}`,
          role: "info",
          text: `▸ loop stopped (after ${cur.iter} iter${cur.iter === 1 ? "" : "s"}).`,
        },
      ]);
      return null;
    });
  }, []);

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
        getMessages: (): DashboardMessage[] => {
          // Filter to roles the SPA cares about; map to the wire shape.
          const out: DashboardMessage[] = [];
          for (const ev of historicalRef.current) {
            if (
              ev.role === "user" ||
              ev.role === "assistant" ||
              ev.role === "info" ||
              ev.role === "warning"
            ) {
              const msg: DashboardMessage = { id: ev.id, role: ev.role, text: ev.text };
              if (ev.reasoning) msg.reasoning = ev.reasoning;
              out.push(msg);
            } else if (ev.role === "tool") {
              const msg: DashboardMessage = {
                id: ev.id,
                role: "tool",
                text: ev.text,
                toolName: ev.toolName,
              };
              if (ev.toolArgs) msg.toolArgs = ev.toolArgs;
              out.push(msg);
            }
          }
          return out;
        },
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
          if (pendingWorkspace) {
            return { kind: "workspace", path: pendingWorkspace.path };
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
        resolveWorkspaceConfirm: (choice) => {
          handleWorkspaceConfirmRef.current(choice).catch(() => undefined);
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
    pendingWorkspace,
    pendingCheckpoint,
    pendingRevision,
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
    setHistorical((prev) => [
      ...prev,
      { id: `dash-stop-${Date.now()}`, role: "info", text: "▸ dashboard stopped." },
    ]);
  }, []);

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
      setHistorical((prev) => [
        ...prev,
        {
          id: `dash-fail-${Date.now()}`,
          role: "info",
          text: `▲ dashboard auto-start failed (${reason}) — try /dashboard, or pass --no-dashboard to silence`,
        },
      ]);
    });
  }, [noDashboard, startDashboard]);

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
        const out = codeApply([1]);
        setHistorical((prev) => [...prev, { id: `walk-${Date.now()}`, role: "info", text: out }]);
      } else if (choice === "reject") {
        const out = codeDiscard([1]);
        setHistorical((prev) => [...prev, { id: `walk-${Date.now()}`, role: "info", text: out }]);
      } else if (choice === "apply-rest-of-turn") {
        // "apply rest" inside a walkthrough = commit every remaining
        // block at once, then exit. Same end state as if the user had
        // typed `/apply` outside the walk.
        const out = codeApply();
        setHistorical((prev) => [...prev, { id: `walk-${Date.now()}`, role: "info", text: out }]);
        setWalkthroughActive(false);
        return;
      } else if (choice === "flip-to-auto") {
        // Flip the gate first, then apply the current block, then exit
        // the walk. Remaining blocks stay pending — the user can keep
        // walking via /walk again or commit them with /apply.
        setEditMode("auto");
        saveEditMode("auto");
        const out = codeApply([1]);
        setHistorical((prev) => [
          ...prev,
          { id: `walk-${Date.now()}`, role: "info", text: out },
          {
            id: `walk-flip-${Date.now()}`,
            role: "info",
            text: "▸ flipped to AUTO mode — future edits will apply immediately. Walk exited.",
          },
        ]);
        setWalkthroughActive(false);
        return;
      }
      // After a per-block apply/reject, check if the queue is empty
      // (codeApply/codeDiscard updated pendingEdits.current). If so,
      // exit; otherwise stay mounted and EditConfirm re-renders against
      // the new first block thanks to pendingTick.
      if (pendingEdits.current.length === 0) setWalkthroughActive(false);
    },
    [codeApply, codeDiscard],
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
        const out = text === "y" ? codeApply() : codeDiscard();
        setHistorical((prev) => [...prev, { id: `sys-${Date.now()}`, role: "info", text: out }]);
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
          setHistorical((prev) => [
            ...prev,
            {
              id: `hash-${Date.now()}`,
              role: "info",
              text: `▸ noted (${scopeTag}) — ${verb} ${result.path}`,
            },
          ]);
        } catch (err) {
          setHistorical((prev) => [
            ...prev,
            {
              id: `hash-e-${Date.now()}`,
              role: "warning",
              text: `# memory write failed: ${(err as Error).message}`,
            },
          ]);
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
        setHistorical((prev) => [
          ...prev,
          {
            id: `bang-u-${Date.now()}`,
            role: "user",
            text,
            leadSeparator: prev.length > 0,
          },
        ]);
        setBusy(true);
        try {
          const result = await runCommand(bangCmd, {
            cwd: bangRoot,
            timeoutSec: 60,
            maxOutputChars: 32_000,
          });
          const formatted = formatCommandResult(bangCmd, result);
          setHistorical((prev) => [
            ...prev,
            { id: `bang-o-${Date.now()}`, role: "info", text: formatted },
          ]);
          loop.appendAndPersist({
            role: "user",
            content: formatBangUserMessage(bangCmd, formatted),
          });
        } catch (err) {
          setHistorical((prev) => [
            ...prev,
            {
              id: `bang-e-${Date.now()}`,
              role: "warning",
              text: `! command failed: ${(err as Error).message}`,
            },
          ]);
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
        setHistorical((prev) => [
          ...prev,
          { id: `mcp-u-${Date.now()}`, role: "user", text, leadSeparator: prev.length > 0 },
        ]);
        await handleMcpBrowseSlash(kind, arg, mcpServers ?? [], setHistorical);
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
          postInfo: (text: string) =>
            setHistorical((prev) => [
              ...prev,
              { id: `sys-late-${Date.now()}-${Math.random()}`, role: "info", text },
            ]),
          reloadHooks: () => {
            const fresh = loadHooks({ projectRoot: codeMode ? currentRootDir : undefined });
            setHookList(fresh);
            return fresh.length;
          },
          setCwd: (newRoot: string) => applyCwdChange(newRoot),
          latestVersion,
          refreshLatestVersion,
          models,
          refreshModels,
        });
        if (result.exit) {
          // Tear down any active /loop before quitting so the timer
          // doesn't try to fire after the process is on its way out.
          // Use quitProcess (process.exit) rather than Ink's exit():
          // the singleton stdin reader keeps a `data` listener attached,
          // so exit() unmounts React but leaves the event loop alive
          // and the terminal hangs. Same reasoning as the SIGINT path.
          if (activeLoopRef.current) stopLoop();
          quitProcess();
          return;
        }
        if (result.clear && result.info) {
          // Clear + message: nuke terminal viewport AND scrollback
          // (2J = visible, 3J = scrollback buffer, H = cursor home),
          // then seed React state with the explanatory info line.
          // Ink's next render paints the TUI on the fresh screen.
          stdout?.write("\x1b[2J\x1b[3J\x1b[H");
          setHistorical([
            {
              id: `sys-${Date.now()}`,
              role: "info",
              text: result.info,
            },
          ]);
          // /new wipes conversation; any pending edits from the prior
          // assistant turn are stale (the user no longer sees the
          // preview). Drop them so a later /apply doesn't surprise.
          if (codeMode) {
            pendingEdits.current = [];
            clearPendingEdits(session ?? null);
            syncPendingCount();
          }
          // /new also kills any active /loop: continuing to autofire
          // a prompt against a freshly-wiped context would be confusing.
          if (activeLoopRef.current) stopLoop();
          return;
        }
        if (result.clear) {
          stdout?.write("\x1b[2J\x1b[3J\x1b[H");
          setHistorical([]);
          if (codeMode) {
            pendingEdits.current = [];
            clearPendingEdits(session ?? null);
            syncPendingCount();
          }
          if (activeLoopRef.current) stopLoop();
          return;
        }
        if (result.info) {
          // /context returns a structured ctxBreakdown payload; push as
          // a ctx-breakdown DisplayEvent so EventLog renders the
          // 4-color stacked char-bar. Other slashes fall through to
          // the plain "info" path.
          if (result.ctxBreakdown) {
            setHistorical((prev) => [
              ...prev,
              {
                id: `ctx-${Date.now()}`,
                role: "ctx-breakdown",
                text: result.info!,
                ctxBreakdown: result.ctxBreakdown,
              },
            ]);
          } else {
            setHistorical((prev) => [
              ...prev,
              {
                id: `sys-${Date.now()}`,
                role: "info",
                text: result.info!,
              },
            ]);
          }
        }
        // /replay returns a structured archive snapshot. Push it as a
        // plan-replay DisplayEvent so EventLog renders the same step
        // list the active plan uses, just dim/locked. Does NOT touch
        // planStepsRef — replay is read-only.
        if (result.replayPlan) {
          const rp = result.replayPlan;
          setHistorical((prev) => [
            ...prev,
            {
              id: `replay-${Date.now()}-${Math.random()}`,
              role: "plan-replay",
              text: "",
              replayPlan: {
                summary: rp.summary,
                body: rp.body,
                steps: rp.steps,
                completedStepIds: rp.completedStepIds,
                relativeTime: rp.relativeTime,
                archiveBasename: rp.archiveBasename,
                index: rp.index,
                total: rp.total,
              },
            },
          ]);
        }
        // `/retry` (and anything else that requests a resubmit) falls
        // through to the normal user-message flow with the provided
        // text instead of returning.
        if (result.resubmit) {
          text = result.resubmit;
        } else {
          promptHistory.current.push(text);
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
        if (promptReport.outcomes.length > 0) {
          setHistorical((prev) => [
            ...prev,
            ...promptReport.outcomes
              .filter((o) => o.decision !== "pass")
              .map((o) => ({
                id: `hp-${Date.now()}-${Math.random()}`,
                role: "warning" as const,
                text: formatHookOutcomeMessage(o),
              })),
          ]);
        }
        if (promptReport.blocked) return;
      }

      // User message is immutable — push to Static immediately.
      // Large pastes (stack traces, log dumps, file contents) get a
      // collapsed preview in Historical so scrollback stays navigable;
      // the MODEL still receives the full text below via modelInput.
      promptHistory.current.push(text);
      const pasteDisplay = formatLongPaste(text);
      setHistorical((prev) => [
        ...prev,
        // `leadSeparator`: thin rule above this user turn when history
        // isn't empty — visual pacing for multi-turn sessions. First
        // user message leaves it off so the UI doesn't open with a
        // dangling divider.
        {
          id: `u-${Date.now()}`,
          role: "user",
          text: pasteDisplay.displayText,
          leadSeparator: prev.length > 0,
        },
      ]);
      const userId = `u-${Date.now()}`;
      broadcastDashboardEvent({ kind: "user", id: userId, text });

      const assistantId = `a-${Date.now()}`;
      // Refs are the source of truth for accumulated streaming text; the React
      // state copy below is only for rendering and gets updated on flush.
      const streamRef: StreamingState = { id: assistantId, text: "", reasoning: "" };
      const contentBuf = { current: "" };
      const reasoningBuf = { current: "" };
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

      setStreaming({ id: assistantId, role: "assistant", text: "", streaming: true });
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
        streamRef.text += contentBuf.current;
        streamRef.reasoning += reasoningBuf.current;
        if (toolCallBuildBuf.current) {
          streamRef.toolCallBuild = toolCallBuildBuf.current;
        }
        contentBuf.current = "";
        reasoningBuf.current = "";
        toolCallBuildBuf.current = null;
        setStreaming({
          id: assistantId,
          role: "assistant",
          text: streamRef.text,
          reasoning: streamRef.reasoning || undefined,
          toolCallBuild: streamRef.toolCallBuild,
          streaming: true,
        });
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
          if (parts.length > 0) {
            setHistorical((prev) => [
              ...prev,
              { id: `at-${Date.now()}`, role: "info", text: `▸ @mentions: ${parts.join("; ")}` },
            ]);
          }
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
            if (parts.length > 0) {
              setHistorical((prev) => [
                ...prev,
                {
                  id: `aturl-${Date.now()}`,
                  role: "info",
                  text: `▸ @url: ${parts.join("; ")}`,
                },
              ]);
            }
          }
        } catch (err) {
          // expandAtUrls itself only throws on misconfiguration (no
          // fetcher). Per-URL failures are surfaced via the skip path.
          setHistorical((prev) => [
            ...prev,
            {
              id: `aturl-e-${Date.now()}`,
              role: "warning",
              text: `@url expansion failed: ${(err as Error).message}`,
            },
          ]);
        }
      }

      try {
        for await (const ev of loop.step(modelInput)) {
          writeTranscript(ev);
          // Mirror to dashboard SSE subscribers. Done at the top of
          // the iteration so the web sees the same sequence the TUI
          // about to render — keeps the two surfaces in lockstep.
          // Only the role values the web understands; transient ones
          // (status, branch_*, tool_call_delta) are skipped to keep
          // the wire chatter low.
          if (eventSubscribersRef.current.size > 0) {
            const id = `${assistantId}-${ev.role}-${Date.now()}`;
            if (ev.role === "assistant_delta") {
              broadcastDashboardEvent({
                kind: "assistant_delta",
                id: assistantId,
                contentDelta: ev.content || undefined,
                reasoningDelta: ev.reasoningDelta,
              });
            } else if (ev.role === "tool_start" && ev.toolName) {
              broadcastDashboardEvent({
                kind: "tool_start",
                id,
                toolName: ev.toolName,
                args: ev.toolArgs,
              });
            } else if (ev.role === "tool" && ev.toolName) {
              broadcastDashboardEvent({
                kind: "tool",
                id,
                toolName: ev.toolName,
                content: ev.content,
                args: ev.toolArgs,
              });
            } else if (ev.role === "warning") {
              broadcastDashboardEvent({ kind: "warning", id, text: ev.content });
            } else if (ev.role === "error") {
              broadcastDashboardEvent({ kind: "error", id, text: ev.content });
            } else if (ev.role === "status") {
              // Transient hints (between tool result and next iter,
              // pre-harvest) — surfaces the same "what's happening
              // right now" context the TUI's status line shows.
              broadcastDashboardEvent({ kind: "status", text: ev.content });
            }
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
            setStreaming({
              id: assistantId,
              role: "assistant",
              text: "",
              streaming: true,
              branchProgress: ev.branchProgress,
            });
          } else if (ev.role === "branch_progress") {
            // Live-update the streaming slot with per-sample completion info.
            setStreaming({
              id: assistantId,
              role: "assistant",
              text: "",
              streaming: true,
              branchProgress: ev.branchProgress,
            });
          } else if (ev.role === "branch_done") {
            // Intermediate: branching finished but assistant_final not yet emitted.
            // Keep streaming state alive; actual render happens on assistant_final.
          } else if (ev.role === "assistant_final") {
            flush();
            const repairNote = ev.repair ? describeRepair(ev.repair) : "";
            setStreaming(null);
            // Broadcast the final to web subscribers. flush() already
            // moved contentBuf → streamRef.text and emptied contentBuf,
            // so we read from streamRef (mirrors what the TUI's own
            // historical-push uses below: `ev.content || streamRef.text`).
            broadcastDashboardEvent({
              kind: "assistant_final",
              id: assistantId,
              text: ev.content || streamRef.text,
              reasoning: streamRef.reasoning || undefined,
            });
            // Update the live stats panel every assistant_final — this is
            // where the loop already recorded per-iter usage. Without
            // this, cost/ctx/cache/hit stay at the PRIOR turn's numbers
            // until the whole step resolves, which is especially
            // confusing in multi-iter tool-call chains.
            setSummary(loop.stats.summary());
            // Persist a compact per-turn record to ~/.reasonix/usage.jsonl
            // so `reasonix stats` (no arg) can aggregate across every
            // session the user has ever run. Best-effort: a disk error
            // inside appendUsage is swallowed and won't break the turn.
            if (ev.stats?.usage) {
              appendUsage({
                session: session ?? null,
                model: ev.stats.model,
                usage: ev.stats.usage,
              });
            }
            const finalText = ev.content || streamRef.text;
            const iterReasoning = streamRef.reasoning || undefined;
            const iterId = `${assistantId}-i${assistantIterCounter.current++}`;
            setHistorical((prev) => [
              ...prev,
              {
                id: iterId,
                role: "assistant",
                text: finalText,
                reasoning: iterReasoning,
                planState: ev.planState,
                branch: ev.branch,
                stats: ev.stats,
                repair: repairNote || undefined,
                streaming: false,
              },
            ]);
            // streamRef is scoped to the whole handleSubmit call but each
            // iteration's deltas must not bleed into the next.
            streamRef.text = "";
            streamRef.reasoning = "";
            streamRef.toolCallBuild = undefined;
            contentBuf.current = "";
            reasoningBuf.current = "";
            toolCallBuildBuf.current = null;
            if (codeMode && finalText && !ev.forcedSummary) {
              // Parse SEARCH/REPLACE blocks from assistant text. What
              // happens next depends on the edit mode: `review` queues
              // them for user confirmation; `auto` snapshots + applies
              // immediately, arming the undo banner.
              //
              // `ev.forcedSummary` gates us out entirely: if the loop
              // had to force a summary (budget / aborted / context-
              // guard), its text is a wrap-up, not a plan to execute.
              // Blocks dropped in a forced summary are display-only.
              const blocks = parseEditBlocks(finalText);
              if (blocks.length > 0) {
                if (editModeRef.current === "auto" || editModeRef.current === "yolo") {
                  const snaps = snapshotBeforeEdits(blocks, currentRootDir);
                  const results = applyEditBlocks(blocks, currentRootDir);
                  const good = results.some(
                    (r) => r.status === "applied" || r.status === "created",
                  );
                  if (good) {
                    recordEdit("auto-text", blocks, results, snaps);
                    armUndoBanner(results);
                  }
                  setHistorical((prev) => [
                    ...prev,
                    {
                      id: `applied-${Date.now()}`,
                      role: "info",
                      text: formatEditResults(results),
                    },
                  ]);
                } else {
                  // Append rather than replace — tool-call edits from
                  // earlier in the same turn may already be queued via
                  // the registry interceptor.
                  pendingEdits.current = [...pendingEdits.current, ...blocks];
                  // Checkpoint the queue so a crash / Ctrl+C between
                  // "blocks parsed" and "user /apply" doesn't lose the
                  // edits. On next launch App.tsx's restore effect reads
                  // this file. /apply + /discard clear it explicitly.
                  savePendingEdits(session ?? null, pendingEdits.current);
                  syncPendingCount();
                  setHistorical((prev) => [
                    ...prev,
                    {
                      id: `pending-${Date.now()}`,
                      role: "info",
                      text: formatPendingPreview(pendingEdits.current),
                    },
                  ]);
                }
              }
            }
          } else if (ev.role === "tool_start") {
            // Kick off the visual indicator. Cleared when `tool`
            // (result) or `error` arrives, or on the finally below.
            // Also reset any lingering progress from a prior call so
            // the new spinner starts clean.
            setOngoingTool({ name: ev.toolName ?? "?", args: ev.toolArgs });
            setToolProgress(null);
            toolStartedAtRef.current = Date.now();
            // Feed the `@` picker's recency LRU from tool args — any
            // path-shaped field (`path`, `file_path`, `file`) under a
            // filesystem tool call means the user/model is actively
            // working on that file. Picker surfaces it next time `@`
            // is typed, even if the file's mtime is stale.
            if (codeMode && ev.toolArgs) {
              try {
                const parsed = JSON.parse(ev.toolArgs) as {
                  path?: unknown;
                  file_path?: unknown;
                  file?: unknown;
                };
                for (const k of ["path", "file_path", "file"] as const) {
                  const v = parsed[k];
                  if (typeof v === "string" && v.trim()) {
                    recordRecentFile(v.trim());
                    break;
                  }
                }
              } catch {
                /* malformed args — skip recency tracking */
              }
            }
          } else if (ev.role === "tool") {
            flush();
            setOngoingTool(null);
            setToolProgress(null);
            // `mark_step_complete` gets its own pretty scrollback row
            // below — suppressing the raw tool row here keeps the log
            // from showing the same JSON blob twice.
            const isStepProgressTool = ev.toolName === "mark_step_complete";
            const startedAt = toolStartedAtRef.current;
            const durationMs = startedAt !== null ? Date.now() - startedAt : undefined;
            toolStartedAtRef.current = null;
            if (!isStepProgressTool) {
              toolHistoryRef.current.push({
                toolName: ev.toolName ?? "?",
                text: ev.content,
              });
              const toolIndex = toolHistoryRef.current.length;
              setHistorical((prev) => [
                ...prev,
                {
                  id: `t-${Date.now()}-${Math.random()}`,
                  role: "tool",
                  text: ev.content,
                  toolName: ev.toolName,
                  toolArgs: ev.toolArgs,
                  toolIndex,
                  durationMs,
                },
              ]);
            }
            // run_command rejected because the command isn't on the
            // auto-allow list. Stash it so the y/n fast-path can run
            // it after user confirmation. Only the latest such request
            // is tracked — a second rejection overwrites the first.
            if (
              codeMode &&
              (ev.toolName === "run_command" || ev.toolName === "run_background") &&
              ev.content.includes('"NeedsConfirmationError:') &&
              ev.toolArgs
            ) {
              try {
                const parsed = JSON.parse(ev.toolArgs) as { command?: unknown };
                if (typeof parsed.command === "string" && parsed.command.trim()) {
                  setPendingShell({
                    command: parsed.command.trim(),
                    kind: ev.toolName as "run_command" | "run_background",
                  });
                }
              } catch {
                /* malformed args — skip the prompt */
              }
            }
            // change_workspace surfaced its WorkspaceConfirmationError —
            // the resolved absolute path is on the error message between
            // the `"` markers (`switching to "/abs/path" needs ...`). We
            // re-derive it from the args rather than parsing the message
            // so a future error-text rewording doesn't break the modal.
            if (
              ev.toolName === "change_workspace" &&
              ev.content.includes('"WorkspaceConfirmationError:') &&
              ev.toolArgs
            ) {
              try {
                const parsed = JSON.parse(ev.toolArgs) as { path?: unknown };
                if (typeof parsed.path === "string" && parsed.path.trim()) {
                  // Re-resolve the same way the tool fn did so the modal
                  // shows the canonical destination even when the model
                  // passed a relative or `~`-prefixed path.
                  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
                  const expanded =
                    parsed.path.startsWith("~") && home
                      ? pathMod.join(home, parsed.path.slice(1))
                      : parsed.path;
                  const abs = pathMod.resolve(expanded);
                  setPendingWorkspace({ path: abs });
                }
              } catch {
                /* malformed args — skip the prompt */
              }
            }
            // submit_plan fired while plan mode was on — the registry
            // serialized `{ error, plan, steps? }` via PlanProposedError's
            // toToolResult(). Extract the plan and mount PlanConfirm.
            // Only the latest submission is tracked; a second overrides.
            if (
              codeMode &&
              ev.toolName === "submit_plan" &&
              ev.content.includes('"PlanProposedError:')
            ) {
              try {
                const parsed = JSON.parse(ev.content) as {
                  plan?: unknown;
                  steps?: unknown;
                  summary?: unknown;
                };
                if (typeof parsed.plan === "string" && parsed.plan.trim()) {
                  const planText = parsed.plan.trim();
                  setPendingPlan(planText);
                  // Structured steps are optional. When present, stash
                  // them so mark_step_complete can look up titles and
                  // compute N/M. A fresh submission always resets the
                  // completed set — a revised plan shouldn't inherit
                  // stale checkmarks from the previous proposal.
                  const steps = Array.isArray(parsed.steps) ? (parsed.steps as PlanStep[]) : null;
                  planStepsRef.current = steps;
                  completedStepIdsRef.current = new Set();
                  planBodyRef.current = planText;
                  planSummaryRef.current =
                    typeof parsed.summary === "string" && parsed.summary.trim()
                      ? parsed.summary.trim()
                      : null;
                  persistPlanState();
                  setHistorical((prev) => [
                    ...prev,
                    {
                      id: `plan-${Date.now()}-${Math.random()}`,
                      role: "plan",
                      text: planText,
                    },
                  ]);
                }
              } catch {
                /* malformed payload — skip the picker */
              }
            }
            // revise_plan fires with PlanRevisionProposedError. The
            // registry serialized {error, reason, remainingSteps,
            // summary?} via toToolResult; we mount the diff picker.
            if (
              ev.toolName === "revise_plan" &&
              ev.content.includes('"PlanRevisionProposedError:')
            ) {
              try {
                const parsed = JSON.parse(ev.content) as {
                  reason?: unknown;
                  remainingSteps?: unknown;
                  summary?: unknown;
                };
                const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
                const remainingSteps = Array.isArray(parsed.remainingSteps)
                  ? (parsed.remainingSteps as PlanStep[]).filter(
                      (s) =>
                        s &&
                        typeof s.id === "string" &&
                        s.id.trim() &&
                        typeof s.title === "string" &&
                        s.title.trim() &&
                        typeof s.action === "string" &&
                        s.action.trim(),
                    )
                  : [];
                if (reason && remainingSteps.length > 0) {
                  const summary =
                    typeof parsed.summary === "string"
                      ? parsed.summary.trim() || undefined
                      : undefined;
                  setPendingRevision({ reason, remainingSteps, summary });
                }
              } catch {
                /* malformed payload — skip the picker */
              }
            }
            // ask_choice fires with ChoiceRequestedError. We parse the
            // structured payload, mount ChoiceConfirm, and let the
            // user drive the next step. Same toToolResult protocol as
            // PlanProposedError / PlanCheckpointError — just a
            // different error tag and payload shape.
            if (ev.toolName === "ask_choice" && ev.content.includes('"ChoiceRequestedError:')) {
              try {
                const parsed = JSON.parse(ev.content) as {
                  question?: unknown;
                  options?: unknown;
                  allowCustom?: unknown;
                };
                const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
                const options = Array.isArray(parsed.options)
                  ? (parsed.options as ChoiceOption[]).filter(
                      (o) =>
                        o &&
                        typeof o.id === "string" &&
                        o.id.trim() &&
                        typeof o.title === "string" &&
                        o.title.trim(),
                    )
                  : [];
                if (question && options.length >= 2) {
                  setPendingChoice({
                    question,
                    options,
                    allowCustom: parsed.allowCustom === true,
                  });
                }
              } catch {
                /* malformed payload — skip the picker */
              }
            }
            // mark_step_complete fires during plan execution and throws
            // PlanCheckpointError so the loop pauses. The registry
            // serialized `{error, kind, stepId, title?, result, notes?}`
            // via toToolResult(); we extract the step info, push a ✓
            // scrollback row, and mount the checkpoint picker. Silent
            // failure on parse errors — a malformed payload just means
            // no progress row.
            if (ev.toolName === "mark_step_complete") {
              try {
                const parsed = JSON.parse(ev.content) as Partial<StepCompletion> & {
                  error?: string;
                };
                const stepId = parsed.stepId;
                if (parsed.kind === "step_completed" && typeof stepId === "string") {
                  completedStepIdsRef.current.add(stepId);
                  persistPlanState();
                  const total = planStepsRef.current?.length ?? 0;
                  const completed = completedStepIdsRef.current.size;
                  const stepFromPlan = planStepsRef.current?.find((s) => s.id === stepId);
                  const title = parsed.title ?? stepFromPlan?.title;
                  const result = typeof parsed.result === "string" ? parsed.result : "";
                  const notes = parsed.notes;
                  setHistorical((prev) => [
                    ...prev,
                    {
                      id: `step-${stepId}-${Date.now()}-${Math.random()}`,
                      role: "step-progress",
                      text: result,
                      stepProgress: {
                        stepId,
                        title,
                        completed,
                        total,
                        notes,
                      },
                    },
                  ]);
                  // Auto-archive when every step in the plan is now
                  // done. Renaming the active plan.json to a timestamped
                  // .done.json keeps it as a historical artifact while
                  // freeing the active slot so the next session starts
                  // fresh. The completed in-memory state stays put for
                  // the rest of THIS session in case the model wants
                  // to reference it (e.g. summary on Stop).
                  if (session && total > 0 && completed >= total) {
                    const archive = archivePlanState(session);
                    if (archive) {
                      setHistorical((prev) => [
                        ...prev,
                        {
                          id: `plan-archived-${Date.now()}`,
                          role: "info",
                          text: `▸ plan complete — all ${total} step${total === 1 ? "" : "s"} done · archived`,
                        },
                      ]);
                    }
                  }
                  // The error-tagged payload means the tool threw
                  // PlanCheckpointError — loop has paused. Mount the
                  // picker so the user drives what happens next.
                  // Plain success payloads (legacy / test harnesses)
                  // just update progress without pausing.
                  if (
                    typeof parsed.error === "string" &&
                    parsed.error.startsWith("PlanCheckpointError:")
                  ) {
                    setPendingCheckpoint({ stepId, title, completed, total });
                  }
                }
              } catch {
                /* malformed payload — skip the progress row */
              }
            }
          } else if (ev.role === "error") {
            setHistorical((prev) => [
              ...prev,
              { id: `e-${Date.now()}`, role: "error", text: ev.error ?? ev.content },
            ]);
          } else if (ev.role === "warning") {
            setHistorical((prev) => [
              ...prev,
              { id: `w-${Date.now()}-${Math.random()}`, role: "warning", text: ev.content },
            ]);
            // The loop emits warnings starting with "⇧" whenever this
            // turn is (or just became) running on pro — either the
            // /pro armed state was consumed at turn start, or the
            // failure threshold tripped mid-turn. Flip the badge so
            // the user sees the escalation in the header.
            if (ev.content?.startsWith("⇧ ")) setTurnOnPro(true);
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
            setHistorical((prev) => [
              ...prev,
              {
                id: `hs-${Date.now()}-${Math.random()}`,
                role: "warning",
                text: formatHookOutcomeMessage(o),
              },
            ]);
          }
        }
      } finally {
        if (timer) clearInterval(timer);
        setStreaming(null);
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
      applyCwdChange,
      touchedPaths,
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
      setHistorical((prev) => [
        ...prev,
        {
          id: `loop-fire-${Date.now()}`,
          role: "info",
          text: `▸ /loop iter ${nextIter} → ${cur.prompt}`,
        },
      ]);
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
  }, [activeLoop, stopLoop]);

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
        setHistorical((prev) => [
          ...prev,
          { id: `sh-deny-${Date.now()}`, role: "info", text: `▸ denied: ${cmd}${context}` },
        ]);
        synthetic = `I denied running \`${cmd}\`${context}. Please continue without running it.`;
      } else {
        if (choice === "always_allow") {
          const prefix = derivePrefix(cmd);
          addProjectShellAllowed(currentRootDir, prefix);
          setHistorical((prev) => [
            ...prev,
            {
              id: `sh-allow-${Date.now()}`,
              role: "info",
              text: `▸ always allowed "${prefix}" for ${currentRootDir}`,
            },
          ]);
        }
        setHistorical((prev) => [
          ...prev,
          {
            id: `sh-run-${Date.now()}`,
            role: "info",
            text:
              kind === "run_background" ? `▸ starting (background): ${cmd}` : `▸ running: ${cmd}`,
          },
        ]);
        if (kind === "run_background" && codeMode.jobs) {
          // Spawn through the JobRegistry so the process keeps running
          // after this handler resolves; the synthetic message tells the
          // model the job id so it can call job_output / stop_job next.
          let startedOk = false;
          let jobId: number | null = null;
          let preview = "";
          try {
            const res = await codeMode.jobs.start(cmd, { cwd: currentRootDir });
            startedOk = true;
            jobId = res.jobId;
            preview = res.preview;
            const header = res.stillRunning
              ? `[job ${res.jobId} started · pid ${res.pid ?? "?"} · ${res.readyMatched ? "READY signal matched" : "running"}]`
              : res.exitCode !== null
                ? `[job ${res.jobId} exited during startup · exit ${res.exitCode}]`
                : `[job ${res.jobId} failed to start]`;
            const body = preview ? `${header}\n${preview}` : header;
            setHistorical((prev) => [
              ...prev,
              { id: `sh-out-${Date.now()}`, role: "info", text: body },
            ]);
            synthetic = `I approved the background spawn. ${header}\n\nStartup preview:\n\n${preview || "(no output yet)"}\n\nThe process is still running — use job_output to read newer logs, stop_job to halt it.`;
          } catch (err) {
            const msg = `$ ${cmd}\n[failed to start] ${(err as Error).message}`;
            setHistorical((prev) => [
              ...prev,
              { id: `sh-out-${Date.now()}`, role: "info", text: msg },
            ]);
            synthetic = `I approved the background spawn but it failed to start:\n\n${msg}`;
          }
          void startedOk; // appease "assigned but never used" — retained for future hook
          void jobId;
        } else {
          // Foreground (run_command) — synchronous; waits for exit.
          let body: string;
          try {
            const res = await runCommand(cmd, { cwd: currentRootDir });
            body = formatCommandResult(cmd, res);
          } catch (err) {
            body = `$ ${cmd}\n[failed to spawn] ${(err as Error).message}`;
          }
          setHistorical((prev) => [
            ...prev,
            { id: `sh-out-${Date.now()}`, role: "info", text: body },
          ]);
          synthetic = `I ran the command you requested. Output:\n\n${body}`;
        }
      }

      // If the prior turn is still streaming ("please confirm" chatter),
      // handleSubmit would early-return on busy=true. Abort the in-flight
      // turn and queue the synthetic for the effect below, which fires
      // once busy clears. Otherwise submit directly.
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [pendingShell, codeMode, currentRootDir, handleSubmit, busy, loop],
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
   * WorkspaceConfirm callback. Two outcomes, both ending with a
   * synthetic user message so the model sees what happened on its
   * next turn:
   *   - deny → tell the model the user refused, continue without it.
   *   - switch → call applyCwdChange (same path as `/cwd`), surface
   *     the cwd-change info row to scrollback, hand the model a
   *     short confirmation so it can resume the user's request
   *     against the new sandbox.
   */
  const handleWorkspaceConfirm = useCallback(
    async (choice: WorkspaceConfirmChoice, denyContext?: string) => {
      const pending = pendingWorkspace;
      if (!pending) return;
      const target = pending.path;
      setPendingWorkspace(null);

      let synthetic: string;
      if (choice === "deny") {
        const context = denyContext ? ` because: ${denyContext}` : "";
        setHistorical((prev) => [
          ...prev,
          {
            id: `ws-deny-${Date.now()}`,
            role: "info",
            text: `▸ denied workspace switch: ${target}${context}`,
          },
        ]);
        synthetic = `I denied switching the workspace to \`${target}\`${context}. Please continue without changing directories.`;
      } else {
        const info = applyCwdChange(target);
        setHistorical((prev) => [
          ...prev,
          { id: `ws-switch-${Date.now()}`, role: "info", text: info },
        ]);
        synthetic = `I approved the workspace switch. The session is now rooted at \`${target}\` — your filesystem / shell / memory tools resolve against that path on every subsequent call. Continue with my original request from this new root.`;
      }

      // Same race protection as handleShellConfirm: if the prior
      // turn is still streaming, abort it and queue the synthetic
      // for the busy=false edge detector below.
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [pendingWorkspace, applyCwdChange, busy, loop, handleSubmit],
  );

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
        // Two-step: stash the plan + the intent, show the input, wait
        // for user feedback before pushing anything. Approve collects
        // "last instructions / answers to open questions" (blank is
        // fine, user can just hit Enter). Refine collects required
        // feedback so the model has concrete guidance to revise.
        if (pendingPlan) {
          setStagedInput({ plan: pendingPlan, mode: choice });
          setPendingPlan(null);
        } else if (choice === "approve") {
          // /apply-plan fallback path — no pending plan, just approve.
          setStagedInput({ plan: "", mode: "approve" });
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
      const marker = "▸ plan cancelled";
      const synthetic =
        "The plan was cancelled. Drop it entirely. Ask me what I actually want before proposing another plan or making any changes.";
      setHistorical((prev) => [
        ...prev,
        { id: `plan-${choice}-${Date.now()}`, role: "info", text: marker },
      ]);
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [pendingPlan, togglePlanMode, busy, loop, handleSubmit, persistPlanState],
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

      setHistorical((prev) => [
        ...prev,
        { id: `plan-${staged.mode}-${Date.now()}`, role: "info", text: marker },
      ]);
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [stagedInput, togglePlanMode, busy, loop, handleSubmit],
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
      setHistorical((prev) => [
        ...prev,
        { id: `cp-${choice}-${Date.now()}`, role: "info", text: marker },
      ]);
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [pendingCheckpoint, busy, loop, handleSubmit],
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
      setHistorical((prev) => [
        ...prev,
        { id: `cp-revise-${Date.now()}`, role: "info", text: marker },
      ]);
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [stagedCheckpointRevise, busy, loop, handleSubmit],
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
        const synthetic =
          "The user cancelled the choice. Don't act on any of the options you presented. Ask what they actually want before doing anything else.";
        setHistorical((prev) => [
          ...prev,
          { id: `choice-cancel-${Date.now()}`, role: "info", text: "▸ choice cancelled" },
        ]);
        if (busy) {
          loop.abort();
          setQueuedSubmit(synthetic);
        } else {
          await handleSubmit(synthetic);
        }
        return;
      }
      const picked = snap.options.find((o) => o.id === choice.optionId);
      const label = picked ? `${picked.id} · ${picked.title}` : choice.optionId;
      const synthetic = `The user picked option ${choice.optionId}${picked ? ` ("${picked.title}")` : ""}. Proceed with that branch. Do not re-ask the same question.`;
      setHistorical((prev) => [
        ...prev,
        { id: `choice-pick-${Date.now()}`, role: "info", text: `▸ chose ${label}` },
      ]);
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [pendingChoice, busy, loop, handleSubmit],
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
  const handleWorkspaceConfirmRef = useRef(handleWorkspaceConfirm);
  useEffect(() => {
    handleWorkspaceConfirmRef.current = handleWorkspaceConfirm;
  }, [handleWorkspaceConfirm]);
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
      setHistorical((prev) => [
        ...prev,
        { id: `choice-custom-${Date.now()}`, role: "info", text: marker },
      ]);
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [busy, loop, handleSubmit],
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
        const synthetic =
          "The user rejected the proposed plan revision. Don't apply it. Continue executing the original plan from the next pending step. If you genuinely cannot proceed without the change, stop and explain in plain text why.";
        setHistorical((prev) => [
          ...prev,
          { id: `revise-reject-${Date.now()}`, role: "info", text: "▸ revision rejected" },
        ]);
        if (busy) {
          loop.abort();
          setQueuedSubmit(synthetic);
        } else {
          await handleSubmit(synthetic);
        }
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
      setHistorical((prev) => [
        ...prev,
        { id: `revise-accept-${Date.now()}`, role: "info", text: marker },
      ]);
      const synthetic = `Revision accepted. The remaining plan is now:\n${snap.remainingSteps
        .map((s, i) => `  ${i + 1}. ${s.id} · ${s.title} — ${s.action}`)
        .join(
          "\n",
        )}\n\nContinue executing from the next pending step. Call mark_step_complete after each one as before.`;
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [pendingRevision, busy, loop, handleSubmit, persistPlanState],
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

  // KeystrokeProvider is mounted by chat.tsx OUTSIDE this component
  // so `useKeystroke` calls in App's function body see the bus.
  return (
    <>
      <TickerProvider
        disabled={
          PLAIN_UI ||
          isResizing ||
          !!pendingPlan ||
          !!pendingShell ||
          !!pendingWorkspace ||
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
          (!busy && !streaming)
        }
      >
        <Box
          flexDirection="column"
          height={stdout?.rows ?? 30}
          width={stdout?.columns ?? 80}
          overflow="hidden"
        >
          <ChromeBar
            summary={summary}
            planMode={planMode}
            preset={preset}
            balance={balance}
            updateAvailable={updateAvailable}
            proArmed={proArmed}
            escalated={turnOnPro}
            budgetUsd={loop.budgetUsd}
            rootDir={codeMode ? currentRootDir : undefined}
            sessionName={session ?? null}
            scrollRatio={
              scrollMaxRowsRef.current > 0 ? logScrollOffset / scrollMaxRowsRef.current : 0
            }
          />

          {/* SCROLLABLE LOG REGION — historical events render inline
              (no Static, since alt-screen kills scrollback anyway).
              EXPLICIT height instead of `flexGrow={1}` so the height
              is deterministic and doesn't depend on the row-estimator
              being correct. `overflow="hidden"` clips overflowing
              children so the StatsPanel + prompt block above and
              below stay anchored.
              Height shrinks toward 0 when a modal is active — the
              modal needs the screen real estate; conversation context
              behind a confirm dialog is rarely useful, and rendering
              both fights for the same vertical space. */}
          <Box
            flexDirection="column"
            flexGrow={1}
            height={
              pendingShell ||
              pendingWorkspace ||
              pendingPlan ||
              pendingEditReview ||
              pendingCheckpoint ||
              stagedCheckpointRevise ||
              stagedInput ||
              stagedChoiceCustom ||
              pendingChoice ||
              pendingRevision ||
              walkthroughActive
                ? 0
                : Math.max(5, (stdout?.rows ?? 30) - 9)
            }
            overflow="hidden"
          >
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              <Box
                flexDirection="column"
                flexGrow={1}
                // At offset=0 we want the LATEST event's bottom flush with
                // the bottom of the viewport so a tall final entry shows
                // its END (the most-recent rows the model just produced),
                // with overflow="hidden" naturally clipping the top above
                // the viewport. When the user has scrolled up (offset>0)
                // we revert to top-anchored so the start of the slice
                // aligns with the top of the viewport — that's the natural
                // "reading older content" mode.
                justifyContent={logScrollOffset === 0 ? "flex-end" : "flex-start"}
                overflow="hidden"
              >
                {(() => {
                  // Single source of truth for "rows the log can render".
                  // Matches the parent flex container's height (set below
                  // and by ScrollBar). When BottomHint is visible we
                  // shrink by 1 so the slicer doesn't claim a row that's
                  // actually taken by the hint.
                  const logHeight = Math.max(5, (stdout?.rows ?? 30) - 9);
                  const available = Math.max(4, logHeight - (logScrollOffset > 0 ? 1 : 0));
                  const cols = stdout?.columns ?? 80;
                  // Build atom list across all events, slice by row range.
                  // Migrated roles produce `frame` atoms (row-precise clip
                  // via topSkip / bottomSkip); unmigrated roles produce
                  // `ink` atoms (snap to atom boundaries — wheel briefly
                  // sticks at their edges until those roles are migrated).
                  const atoms = eventsToAtoms(historical, currentRootDir, cols);
                  const v = viewportLog(atoms, logScrollOffset, available);
                  scrollMaxRowsRef.current = v.maxScrollRows;
                  lastTotalRowsRef.current = v.totalRows;
                  return renderViewport(v);
                })()}
                {/*
          Welcome card on the empty state. Visible only when nothing
          has happened yet (no past events, nothing in flight, no
          modal up). Removes the "what do I type?" friction without
          surviving past the first turn.
        */}
                {!historical.some((e) => e.role === "user" || e.role === "assistant") &&
                !busy &&
                !streaming ? (
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
                !pendingWorkspace &&
                !pendingPlan &&
                !stagedInput &&
                !pendingEditReview &&
                !pendingCheckpoint &&
                !stagedCheckpointRevise &&
                streaming ? (
                  <Box marginY={1}>
                    <EventRow event={streaming} projectRoot={currentRootDir} />
                  </Box>
                ) : null}
                {!PLAIN_UI &&
                !pendingShell &&
                !pendingWorkspace &&
                !pendingPlan &&
                !stagedInput &&
                !pendingEditReview &&
                !pendingCheckpoint &&
                !stagedCheckpointRevise &&
                ongoingTool ? (
                  <OngoingToolRow tool={ongoingTool} progress={toolProgress} />
                ) : null}
                {!PLAIN_UI &&
                !pendingShell &&
                !pendingWorkspace &&
                !pendingPlan &&
                !stagedInput &&
                !pendingEditReview &&
                !pendingCheckpoint &&
                !stagedCheckpointRevise &&
                subagentActivity ? (
                  <SubagentRow activity={subagentActivity} />
                ) : null}
                {!PLAIN_UI &&
                !pendingShell &&
                !pendingWorkspace &&
                !pendingPlan &&
                !stagedInput &&
                !pendingEditReview &&
                !pendingCheckpoint &&
                !stagedCheckpointRevise &&
                !ongoingTool &&
                statusLine ? (
                  <StatusRow text={statusLine} />
                ) : null}
                {!PLAIN_UI &&
                undoBanner &&
                !pendingShell &&
                !pendingWorkspace &&
                !pendingPlan &&
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
                !pendingWorkspace &&
                !pendingPlan &&
                !stagedInput &&
                !pendingEditReview &&
                !pendingCheckpoint &&
                !stagedCheckpointRevise &&
                busy &&
                !streaming &&
                !ongoingTool &&
                !statusLine ? (
                  <StatusRow text="processing…" />
                ) : null}
              </Box>
              {/* Sticky bottom-of-viewport hint when the user has scrolled
                up — points to how many rows of newer content they're
                missing and how to jump back. Hidden at offset=0 since
                there's nothing below to point to. */}
              <BottomHint
                rowsBelow={logScrollOffset}
                totalRows={lastTotalRowsRef.current}
                viewportRows={Math.max(
                  4,
                  Math.max(5, (stdout?.rows ?? 30) - 9) - (logScrollOffset > 0 ? 1 : 0),
                )}
              />
            </Box>
          </Box>
          {/* STICKY BOTTOM — either an active modal (replaces prompt
              for the duration of the confirm) or the input + suggestion
              area. Always pinned to the last rows of the viewport. */}
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
          ) : pendingPlan ? (
            <PlanConfirm
              plan={pendingPlan}
              steps={planStepsRef.current ?? undefined}
              summary={planSummaryRef.current ?? undefined}
              onChoose={stableHandlePlanConfirm}
              projectRoot={currentRootDir}
            />
          ) : pendingShell ? (
            <ShellConfirm
              command={pendingShell.command}
              allowPrefix={derivePrefix(pendingShell.command)}
              kind={pendingShell.kind}
              onChoose={handleShellConfirm}
            />
          ) : pendingWorkspace ? (
            <WorkspaceConfirm
              path={pendingWorkspace.path}
              currentRoot={currentRootDir}
              mcpServerCount={mcpServers?.length ?? 0}
              onChoose={handleWorkspaceConfirm}
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
              <PromptInput
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
                disabled={busy}
                onHistoryPrev={recallPrev}
                onHistoryNext={recallNext}
              />
              <SlashSuggestions matches={slashMatches} selectedIndex={slashSelected} />
              <AtMentionSuggestions
                matches={atMatches}
                selectedIndex={atSelected}
                query={atPicker?.query ?? ""}
              />
              {slashArgContext ? (
                <SlashArgPicker
                  matches={slashArgMatches}
                  selectedIndex={slashArgSelected}
                  spec={slashArgContext.spec}
                  kind={slashArgContext.kind}
                  partial={slashArgContext.partial}
                />
              ) : null}
            </>
          )}
        </Box>
      </TickerProvider>
    </>
  );
}
