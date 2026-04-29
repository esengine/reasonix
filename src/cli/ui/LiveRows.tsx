import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React as a runtime value (classic transform)
import React from "react";
import type { ApplyResult } from "../../code/edit-blocks.js";
import type { EditMode } from "../../config.js";
import type { JobRegistry } from "../../tools/jobs.js";
import { CharBar } from "./char-bar.js";
import { useElapsedSeconds, useSlowTick, useTick } from "./ticker.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Transient "what's happening now" row shown during silent phases
 * between the primary events — harvest round-trip, R1 thinking
 * about a tool result before the next streaming delta, forced
 * summary. Matches OngoingToolRow's visual language (braille
 * spinner + elapsed seconds) so the user's eyes track the same
 * spot regardless of which kind of wait it is.
 */
export function StatusRow({ text }: { text: string }) {
  const tick = useTick();
  const elapsed = useElapsedSeconds();
  return (
    <Box marginY={1} paddingX={1}>
      <Text color="#c4b5fd" bold>
        {SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}
      </Text>
      <Text>{"  "}</Text>
      <Text color="#c4b5fd">{text}</Text>
      <Text dimColor>{`  ·  ${elapsed}s`}</Text>
    </Box>
  );
}

/**
 * One-line bottom status bar showing the current edit mode, pending
 * queue size (review only), an undo hint (auto only / after /apply),
 * and the Shift+Tab nudge. Rendered immediately above PromptInput so
 * the mode is always in peripheral vision when the user's eyes are at
 * the prompt. Flashes briefly on mode change so Shift+Tab gives a
 * visible acknowledgment without the user having to scan the header.
 *
 * The plan-mode pill takes precedence — when plan mode is on, writes
 * are bounced regardless of edit mode, so surfacing it is more useful
 * than the review/auto toggle.
 */
export function ModeStatusBar({
  editMode,
  pendingCount,
  flash,
  planMode,
  undoArmed,
  jobs,
}: {
  editMode: EditMode;
  pendingCount: number;
  flash: boolean;
  planMode: boolean;
  undoArmed: boolean;
  jobs?: JobRegistry;
}) {
  // Subscribe to the slow tick so the jobs count stays live — the
  // registry is mutated outside React, so we need a periodic repaint
  // to catch it. 1Hz is enough for a count badge: a 1s lag for a job
  // appearing/disappearing is imperceptible vs how long jobs run.
  // No-op when there's no registry (chat mode / tests).
  useSlowTick();
  const running = jobs?.runningCount() ?? 0;
  const jobsTag =
    running > 0 ? (
      <Text color="yellow" bold>{`  ·  ⏵ ${running} job${running === 1 ? "" : "s"}`}</Text>
    ) : null;
  // The same mode pill is already in the StatsPanel header — here we
  // skip the pill and keep just a tight inline hint right above the
  // input so the user has the actionable bit (what y/n/u/Shift+Tab
  // do) without the whole tutorial.
  if (planMode) {
    return (
      <ModeBarFrame>
        <ModePill label="PLAN MODE" bg="red" flash={flash} />
        <Text dimColor>{"   writes gated · /plan off to leave"}</Text>
        {jobsTag}
      </ModeBarFrame>
    );
  }
  const label = editMode === "yolo" ? "YOLO" : editMode === "auto" ? "AUTO" : "REVIEW";
  const bg = editMode === "yolo" ? "red" : editMode === "auto" ? "magenta" : "cyan";
  const mid =
    editMode === "yolo"
      ? "edits + shell auto · /undo to roll back"
      : editMode === "auto"
        ? "edits land now · u to undo"
        : pendingCount > 0
          ? `${pendingCount} queued · y apply · n discard`
          : "edits queued · y apply · n discard";
  return (
    <ModeBarFrame>
      <ModePill label={label} bg={bg} flash={flash} />
      <Text dimColor>{`   ${mid} · Shift+Tab to flip`}</Text>
      {jobsTag}
    </ModeBarFrame>
  );
}

/**
 * Wraps the bottom mode/jobs row in a dim top rule + side padding
 * so the modeline reads as its own zone, separate from the prompt
 * input above. Keeps the live region border-free (the rule is a
 * single Text row, not a bordered Box) so Ink's eraseLines miscount
 * stays out of it.
 */
function ModeBarFrame({ children }: { children: React.ReactNode }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const ruleWidth = Math.max(20, cols - 2);
  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color="#475569" dimColor>
          {"╌".repeat(ruleWidth)}
        </Text>
      </Box>
      <Box paddingX={1}>{children}</Box>
    </Box>
  );
}

/**
 * Solid-background mode badge so the bottom status bar reads at a
 * glance — bracket-text style matching the StatsPanel chrome at top
 * (one canonical pill style across the whole TUI). `flash` inverts
 * briefly after a mode flip so the user sees "yes, it changed"; once
 * the flash fades it returns to its quiet bracket form.
 *
 * Why bracket and not solid bg: the mode is already shown in the top
 * chrome's pill. Repeating the same info as a loud, padded block
 * directly above the prompt was visual repetition, not reinforcement.
 * Bracket here keeps the actionable hint readable while the flash
 * still does its acknowledgement job.
 */
function ModePill({
  label,
  bg,
  flash,
}: {
  label: string;
  bg: "magenta" | "cyan" | "red";
  flash: boolean;
}) {
  return (
    <Text color={bg} bold inverse={flash}>
      {`[${label}]`}
    </Text>
  );
}

/**
 * "Just auto-applied N edits — press u to undo" banner. Rendered below
 * the live rows after an auto-mode edit batch lands, visible for 5s.
 * The countdown ticks once per second — slow tick is the right
 * cadence here (faster re-renders just redraw the same digit).
 * State cleanup (the banner disappearing) happens in the parent's
 * setTimeout — the component is purely display.
 */
export function UndoBanner({
  banner,
}: {
  banner: { results: ApplyResult[]; expiresAt: number };
}) {
  // Fast tick so the char bar shrinks one cell at a time rather than
  // jumping in 1s gulps. With FAST_TICK_MS=120 we get ~42 frames over
  // a 5s window — smooth enough that the bar reads as a continuous
  // countdown without looking like a stutter.
  useTick();
  const totalMs = 5000; // mirrors armUndoBanner's hard-coded window
  const remainingMs = Math.max(0, banner.expiresAt - Date.now());
  const remainingSec = Math.ceil(remainingMs / 1000);
  const ok = banner.results.filter((r) => r.status === "applied" || r.status === "created").length;
  const total = banner.results.length;
  const urgent = remainingSec <= 1;
  // 20-cell bar, 4 cells per second. Filled = remaining time.
  const pct = (remainingMs / totalMs) * 100;
  return (
    <Box marginY={1} paddingX={1}>
      <Text backgroundColor="#c4b5fd" color="black" bold>
        {` ✓ AUTO-APPLIED ${ok}/${total} `}
      </Text>
      <Text dimColor>{"   press "}</Text>
      <Text backgroundColor="#67e8f9" color="black" bold>
        {" u "}
      </Text>
      <Text dimColor>{" to undo  "}</Text>
      <CharBar pct={pct} width={20} color={urgent ? "#f87171" : "#c4b5fd"} showLabel={false} />
      <Text dimColor>{"  "}</Text>
      <Text color={urgent ? "#f87171" : "#c4b5fd"} bold={urgent}>
        {`${remainingSec}s`}
      </Text>
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
export function SubagentRow({
  activity,
}: {
  activity: { task: string; iter: number; elapsedMs: number };
}) {
  const tick = useTick();
  const seconds = (activity.elapsedMs / 1000).toFixed(1);
  // Bracket-text style — same vocabulary as the static ToolPill so a
  // turn that contains both finished tools and a live subagent reads
  // as a consistent column. The braille spinner + colored ⌬ + colored
  // name carry enough weight without a solid-bg block.
  return (
    <Box paddingLeft={3}>
      <Text color="#c4b5fd" bold>
        {SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}
      </Text>
      <Text>{"  "}</Text>
      <Text color="#c4b5fd" bold>
        ⌬ subagent
      </Text>
      <Text color="#c4b5fd">{`  ${activity.task}`}</Text>
      <Text dimColor>{`   iter ${activity.iter}  ·  ${seconds}s`}</Text>
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
 * Shows three signals: a braille spinner (liveness), an elapsed
 * timer in seconds (so "long" has a number attached), and a
 * per-tool summary of the most informative argument fields (path,
 * edits count, pattern, etc.). As of 0.4.8, MCP progress frames
 * (`notifications/progress`) land here too — bar + "n/N" when the
 * server reports a total, free-form message when not.
 */
export function OngoingToolRow({
  tool,
  progress,
}: {
  tool: { name: string; args?: string };
  progress: { progress: number; total?: number; message?: string } | null;
}) {
  const tick = useTick();
  const elapsed = useElapsedSeconds();
  const summary = summarizeToolArgs(tool.name, tool.args);
  // Bracket-text style — matches the static ToolPill that lands once
  // the call resolves, so a row of in-flight + finished tools reads
  // as one continuous column instead of two visual languages.
  return (
    <Box marginY={1} flexDirection="column" paddingX={1}>
      <Box>
        <Text color="#fcd34d" bold>
          {SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}
        </Text>
        <Text>{"  "}</Text>
        <Text color="#fcd34d" bold>
          {`▣ ${tool.name}`}
        </Text>
        <Text dimColor>{`  running · ${elapsed}s`}</Text>
      </Box>
      {progress ? (
        <Box paddingLeft={3}>
          <Text color="#67e8f9">{renderProgressLine(progress)}</Text>
        </Box>
      ) : null}
      {summary ? (
        <Box paddingLeft={3}>
          <Text dimColor>{summary}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

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
