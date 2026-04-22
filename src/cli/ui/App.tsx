import type { WriteStream } from "node:fs";
import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ApplyResult,
  type EditBlock,
  type EditSnapshot,
  applyEditBlocks,
  parseEditBlocks,
  restoreSnapshots,
  snapshotBeforeEdits,
} from "../../code/edit-blocks.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";
import type { LoopEvent } from "../../loop.js";
import type { SessionSummary } from "../../telemetry.js";
import type { ToolRegistry } from "../../tools.js";
import { openTranscriptFile, recordFromLoopEvent, writeRecord } from "../../transcript.js";
import { type DisplayEvent, EventRow } from "./EventLog.js";
import { PromptInput } from "./PromptInput.js";
import { StatsPanel } from "./StatsPanel.js";
import { handleSlash, parseSlash } from "./slash.js";

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
   * When set, parse SEARCH/REPLACE blocks from assistant responses and
   * apply them to disk under `rootDir`. Set by `reasonix code`.
   */
  codeMode?: { rootDir: string };
}

/**
 * Throttle interval in ms. We flush streaming deltas at most this often to
 * avoid re-rendering the whole UI on every single token from DeepSeek.
 * 60ms ≈ 16Hz, fast enough to feel live, slow enough to not thrash Ink.
 */
const FLUSH_INTERVAL_MS = 60;

interface StreamingState {
  id: string;
  text: string;
  reasoning: string;
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
  // Shell-style history of user prompts. ↑/↓ while idle walks it;
  // submit pushes to the end. Cursor -1 = "live input", 0+ = "N turns
  // back from newest". We don't persist history to disk — sessions
  // already keep the message log, and cross-session bash-style recall
  // would need per-project scoping we haven't designed.
  const promptHistory = useRef<string[]>([]);
  const historyCursor = useRef<number>(-1);
  // Full untruncated tool results, in arrival order. The EventLog
  // renderer clips tool output at 400 chars for display; `/tool N`
  // reads from this ref to show the real thing. Not persisted — a
  // resumed session replays the log (which has the same content in
  // `tool` messages) but we don't repopulate this ref on resume
  // because the user wouldn't expect `/tool` to reach back across
  // process boundaries.
  const toolHistoryRef = useRef<Array<{ toolName: string; text: string }>>([]);
  const [summary, setSummary] = useState<SessionSummary>({
    turns: 0,
    totalCostUsd: 0,
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

  const loopRef = useRef<CacheFirstLoop | null>(null);
  const loop = useMemo(() => {
    if (loopRef.current) return loopRef.current;
    const client = new DeepSeekClient();
    const prefix = new ImmutablePrefix({
      system,
      toolSpecs: tools?.specs(),
    });
    const l = new CacheFirstLoop({ client, prefix, tools, model, harvest, branch, session });
    loopRef.current = l;
    return l;
  }, [model, system, harvest, branch, session, tools]);

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

  const handleSubmit = useCallback(
    async (raw: string) => {
      let text = raw.trim();
      if (!text || busy) return;
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
          codeUndo: codeMode ? codeUndo : undefined,
          codeApply: codeMode ? codeApply : undefined,
          codeDiscard: codeMode ? codeDiscard : undefined,
          codeRoot: codeMode?.rootDir,
          pendingEditCount: codeMode ? pendingEdits.current.length : undefined,
          toolHistory: () => toolHistoryRef.current,
        });
        if (result.exit) {
          transcriptRef.current?.end();
          exit();
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

      // User message is immutable — push to Static immediately.
      promptHistory.current.push(text);
      setHistorical((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);

      const assistantId = `a-${Date.now()}`;
      // Refs are the source of truth for accumulated streaming text; the React
      // state copy below is only for rendering and gets updated on flush.
      const streamRef: StreamingState = { id: assistantId, text: "", reasoning: "" };
      const contentBuf = { current: "" };
      const reasoningBuf = { current: "" };

      setStreaming({ id: assistantId, role: "assistant", text: "", streaming: true });
      setBusy(true);
      abortedThisTurn.current = false;

      const flush = () => {
        if (!contentBuf.current && !reasoningBuf.current) return;
        streamRef.text += contentBuf.current;
        streamRef.reasoning += reasoningBuf.current;
        contentBuf.current = "";
        reasoningBuf.current = "";
        setStreaming({
          id: assistantId,
          role: "assistant",
          text: streamRef.text,
          reasoning: streamRef.reasoning || undefined,
          streaming: true,
        });
      };
      const timer = setInterval(flush, FLUSH_INTERVAL_MS);

      try {
        for await (const ev of loop.step(text)) {
          writeTranscript(ev);
          if (ev.role === "assistant_delta") {
            if (ev.content) contentBuf.current += ev.content;
            if (ev.reasoningDelta) reasoningBuf.current += ev.reasoningDelta;
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
            const finalText = ev.content || streamRef.text;
            setHistorical((prev) => [
              ...prev,
              {
                id: assistantId,
                role: "assistant",
                text: finalText,
                reasoning: streamRef.reasoning || undefined,
                planState: ev.planState,
                branch: ev.branch,
                stats: ev.stats,
                repair: repairNote || undefined,
                streaming: false,
              },
            ]);
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
            setOngoingTool({ name: ev.toolName ?? "?", args: ev.toolArgs });
          } else if (ev.role === "tool") {
            flush();
            setOngoingTool(null);
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
      } finally {
        clearInterval(timer);
        setStreaming(null);
        setOngoingTool(null);
        setSummary(loop.stats.summary());
        setBusy(false);
      }
    },
    [busy, codeApply, codeDiscard, codeMode, codeUndo, exit, loop, mcpSpecs, writeTranscript],
  );

  return (
    <Box flexDirection="column">
      <StatsPanel
        summary={summary}
        model={loop.model}
        prefixHash={prefixHash}
        harvestOn={loop.harvestEnabled}
        branchBudget={loop.branchOptions.budget}
      />
      <Static items={historical}>{(item) => <EventRow key={item.id} event={item} />}</Static>
      {streaming ? (
        <Box marginY={1}>
          <EventRow event={streaming} />
        </Box>
      ) : null}
      {ongoingTool ? <OngoingToolRow tool={ongoingTool} /> : null}
      <PromptInput value={input} onChange={setInput} onSubmit={handleSubmit} disabled={busy} />
      <CommandStrip codeMode={!!codeMode} />
    </Box>
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
 * edits count, pattern, etc.). MCP doesn't stream progress today —
 * when it does, this component is where the progress notifications
 * would land.
 */
function OngoingToolRow({ tool }: { tool: { name: string; args?: string } }) {
  const [tick, setTick] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const frameId = setInterval(() => setTick((t) => t + 1), 120);
    const secId = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => {
      clearInterval(frameId);
      clearInterval(secId);
    };
  }, []);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const summary = summarizeToolArgs(tool.name, tool.args);
  return (
    <Box marginY={1} flexDirection="column">
      <Box>
        <Text color="cyan">{frames[tick % frames.length]}</Text>
        <Text color="yellow">{` tool<${tool.name}> running…`}</Text>
        <Text dimColor>{` ${elapsed}s`}</Text>
      </Box>
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

function CommandStrip({ codeMode }: { codeMode: boolean }) {
  return (
    <Box paddingX={2} flexDirection="column">
      <Text dimColor>
        /help · /preset {"<fast|smart|max>"} · /mcp · /compact · /sessions · /setup · /clear · /exit
      </Text>
      {codeMode ? (
        <Text dimColor>
          code mode: /apply (y) · /discard (n) · /undo · /commit "msg" — edits NEVER write without
          /apply
        </Text>
      ) : null}
      <Text dimColor>
        ↑/↓ recall prompts · /retry re-send last · /think see R1 reasoning · /tool N full tool
        output
      </Text>
      <Text dimColor>Esc (while thinking) — abort & summarize what was found so far</Text>
    </Box>
  );
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
