import { Box, Text } from "ink";
import React from "react";
import type { ApplyResult } from "../../code/edit-blocks.js";
import type { EditMode } from "../../config.js";
import type { JobRegistry } from "../../tools/jobs.js";
import { useElapsedSeconds, useTick } from "./ticker.js";

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
    <Box marginY={1}>
      <Text color="magenta">{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}</Text>
      <Text color="magenta">{` ${text}`}</Text>
      <Text dimColor>{` ${elapsed}s`}</Text>
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
  // Subscribe to tick so the jobs count stays live — the registry is
  // mutated outside React, so we need a periodic repaint to catch it.
  // No-op when there's no registry (chat mode / tests).
  useTick();
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
      <Box paddingX={1}>
        <Text color="red" bold inverse={flash}>
          plan mode
        </Text>
        <Text dimColor>{"  writes gated · /plan off to leave"}</Text>
        {jobsTag}
      </Box>
    );
  }
  const label = editMode === "auto" ? "auto" : "review";
  const labelColor = editMode === "auto" ? "magenta" : "cyan";
  const mid =
    editMode === "auto"
      ? "edits land now · u to undo"
      : pendingCount > 0
        ? `${pendingCount} queued · y apply · n discard`
        : "edits queued · y apply · n discard";
  return (
    <Box paddingX={1}>
      <Text color={labelColor} bold inverse={flash}>
        {label}
      </Text>
      <Text dimColor>{`  ${mid} · Shift+Tab to flip`}</Text>
      {jobsTag}
    </Box>
  );
}

/**
 * "Just auto-applied N edits — press u to undo" banner. Rendered below
 * the live rows after an auto-mode edit batch lands, visible for 5s.
 * `useTick` drives a crude live countdown so the user sees the window
 * shrinking. State cleanup (the banner disappearing) happens in the
 * parent's setTimeout — the component is purely display.
 */
export function UndoBanner({
  banner,
}: {
  banner: { results: ApplyResult[]; expiresAt: number };
}) {
  useTick();
  const remainingMs = Math.max(0, banner.expiresAt - Date.now());
  const remainingSec = Math.ceil(remainingMs / 1000);
  const ok = banner.results.filter((r) => r.status === "applied" || r.status === "created").length;
  const total = banner.results.length;
  return (
    <Box marginY={1} paddingX={1}>
      <Text color="magenta" bold>
        {"✓ auto-applied "}
      </Text>
      <Text color="magenta">{`${ok}/${total} edit${total === 1 ? "" : "s"}`}</Text>
      <Text dimColor>{" · press "}</Text>
      <Text color="magenta" bold>
        {"u"}
      </Text>
      <Text dimColor>{" to undo  ("}</Text>
      <Text color={remainingSec <= 1 ? "red" : "magenta"}>{`${remainingSec}s`}</Text>
      <Text dimColor>{")"}</Text>
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
  return (
    <Box paddingLeft={2}>
      <Text color="magenta">{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}</Text>
      <Text color="magenta">{` ⌬ subagent: ${activity.task}`}</Text>
      <Text dimColor>{` · iter ${activity.iter} · ${seconds}s`}</Text>
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
