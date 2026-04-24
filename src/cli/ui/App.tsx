import type { WriteStream } from "node:fs";
import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  detectAtPicker,
  expandAtMentions,
  listFilesSync,
  rankPickerCandidates,
} from "../../at-mentions.js";
import {
  type ApplyResult,
  type EditBlock,
  type EditSnapshot,
  applyEditBlocks,
  parseEditBlocks,
  restoreSnapshots,
  snapshotBeforeEdits,
} from "../../code/edit-blocks.js";
import { addProjectShellAllowed } from "../../config.js";
import { type ResolvedHook, formatHookOutcomeMessage, loadHooks, runHooks } from "../../hooks.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";
import type { LoopEvent } from "../../loop.js";
import type { SessionSummary } from "../../telemetry.js";
import type { ToolRegistry } from "../../tools.js";
import { formatCommandResult, runCommand } from "../../tools/shell.js";
import { registerSkillTools } from "../../tools/skills.js";
import {
  type SubagentEvent,
  type SubagentSink,
  formatSubagentResult,
  spawnSubagent,
} from "../../tools/subagent.js";
import { openTranscriptFile, recordFromLoopEvent, writeRecord } from "../../transcript.js";
import { appendUsage } from "../../usage.js";
import { VERSION, compareVersions, getLatestVersion } from "../../version.js";
import { AtMentionSuggestions } from "./AtMentionSuggestions.js";
import { type DisplayEvent, EventRow } from "./EventLog.js";
import { PlanConfirm, type PlanConfirmChoice } from "./PlanConfirm.js";
import { PlanRefineInput } from "./PlanRefineInput.js";
import { PromptInput } from "./PromptInput.js";
import { ShellConfirm, type ShellConfirmChoice, derivePrefix } from "./ShellConfirm.js";
import { SlashSuggestions } from "./SlashSuggestions.js";
import { StatsPanel } from "./StatsPanel.js";
import { type McpServerSummary, handleSlash, parseSlash, suggestSlashCommands } from "./slash.js";
import { TickerProvider, useElapsedSeconds, useTick } from "./ticker.js";

export interface AppProps {
  model: string;
  system: string;
  transcript?: string;
  harvest?: boolean;
  branch?: number;
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
   * apply them to disk under `rootDir`. Set by `reasonix code`.
   */
  codeMode?: { rootDir: string };
}

/**
 * Throttle interval in ms. We flush streaming deltas at most this often to
 * avoid re-rendering the whole UI on every single token from DeepSeek.
 * 100ms ≈ 10Hz, still feels live, gives fragile terminals (winpty/MINTTY)
 * enough room to finish a repaint before the next one arrives.
 */
const FLUSH_INTERVAL_MS = 100;

/**
 * True when the user has opted out of live spinner/streaming rows.
 * `REASONIX_UI=plain` suppresses every transient row in the render
 * tree so only the `<Static>` committed history + the input prompt
 * are drawn. Trades liveness for stability on terminals where Ink's
 * cursor-up repaint leaves ghost artifacts.
 */
const PLAIN_UI = process.env.REASONIX_UI === "plain";

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
  session,
  tools,
  mcpSpecs,
  mcpServers,
  progressSink,
  codeMode,
}: AppProps) {
  const { exit } = useApp();
  const [historical, setHistorical] = useState<DisplayEvent[]>([]);
  const [streaming, setStreaming] = useState<DisplayEvent | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Tracks whether the current turn has been aborted via Esc, so the
  // Esc handler only fires once per turn (repeated presses would yield
  // stacked warning events).
  const abortedThisTurn = useRef(false);
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
  // Live state for an in-flight subagent. The subagent runs inside a
  // tool dispatch frame, so its events come in via a sink ref instead
  // of through the parent loop's event channel. `null` when no
  // subagent is currently active. A new spawn overwrites the previous
  // entry — MVP is serial, never two at once.
  const [subagentActivity, setSubagentActivity] = useState<{
    task: string;
    iter: number;
    elapsedMs: number;
  } | null>(null);
  // Transient "what's happening" text set by the loop during silent
  // phases (harvest round-trip, between-iteration R1 thinking, forced
  // summary). Rendered as a dim spinner row; auto-cleared on the next
  // primary event.
  const [statusLine, setStatusLine] = useState<string | null>(null);
  // DeepSeek account balance — fetched once on mount, refreshed after
  // each completed turn so the "how much do I have left" number
  // tracks reality. `null` means either the endpoint failed or we
  // haven't fetched yet; the panel hides the cell in that case.
  const [balance, setBalance] = useState<{ currency: string; total: number } | null>(null);
  // Model catalog fetched from DeepSeek's /models endpoint once at
  // launch. `null` while the call is in flight or failed; `[]` means
  // the API answered with zero models (unlikely but possible). Powers
  // /models and validation in /model.
  const [models, setModels] = useState<string[] | null>(null);
  // Latest published version the npm registry returned, REGARDLESS
  // of whether it's newer than what we're running. `null` only while
  // the background check is in flight or when the network fails —
  // so `/update` can distinguish "on latest" from "still fetching".
  // The yellow header badge is derived: it only lights up when the
  // fetched version is STRICTLY newer, but the slash surfaces the
  // raw value so the user always gets a concrete number.
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const updateAvailable =
    latestVersion && compareVersions(VERSION, latestVersion) < 0 ? latestVersion : null;
  // Loaded user hooks (project + global settings.json). Stays mutable
  // so `/hooks reload` can rescan disk without reconstructing the
  // loop. The loop holds a parallel reference for its tool-event
  // dispatch; we keep them in sync via the effect below.
  const [hookList, setHookList] = useState<ResolvedHook[]>(() =>
    loadHooks({ projectRoot: codeMode?.rootDir }),
  );
  // Working directory reported in every hook's stdin payload. Hook
  // scripts that `cd $REASONIX_CWD` (or read `cwd` from the JSON
  // envelope) land in the project root, not the user's shell home.
  const hookCwd = codeMode?.rootDir ?? process.cwd();
  // Snapshots of every file the *last* edit batch touched, keyed by
  // nothing more than "most recent". `/undo` restores from this ref
  // and nulls it out — one level of undo, Aider-style. Multi-step
  // undo would need a proper history stack and a clear policy for
  // when the stack clears; v1 keeps it simple.
  const lastEditSnapshots = useRef<EditSnapshot[] | null>(null);
  // Pending edit blocks awaiting `/apply` or `/discard`. We do NOT
  // auto-apply — v0.4.1 showed that "model proposed, so apply" turns
  // analysis into unintended edits. The user explicitly confirms now.
  const pendingEdits = useRef<EditBlock[]>([]);
  // Shell command the model asked to run that wasn't on the auto-run
  // allowlist. Non-null renders the ShellConfirm modal and disables
  // the prompt input; the user picks Run once / Always allow in this
  // project / Deny and we feed the result back as a synthetic user
  // message so the model sees what happened.
  const [pendingShell, setPendingShell] = useState<string | null>(null);
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
  // Plan-mode indicator — displayed in the StatsPanel, mirrored onto
  // the ToolRegistry so dispatch enforces read-only. Toggled via the
  // `/plan` slash and PlanConfirm picker. Ephemeral — not persisted
  // across launches (you explicitly opt in per session).
  const [planMode, setPlanMode] = useState<boolean>(false);
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
  // Full untruncated tool results, in arrival order. The EventLog
  // renderer clips tool output at 400 chars for display; `/tool N`
  // reads from this ref to show the real thing. Not persisted — a
  // resumed session replays the log (which has the same content in
  // `tool` messages) but we don't repopulate this ref on resume
  // because the user wouldn't expect `/tool` to reach back across
  // process boundaries.
  const toolHistoryRef = useRef<Array<{ toolName: string; text: string }>>([]);
  // Highlighted suggestion index. ↑/↓ move within the current match
  // set while the user is typing a `/…` prefix; Enter or Tab pick.
  const [slashSelected, setSlashSelected] = useState(0);
  const [summary, setSummary] = useState<SessionSummary>({
    turns: 0,
    totalCostUsd: 0,
    totalInputCostUsd: 0,
    totalOutputCostUsd: 0,
    claudeEquivalentUsd: 0,
    savingsVsClaudePct: 0,
    cacheHitRatio: 0,
    lastPromptTokens: 0,
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

  // The currently matching slash suggestions, or `null` when the
  // user isn't in slash-prefix mode. Shared between the useInput
  // handler (navigation + Tab-complete) and SlashSuggestions
  // (rendering + highlight) so both stay in sync.
  const slashMatches = useMemo(() => {
    if (!input.startsWith("/") || input.includes(" ")) return null;
    return suggestSlashCommands(input.slice(1), !!codeMode);
  }, [input, codeMode]);
  useEffect(() => {
    // Keep selection in range whenever the match set shrinks. Reset
    // to 0 whenever we re-enter slash mode (matches goes null → array
    // triggers the useEffect too).
    setSlashSelected((prev) => {
      if (!slashMatches || slashMatches.length === 0) return 0;
      if (prev >= slashMatches.length) return slashMatches.length - 1;
      return prev;
    });
  }, [slashMatches]);

  // File picker for `@` mentions — only meaningful in code mode where
  // the model has filesystem tools and expandAtMentions is active.
  const [atSelected, setAtSelected] = useState(0);
  // Walk the code root ONCE on mount. Files created mid-session via
  // tool edits won't appear until restart — rare, and the user can
  // always type the full path (picker's a convenience, not a gate).
  const atFiles = useMemo<readonly string[]>(() => {
    if (!codeMode?.rootDir) return [];
    try {
      return listFilesSync(codeMode.rootDir, { maxResults: 500 });
    } catch {
      return [];
    }
  }, [codeMode?.rootDir]);
  // Detect the trailing `@…` prefix and the partial query. `null` when
  // we're not in picker mode (non-code mode, buffer doesn't end in a
  // mention-in-progress, or already in slash mode).
  const atPicker = useMemo(() => {
    if (!codeMode?.rootDir) return null;
    // Slash prefix wins — avoids the picker confusingly surfacing on
    // `/@wat`-style edge inputs.
    if (slashMatches !== null) return null;
    return detectAtPicker(input);
  }, [codeMode?.rootDir, input, slashMatches]);
  const atMatches = useMemo<readonly string[] | null>(() => {
    if (!atPicker) return null;
    return rankPickerCandidates(atFiles, atPicker.query, 40);
  }, [atPicker, atFiles]);
  useEffect(() => {
    setAtSelected((prev) => {
      if (!atMatches || atMatches.length === 0) return 0;
      if (prev >= atMatches.length) return atMatches.length - 1;
      return prev;
    });
  }, [atMatches]);
  // Substitute the trailing `@partial` with `@chosenPath ` and keep
  // the rest of the buffer intact. The trailing space auto-closes
  // the picker (regex no longer matches) so Enter next time submits
  // cleanly without needing an explicit dismissal.
  const pickAtMention = useCallback(
    (chosenPath: string) => {
      if (!atPicker) return;
      const before = input.slice(0, atPicker.atOffset);
      setInput(`${before}@${chosenPath} `);
    },
    [atPicker, input],
  );

  const loopRef = useRef<CacheFirstLoop | null>(null);
  // Sink the subagent tool emits live events through (`start` →
  // `progress` → `end`). App attaches its updater on first loop
  // construction; the registration captures the ref by closure so even
  // late spawns find the current handler.
  const subagentSinkRef = useRef<SubagentSink>({ current: null });
  // hookList + hookCwd intentionally NOT in deps — they seed the loop
  // on first construction (loopRef guards a single instantiation), and
  // later edits flow in through the mutable `loop.hooks = hookList`
  // effect below. Putting them in deps would tear down the loop on
  // every reload, wiping the append-only log mid-session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hookList — see comment above
  // biome-ignore lint/correctness/useExhaustiveDependencies: hookCwd — see comment above
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
      session,
      hooks: hookList,
      hookCwd,
    });
    loopRef.current = l;
    return l;
  }, [model, system, harvest, branch, session, tools, codeMode]);

  // Keep the loop's hook list in sync after a `/hooks reload`. The
  // loop's field is intentionally mutable for exactly this case —
  // construction happens once, hook edits are picked up live.
  useEffect(() => {
    loop.hooks = hookList;
  }, [loop, hookList]);

  // Fetch balance once the API key is known. Non-blocking — the
  // session works without it; `null` hides the cell. We also refresh
  // after each completed turn (inside handleSubmit's finally) so the
  // number tracks actual spend rather than freezing at mount-time.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bal = await loop.client.getBalance().catch(() => null);
      if (cancelled || !bal || !bal.balance_infos.length) return;
      const primary = bal.balance_infos[0]!;
      setBalance({ currency: primary.currency, total: Number(primary.total_balance) });
    })();
    return () => {
      cancelled = true;
    };
  }, [loop]);

  // Fetch the model catalog from DeepSeek once. Same pattern as
  // balance: silent degrade on failure (stays null), so /models can
  // tell "still loading / offline" apart from "loaded, here's the list."
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await loop.client.listModels().catch(() => null);
      if (cancelled || !list) return;
      setModels(list.data.map((m) => m.id));
    })();
    return () => {
      cancelled = true;
    };
  }, [loop]);

  // Background registry check — 24h disk cache absorbs repeated
  // launches, timeout bounded so a flaky network doesn't delay the
  // notification. Set to `null` on failure (silent: no network, no
  // problem). We store the raw version regardless of whether it's
  // newer; the header badge's newer-only check happens at the
  // `updateAvailable` derivation above.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const latest = await getLatestVersion();
      if (cancelled || !latest) return;
      setLatestVersion(latest);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Wire the subagent sink. `start` opens the activity row; each
  // `progress` updates iter + elapsed in place; `end` clears the row
  // and posts an info line summarizing the run. Only one subagent is
  // active at a time in the MVP, so we treat overlapping events as a
  // simple replace.
  useEffect(() => {
    subagentSinkRef.current.current = (ev: SubagentEvent) => {
      if (ev.kind === "start") {
        setSubagentActivity({
          task: ev.task,
          iter: ev.iter ?? 0,
          elapsedMs: ev.elapsedMs ?? 0,
        });
        return;
      }
      if (ev.kind === "progress") {
        setSubagentActivity({
          task: ev.task,
          iter: ev.iter ?? 0,
          elapsedMs: ev.elapsedMs ?? 0,
        });
        return;
      }
      // end
      setSubagentActivity(null);
      const seconds = ((ev.elapsedMs ?? 0) / 1000).toFixed(1);
      const summary = ev.error
        ? `⌬ subagent "${ev.task}" failed after ${seconds}s · ${ev.iter ?? 0} tool call(s) — ${ev.error}`
        : `⌬ subagent "${ev.task}" done in ${seconds}s · ${ev.iter ?? 0} tool call(s) · ${ev.turns ?? 0} turn(s)`;
      setHistorical((prev) => [
        ...prev,
        {
          id: `subagent-end-${Date.now()}`,
          role: "info",
          text: summary,
        },
      ]);
    };
    return () => {
      subagentSinkRef.current.current = null;
    };
  }, []);

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
  }, [session, loop]);

  // Esc during busy → forward to the loop as an abort signal. The loop
  // finishes the tool call in flight (we can't kill subprocess stdio
  // mid-write), then diverts to its no-tools summary path so the user
  // gets an answer instead of a hard stop. Only listens while busy so
  // we don't accidentally hijack Esc in other contexts.
  //
  // Also handles ↑/↓ shell-style history while idle. We don't use
  // ink-text-input's (absent) history support; parent-level useInput
  // is simpler and lets us own the cursor semantics.
  useInput((_input, key) => {
    if (key.escape && busy) {
      if (abortedThisTurn.current) return;
      abortedThisTurn.current = true;
      loop.abort();
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

    // Outside slash mode: ↑/↓ recall prior prompts — but ONLY when the
    // buffer is empty. A non-empty buffer hands those keys to
    // PromptInput for cursor movement (multi-line navigation, or a
    // no-op on single-line) so the user doesn't accidentally clobber
    // typed text with a recalled prompt.
    if (input.length === 0) {
      const hist = promptHistory.current;
      if (key.upArrow) {
        if (hist.length === 0) return;
        const nextCursor = Math.min(historyCursor.current + 1, hist.length - 1);
        historyCursor.current = nextCursor;
        setInput(hist[hist.length - 1 - nextCursor] ?? "");
        return;
      }
      if (key.downArrow) {
        if (historyCursor.current < 0) return;
        const nextCursor = historyCursor.current - 1;
        historyCursor.current = nextCursor;
        setInput(nextCursor < 0 ? "" : (hist[hist.length - 1 - nextCursor] ?? ""));
        return;
      }
    }
  });

  /**
   * Callback wired into the `/undo` slash command. Restores the files
   * last edit batch to their pre-edit state and reports per-file
   * results. Only available when running in code mode — the slash
   * handler gates on this callback's presence.
   */
  const codeUndo = useCallback((): string => {
    if (!codeMode) return "not in code mode";
    const snaps = lastEditSnapshots.current;
    if (!snaps || snaps.length === 0) {
      return "nothing to undo — no recent edit batch to restore";
    }
    const results = restoreSnapshots(snaps, codeMode.rootDir);
    lastEditSnapshots.current = null;
    return formatUndoResults(results);
  }, [codeMode]);

  /**
   * /apply callback — write pending edit blocks to disk, snapshot
   * beforehand so /undo still works, report per-file results.
   */
  const codeApply = useCallback((): string => {
    if (!codeMode) return "not in code mode";
    const blocks = pendingEdits.current;
    if (blocks.length === 0) {
      return "nothing pending — the assistant hasn't proposed edits since the last /apply or /discard.";
    }
    const snaps = snapshotBeforeEdits(blocks, codeMode.rootDir);
    const results = applyEditBlocks(blocks, codeMode.rootDir);
    const anyApplied = results.some((r) => r.status === "applied" || r.status === "created");
    if (anyApplied) lastEditSnapshots.current = snaps;
    pendingEdits.current = [];
    return formatEditResults(results);
  }, [codeMode]);

  /**
   * /discard callback — forget the pending edits without touching
   * disk. Keeps the conversation going without the user having to
   * argue the model out of its proposal.
   */
  const codeDiscard = useCallback((): string => {
    const count = pendingEdits.current.length;
    if (count === 0) return "nothing pending to discard.";
    pendingEdits.current = [];
    return `▸ discarded ${count} pending edit block(s). Nothing was written to disk.`;
  }, []);

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

  const handleSubmit = useCallback(
    async (raw: string) => {
      let text = raw.trim();
      if (!text || busy) return;

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

      const slash = parseSlash(text);
      if (slash) {
        const result = handleSlash(slash.cmd, slash.args, loop, {
          mcpSpecs,
          mcpServers,
          codeUndo: codeMode ? codeUndo : undefined,
          codeApply: codeMode ? codeApply : undefined,
          codeDiscard: codeMode ? codeDiscard : undefined,
          codeRoot: codeMode?.rootDir,
          pendingEditCount: codeMode ? pendingEdits.current.length : undefined,
          toolHistory: () => toolHistoryRef.current,
          memoryRoot: codeMode?.rootDir ?? process.cwd(),
          planMode,
          setPlanMode: codeMode ? togglePlanMode : undefined,
          clearPendingPlan: codeMode ? clearPendingPlan : undefined,
          reloadHooks: () => {
            const fresh = loadHooks({ projectRoot: codeMode?.rootDir });
            setHookList(fresh);
            return fresh.length;
          },
          latestVersion,
          refreshLatestVersion: () => {
            void (async () => {
              const fresh = await getLatestVersion({ force: true });
              if (fresh) setLatestVersion(fresh);
            })();
          },
          models,
          refreshModels: () => {
            void (async () => {
              const list = await loop.client.listModels().catch(() => null);
              if (list) setModels(list.data.map((m) => m.id));
            })();
          },
        });
        if (result.exit) {
          transcriptRef.current?.end();
          exit();
          return;
        }
        if (result.clear && result.info) {
          // Clear + message: wipe scrollback, then seed the new view
          // with the explanatory info line so the user sees *what
          // happened*. Previously clear alone left them staring at
          // an empty screen with no confirmation.
          setHistorical([
            {
              id: `sys-${Date.now()}`,
              role: "info",
              text: result.info,
            },
          ]);
          return;
        }
        if (result.clear) {
          setHistorical([]);
          return;
        }
        if (result.info) {
          setHistorical((prev) => [
            ...prev,
            {
              id: `sys-${Date.now()}`,
              role: "info",
              text: result.info!,
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
          payload: { event: "UserPromptSubmit", cwd: hookCwd, prompt: text },
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
      promptHistory.current.push(text);
      setHistorical((prev) => [
        ...prev,
        // `leadSeparator`: thin rule above this user turn when history
        // isn't empty — visual pacing for multi-turn sessions. First
        // user message leaves it off so the UI doesn't open with a
        // dangling divider.
        { id: `u-${Date.now()}`, role: "user", text, leadSeparator: prev.length > 0 },
      ]);

      const assistantId = `a-${Date.now()}`;
      // Refs are the source of truth for accumulated streaming text; the React
      // state copy below is only for rendering and gets updated on flush.
      const streamRef: StreamingState = { id: assistantId, text: "", reasoning: "" };
      const contentBuf = { current: "" };
      const reasoningBuf = { current: "" };
      // Coalesces tool_call_delta events into one re-render per flush tick.
      const toolCallBuildBuf: { current: { name: string; chars: number } | null } = {
        current: null,
      };

      setStreaming({ id: assistantId, role: "assistant", text: "", streaming: true });
      setBusy(true);
      abortedThisTurn.current = false;

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
      if (codeMode?.rootDir) {
        const expanded = expandAtMentions(text, codeMode.rootDir);
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

      try {
        for await (const ev of loop.step(modelInput)) {
          writeTranscript(ev);
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
              // Parse SEARCH/REPLACE blocks but DO NOT write them to
              // disk. Store as pending — the user has to say /apply
              // explicitly. This prevents "analyze the project" from
              // silently drifting into "edit the project".
              //
              // `ev.forcedSummary` gates us out entirely: if the loop
              // had to force a summary (budget / aborted / context-
              // guard), its text is a wrap-up, not a plan to execute.
              // Blocks dropped in a forced summary are display-only.
              const blocks = parseEditBlocks(finalText);
              if (blocks.length > 0) {
                pendingEdits.current = blocks;
                setHistorical((prev) => [
                  ...prev,
                  {
                    id: `pending-${Date.now()}`,
                    role: "info",
                    text: formatPendingPreview(blocks),
                  },
                ]);
              }
            }
          } else if (ev.role === "tool_start") {
            // Kick off the visual indicator. Cleared when `tool`
            // (result) or `error` arrives, or on the finally below.
            // Also reset any lingering progress from a prior call so
            // the new spinner starts clean.
            setOngoingTool({ name: ev.toolName ?? "?", args: ev.toolArgs });
            setToolProgress(null);
          } else if (ev.role === "tool") {
            flush();
            setOngoingTool(null);
            setToolProgress(null);
            toolHistoryRef.current.push({
              toolName: ev.toolName ?? "?",
              text: ev.content,
            });
            setHistorical((prev) => [
              ...prev,
              {
                id: `t-${Date.now()}-${Math.random()}`,
                role: "tool",
                text: ev.content,
                toolName: ev.toolName,
              },
            ]);
            // run_command rejected because the command isn't on the
            // auto-allow list. Stash it so the y/n fast-path can run
            // it after user confirmation. Only the latest such request
            // is tracked — a second rejection overwrites the first.
            if (
              codeMode &&
              ev.toolName === "run_command" &&
              ev.content.includes('"NeedsConfirmationError:') &&
              ev.toolArgs
            ) {
              try {
                const parsed = JSON.parse(ev.toolArgs) as { command?: unknown };
                if (typeof parsed.command === "string" && parsed.command.trim()) {
                  setPendingShell(parsed.command.trim());
                }
              } catch {
                /* malformed args — skip the prompt */
              }
            }
            // submit_plan fired while plan mode was on — the registry
            // serialized `{ error, plan }` via PlanProposedError's
            // toToolResult(). Extract the plan and mount PlanConfirm.
            // Only the latest submission is tracked; a second overrides.
            if (
              codeMode &&
              ev.toolName === "submit_plan" &&
              ev.content.includes('"PlanProposedError:')
            ) {
              try {
                const parsed = JSON.parse(ev.content) as { plan?: unknown };
                if (typeof parsed.plan === "string" && parsed.plan.trim()) {
                  setPendingPlan(parsed.plan.trim());
                }
              } catch {
                /* malformed payload — skip the picker */
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
              cwd: hookCwd,
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
        // Refresh balance lazily — don't block the return.
        void (async () => {
          const bal = await loop.client.getBalance().catch(() => null);
          if (bal?.balance_infos.length) {
            const p = bal.balance_infos[0]!;
            setBalance({ currency: p.currency, total: Number(p.total_balance) });
          }
        })();
      }
    },
    [
      busy,
      clearPendingPlan,
      codeApply,
      codeDiscard,
      codeMode,
      codeUndo,
      exit,
      hookCwd,
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
      togglePlanMode,
      writeTranscript,
    ],
  );

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
    async (choice: ShellConfirmChoice) => {
      const cmd = pendingShell;
      if (!cmd || !codeMode) return;
      setPendingShell(null);

      let synthetic: string;
      if (choice === "deny") {
        setHistorical((prev) => [
          ...prev,
          { id: `sh-deny-${Date.now()}`, role: "info", text: `▸ denied: ${cmd}` },
        ]);
        synthetic = `I denied running \`${cmd}\`. Please continue without running it.`;
      } else {
        if (choice === "always_allow") {
          const prefix = derivePrefix(cmd);
          addProjectShellAllowed(codeMode.rootDir, prefix);
          setHistorical((prev) => [
            ...prev,
            {
              id: `sh-allow-${Date.now()}`,
              role: "info",
              text: `▸ always allowed "${prefix}" for ${codeMode.rootDir}`,
            },
          ]);
        }
        setHistorical((prev) => [
          ...prev,
          { id: `sh-run-${Date.now()}`, role: "info", text: `▸ running: ${cmd}` },
        ]);
        let body: string;
        try {
          const res = await runCommand(cmd, { cwd: codeMode.rootDir });
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
    [pendingShell, codeMode, handleSubmit, busy, loop],
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
    [pendingPlan, togglePlanMode, busy, loop, handleSubmit],
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
    async (feedback: string) => {
      const staged = stagedInput;
      setStagedInput(null);
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

  /** Esc on the inline input — restore the picker without resuming. */
  const handleStagedInputCancel = useCallback(() => {
    if (stagedInput?.plan) setPendingPlan(stagedInput.plan);
    setStagedInput(null);
  }, [stagedInput]);

  return (
    <TickerProvider disabled={PLAIN_UI}>
      <Box flexDirection="column">
        <StatsPanel
          summary={summary}
          model={loop.model}
          prefixHash={prefixHash}
          harvestOn={loop.harvestEnabled}
          branchBudget={loop.branchOptions.budget}
          planMode={planMode}
          balance={balance}
          busy={busy}
          updateAvailable={updateAvailable}
        />
        <Static items={historical}>
          {(item) => <EventRow key={item.id} event={item} projectRoot={hookCwd} />}
        </Static>
        {/*
          Live rows are hidden while the ShellConfirm modal is up — the
          model's concurrent "please confirm" stream is noise the user
          doesn't need, and the picker shouldn't fight it for visual
          attention. They come back naturally once the user chooses and
          the next turn begins.
        */}
        {!PLAIN_UI && !pendingShell && !pendingPlan && !stagedInput && streaming ? (
          <Box marginY={1}>
            <EventRow event={streaming} projectRoot={hookCwd} />
          </Box>
        ) : null}
        {!PLAIN_UI && !pendingShell && !pendingPlan && !stagedInput && ongoingTool ? (
          <OngoingToolRow tool={ongoingTool} progress={toolProgress} />
        ) : null}
        {!PLAIN_UI && !pendingShell && !pendingPlan && !stagedInput && subagentActivity ? (
          <SubagentRow activity={subagentActivity} />
        ) : null}
        {!PLAIN_UI &&
        !pendingShell &&
        !pendingPlan &&
        !stagedInput &&
        !ongoingTool &&
        statusLine ? (
          <StatusRow text={statusLine} />
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
        !stagedInput &&
        busy &&
        !streaming &&
        !ongoingTool &&
        !statusLine ? (
          <StatusRow text="processing…" />
        ) : null}
        {stagedInput ? (
          <PlanRefineInput
            mode={stagedInput.mode}
            onSubmit={handleStagedInputSubmit}
            onCancel={handleStagedInputCancel}
          />
        ) : pendingPlan ? (
          <PlanConfirm plan={pendingPlan} onChoose={handlePlanConfirm} projectRoot={hookCwd} />
        ) : pendingShell ? (
          <ShellConfirm
            command={pendingShell}
            allowPrefix={derivePrefix(pendingShell)}
            onChoose={handleShellConfirm}
          />
        ) : (
          <>
            <PromptInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              disabled={busy}
            />
            <SlashSuggestions matches={slashMatches} selectedIndex={slashSelected} />
            <AtMentionSuggestions
              matches={atMatches}
              selectedIndex={atSelected}
              query={atPicker?.query ?? ""}
            />
          </>
        )}
      </Box>
    </TickerProvider>
  );
}

/**
 * Live spinner row while a tool call is in flight. Without this the
 * window between the model's `tool_calls` decision and the tool's
 * result (often seconds for a multi-KB `filesystem_edit_file`) looks
 * like the app has frozen — the streaming assistant display is
 * already cleared and the input is disabled, so there's nothing to
 * look at.
 *
 * We show three signals: a braille spinner (liveness), an elapsed
 * timer in seconds (so "long" has a number attached), and a
 * per-tool summary of the most informative argument fields (path,
 * edits count, pattern, etc.). As of 0.4.8, MCP progress frames
 * (`notifications/progress`) land here too — bar + "n/N" when the
 * server reports a total, free-form message when not.
 */
/**
 * Transient "what's happening now" row shown during silent phases
 * between the primary events — harvest round-trip, R1 thinking
 * about a tool result before the next streaming delta, forced
 * summary. Matches OngoingToolRow's visual language (braille
 * spinner + elapsed seconds) so the user's eyes track the same
 * spot regardless of which kind of wait it is.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function StatusRow({ text }: { text: string }) {
  const tick = useTick();
  const elapsed = useElapsedSeconds();
  return (
    <Box marginY={1}>
      <Text color="magenta">{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}</Text>
      <Text color="magenta">{` ${text}`}</Text>
      <Text dimColor>{` ${elapsed}s`}</Text>
    </Box>
  );
}

/**
 * Live one-line indicator for a running subagent. Sits below the
 * OngoingToolRow (the parent's tool dispatch row for `spawn_subagent`)
 * so the user sees both layers at once: outer "spawn_subagent
 * running…" + inner "⌬ subagent: <task> · iter N · 12.3s". Cleared
 * when the subagent ends; a one-line summary lands in historical.
 */
function SubagentRow({
  activity,
}: {
  activity: { task: string; iter: number; elapsedMs: number };
}) {
  const tick = useTick();
  const seconds = (activity.elapsedMs / 1000).toFixed(1);
  return (
    <Box paddingLeft={2}>
      <Text color="magenta">{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}</Text>
      <Text color="magenta">{` ⌬ subagent: ${activity.task}`}</Text>
      <Text dimColor>{` · iter ${activity.iter} · ${seconds}s`}</Text>
    </Box>
  );
}

function OngoingToolRow({
  tool,
  progress,
}: {
  tool: { name: string; args?: string };
  progress: { progress: number; total?: number; message?: string } | null;
}) {
  const tick = useTick();
  const elapsed = useElapsedSeconds();
  const summary = summarizeToolArgs(tool.name, tool.args);
  return (
    <Box marginY={1} flexDirection="column">
      <Box>
        <Text color="cyan">{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}</Text>
        <Text color="yellow">{` tool<${tool.name}> running…`}</Text>
        <Text dimColor>{` ${elapsed}s`}</Text>
      </Box>
      {progress ? (
        <Box paddingLeft={2}>
          <Text color="cyan">{renderProgressLine(progress)}</Text>
        </Box>
      ) : null}
      {summary ? (
        <Box paddingLeft={2}>
          <Text dimColor>{summary}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Turn raw JSON tool arguments into a one-line human summary. For
 * common filesystem MCP tools we pull the actually-useful fields; for
 * anything else we fall back to a truncated raw string so the user
 * still sees *something* beyond the tool name.
 *
 * Match on suffix (e.g. `_read_file`) rather than exact name because
 * `bridgeMcpTools({ namePrefix: "filesystem_" })` prepends the server
 * namespace — tools arrive as `filesystem_read_file` in practice but
 * callers might wire up anonymous too.
 */
/**
 * Render an MCP progress frame as a single line. When the server
 * reports `total`, show an ASCII progress bar + "n/total pct%";
 * otherwise just "progress" + optional message. Width is modest
 * so the line fits even in a narrow terminal.
 */
function renderProgressLine(p: { progress: number; total?: number; message?: string }): string {
  const msg = p.message ? `  ${p.message}` : "";
  if (p.total && p.total > 0) {
    const ratio = Math.max(0, Math.min(1, p.progress / p.total));
    const width = 20;
    const filled = Math.round(ratio * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const pct = (ratio * 100).toFixed(0);
    return `[${bar}] ${p.progress}/${p.total} ${pct}%${msg}`;
  }
  return `progress: ${p.progress}${msg}`;
}

function summarizeToolArgs(name: string, args?: string): string {
  if (!args || args === "{}") return "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(args) as Record<string, unknown>;
  } catch {
    // Unparseable JSON — show a head slice so user at least sees
    // what the model tried.
    return args.length > 80 ? `${args.slice(0, 80)}…` : args;
  }
  const hasSuffix = (s: string) => name === s || name.endsWith(`_${s}`);
  const path = typeof parsed.path === "string" ? parsed.path : undefined;
  if (hasSuffix("read_file")) {
    const head = typeof parsed.head === "number" ? `, head=${parsed.head}` : "";
    const tail = typeof parsed.tail === "number" ? `, tail=${parsed.tail}` : "";
    return `path: ${path ?? "?"}${head}${tail}`;
  }
  if (hasSuffix("write_file")) {
    const content = typeof parsed.content === "string" ? parsed.content : "";
    return `path: ${path ?? "?"} (${content.length} chars)`;
  }
  if (hasSuffix("edit_file")) {
    const edits = Array.isArray(parsed.edits) ? parsed.edits.length : 0;
    return `path: ${path ?? "?"} (${edits} edit${edits === 1 ? "" : "s"})`;
  }
  if (hasSuffix("list_directory") || hasSuffix("directory_tree")) {
    return `path: ${path ?? "?"}`;
  }
  if (hasSuffix("search_files")) {
    const pattern = typeof parsed.pattern === "string" ? parsed.pattern : "?";
    return `path: ${path ?? "?"} · pattern: ${pattern}`;
  }
  if (hasSuffix("move_file")) {
    const src = typeof parsed.source === "string" ? parsed.source : "?";
    const dst = typeof parsed.destination === "string" ? parsed.destination : "?";
    return `${src} → ${dst}`;
  }
  if (hasSuffix("get_file_info")) {
    return `path: ${path ?? "?"}`;
  }
  return args.length > 80 ? `${args.slice(0, 80)}…` : args;
}

/**
 * Render a batch of SEARCH/REPLACE application results as one
 * human-scannable info line per edit. Prefixes denote status so the
 * line reads well even without color (e.g. when piped to a log file
 * or stripped for screenshots):
 *   ✓ applied  src/foo.ts
 *   ✓ created  src/new.ts
 *   ✗ not-found  src/bar.ts (SEARCH text does not match…)
 */
function formatEditResults(results: ApplyResult[]): string {
  const lines = results.map((r) => {
    const mark = r.status === "applied" || r.status === "created" ? "✓" : "✗";
    const detail = r.message ? ` (${r.message})` : "";
    return `  ${mark} ${r.status.padEnd(11)} ${r.path}${detail}`;
  });
  const ok = results.filter((r) => r.status === "applied" || r.status === "created").length;
  const total = results.length;
  const header = `▸ edit blocks: ${ok}/${total} applied — /undo to roll back, or \`git diff\` to review`;
  return [header, ...lines].join("\n");
}

/**
 * Pending-edits preview shown after each assistant turn that proposed
 * changes. We keep it deliberately thin — path + approximate
 * ±line-count — because a full diff would crowd the TUI and the user
 * can always run `git diff` after /apply.
 */
function formatPendingPreview(blocks: EditBlock[]): string {
  const lines = blocks.map((b) => {
    const removed = b.search === "" ? 0 : countLines(b.search);
    const added = countLines(b.replace);
    const tag = b.search === "" ? "NEW " : "    ";
    return `  ${tag}${b.path}  (-${removed} +${added} lines)`;
  });
  const header = `▸ ${blocks.length} pending edit block(s) — /apply (or y) to commit · /discard (or n) to drop`;
  return [header, ...lines].join("\n");
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  return (s.match(/\n/g)?.length ?? 0) + 1;
}

function formatUndoResults(results: ApplyResult[]): string {
  const lines = results.map((r) => {
    const mark = r.status === "applied" ? "✓" : "✗";
    const detail = r.message ? ` (${r.message})` : "";
    return `  ${mark} ${r.path}${detail}`;
  });
  return [`▸ undo: restored ${results.length} file(s) to pre-edit state`, ...lines].join("\n");
}

function describeRepair(repair: {
  scavenged: number;
  truncationsFixed: number;
  stormsBroken: number;
}): string {
  const parts: string[] = [];
  if (repair.scavenged) parts.push(`scavenged ${repair.scavenged}`);
  if (repair.truncationsFixed) parts.push(`repaired ${repair.truncationsFixed} truncation`);
  if (repair.stormsBroken) parts.push(`broke ${repair.stormsBroken} storm`);
  return parts.length ? `[repair] ${parts.join(", ")}` : "";
}
