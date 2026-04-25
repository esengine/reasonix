import { Box, Text, useStdout } from "ink";
import React from "react";
import { type TypedPlanState, isPlanStateEmpty } from "../../harvest.js";
import type { BranchProgress, BranchSummary } from "../../loop.js";
import type { TurnStats } from "../../telemetry.js";
import type { PlanStep } from "../../tools/plan.js";
import { PlanStateBlock } from "./PlanStateBlock.js";
import { PlanStepList } from "./PlanStepList.js";
import { Markdown } from "./markdown.js";
import { useElapsedSeconds, useTick } from "./ticker.js";
import { formatDuration, summarizeToolResult } from "./tool-summary.js";

export type DisplayRole =
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "error"
  | "info"
  | "warning"
  /**
   * A plan body pushed to scrollback when the model calls `submit_plan`.
   * Rendered through the full markdown pipeline (not truncated), so the
   * user reads the whole thing in the permanent Static log and the
   * PlanConfirm modal below it stays a tight picker.
   */
  | "plan"
  /**
   * One step of an approved plan ticked off via `mark_step_complete`.
   * Rendered as a compact `✓ step-id · title — result (N/M)` row so
   * the user can glance at the scrollback and see how far along the
   * execution is without scrolling through every tool call.
   */
  | "step-progress"
  /**
   * Pushed once at session startup when an existing plan was loaded
   * from disk. Renders as a bordered box with the step list and
   * progress so the user sees exactly where they left off — much
   * more useful than the bare "2/5 done" info line it replaced.
   */
  | "plan-resumed"
  /**
   * Read-only snapshot of an archived (completed) plan, pushed by
   * the `/replay` slash. Visually distinct from `plan-resumed` —
   * dim border + ⏪ icon — so the user immediately sees this is
   * historical, not the active plan.
   */
  | "plan-replay";

export interface DisplayEvent {
  id: string;
  role: DisplayRole;
  text: string;
  reasoning?: string;
  planState?: TypedPlanState;
  branch?: BranchSummary;
  branchProgress?: BranchProgress;
  toolName?: string;
  /**
   * 1-based position in the session's tool-call history. Rendered as a
   * dim `/tool N` suffix on compact rows so the user can quickly jump
   * to the full output via the existing `/tool` slash command.
   */
  toolIndex?: number;
  /** Wall-clock duration in ms between tool_start and result. */
  durationMs?: number;
  stats?: TurnStats;
  repair?: string;
  streaming?: boolean;
  toolCallBuild?: { name: string; chars: number; index?: number; readyCount?: number };
  /**
   * Populated on `step-progress` rows: the step id, optional title,
   * completion counter, and optional notes. Rendered into the compact
   * single-row layout — no other role reads these fields.
   */
  stepProgress?: {
    stepId: string;
    title?: string;
    completed: number;
    total: number;
    notes?: string;
  };
  /**
   * Populated on `plan-resumed` rows: the structured plan loaded from
   * disk + the set of step ids the user had already completed +
   * a relative-time hint for the header. Rendered as a bordered
   * snapshot so the user picks back up immediately.
   */
  resumedPlan?: {
    steps: PlanStep[];
    completedStepIds: string[];
    relativeTime: string;
    /** Optional human-friendly title; rendered in the banner header when set. */
    summary?: string;
  };
  /**
   * Populated on `plan-replay` rows: the archived plan plus enough
   * navigation context (index / total) for the user to know where
   * they are in the archive history.
   */
  replayPlan?: {
    summary?: string;
    body?: string;
    steps: PlanStep[];
    completedStepIds: string[];
    relativeTime: string;
    archiveBasename: string;
    index: number;
    total: number;
  };
  /**
   * Render a thin horizontal rule above this event. Used to mark
   * "start of a new user turn" so long scrollbacks get visual
   * pacing — without it, five-turn sessions read as one wall of
   * text. Only the *first* user message in a session should leave
   * this off; App.tsx sets it based on whether history is empty.
   */
  leadSeparator?: boolean;
}

/**
 * Reasonix visual language: every event is anchored by a geometric
 * glyph in its role color. Together they form a consistent alphabet
 * (◇ ◆ ▣ ▥ ▲ ✦) the eye learns fast — no text labels needed after
 * the first couple of turns. `◈` is the brand mark, reserved for
 * the app header.
 */
const ROLE_GLYPH = {
  user: "◇",
  assistant: "◆",
  assistantPulse: "◇", // pulse alternate for streaming state
  toolOk: "▣",
  toolErr: "▥",
  warning: "▲",
  error: "✦",
} as const;

function RoleGlyph({
  glyph,
  color,
}: {
  glyph: string;
  color: "cyan" | "green" | "yellow" | "red" | "magenta" | "blue";
}) {
  return (
    <Text color={color} bold>
      {glyph}
    </Text>
  );
}

/**
 * Pad continuation lines so wrapped multi-line text aligns under the
 * glyph indent instead of jumping back to column 0. Header is `glyph
 * (1 col) + "  " (2 cols)`, so subsequent lines need 3 leading spaces
 * to land under the body's first character.
 */
function indentContinuationLines(text: string): string {
  if (!text.includes("\n")) return text;
  return text.split("\n").join("\n   ");
}

export const EventRow = React.memo(function EventRow({
  event,
  projectRoot,
}: {
  event: DisplayEvent;
  projectRoot?: string;
}) {
  if (event.role === "user") {
    return (
      <Box marginTop={event.leadSeparator ? 1 : 0}>
        <RoleGlyph glyph={ROLE_GLYPH.user} color="cyan" />
        <Text>
          {"  "}
          {indentContinuationLines(event.text)}
        </Text>
      </Box>
    );
  }
  if (event.role === "assistant") {
    if (event.streaming) return <StreamingAssistant event={event} />;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <RoleGlyph glyph={ROLE_GLYPH.assistant} color="green" />
          {event.stats ? <Text dimColor>{`  ${event.stats.model}`}</Text> : null}
        </Box>
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {event.branch ? <BranchBlock branch={event.branch} /> : null}
          {event.reasoning ? <ReasoningBlock reasoning={event.reasoning} /> : null}
          {!isPlanStateEmpty(event.planState) ? (
            <PlanStateBlock planState={event.planState!} />
          ) : null}
          {event.text ? (
            <Markdown text={event.text} projectRoot={projectRoot} />
          ) : (
            <Text dimColor>(no content)</Text>
          )}
          {event.stats ? <StatsLine stats={event.stats} /> : null}
          {event.repair ? <Text color="magenta">{event.repair}</Text> : null}
        </Box>
      </Box>
    );
  }
  if (event.role === "tool") {
    // `edit_file` results get a dedicated multi-line diff renderer —
    // colored line-by-line so `-` removals show red, `+` additions
    // show green, unchanged context lines dim. Always full, never
    // truncated: users need to see the whole change to trust /apply.
    const isExplicitError = event.text.startsWith("ERROR:");
    const isEditFile =
      (event.toolName === "edit_file" || event.toolName?.endsWith("_edit_file")) &&
      !isExplicitError;
    if (isEditFile) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <RoleGlyph glyph={ROLE_GLYPH.toolOk} color="yellow" />
            <Text color="yellow" bold>{`  ${event.toolName ?? "?"}`}</Text>
            <Text color="yellow" dimColor>
              {"  →"}
            </Text>
          </Box>
          <Box flexDirection="column" paddingLeft={2} marginTop={1}>
            <EditFileDiff text={event.text} />
          </Box>
        </Box>
      );
    }
    // Compact one-line render for everything else. The summarizer
    // produces a tool-aware one-liner (exit code for shell, line
    // count for read_file, error tag for failures, ...). Full content
    // remains accessible via `/tool N`, hinted as a dim suffix.
    const summary = summarizeToolResult(event.toolName ?? "?", event.text);
    const color = summary.isError ? "red" : "yellow";
    const glyph = summary.isError ? ROLE_GLYPH.toolErr : ROLE_GLYPH.toolOk;
    const marker = summary.isError ? "✗" : "→";
    const durationLabel =
      event.durationMs !== undefined && event.durationMs >= 100
        ? ` (${formatDuration(event.durationMs)})`
        : "";
    const indexHint = event.toolIndex !== undefined ? `  /tool ${event.toolIndex}` : "";
    return (
      <Box>
        <RoleGlyph glyph={glyph} color={color} />
        <Text color={color} bold>{`  ${event.toolName ?? "?"}`}</Text>
        {durationLabel ? <Text dimColor>{durationLabel}</Text> : null}
        <Text color={color} dimColor>{`  ${marker}  `}</Text>
        <Text color={summary.isError ? "red" : undefined} dimColor={!summary.isError}>
          {summary.summary}
        </Text>
        {indexHint ? <Text dimColor>{indexHint}</Text> : null}
      </Box>
    );
  }
  if (event.role === "error") {
    return (
      <Box marginTop={1}>
        <RoleGlyph glyph={ROLE_GLYPH.error} color="red" />
        <Text color="red">
          {"  "}
          {indentContinuationLines(event.text)}
        </Text>
      </Box>
    );
  }
  if (event.role === "info") {
    return (
      <Box>
        <Text dimColor>{event.text}</Text>
      </Box>
    );
  }
  if (event.role === "plan") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
        <Box>
          <Text bold color="cyan">
            {"📋 plan proposed — pick a choice below"}
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Markdown text={event.text} projectRoot={projectRoot} />
        </Box>
      </Box>
    );
  }
  if (event.role === "step-progress") {
    const sp = event.stepProgress;
    const counter = sp && sp.total > 0 ? `  (${sp.completed}/${sp.total})` : "";
    const label = sp?.title ? `${sp.stepId} · ${sp.title}` : (sp?.stepId ?? "");
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color="green" bold>
            ✓
          </Text>
          <Text color="green">{`  ${label}`}</Text>
          <Text dimColor>{counter}</Text>
        </Box>
        {event.text ? (
          <Box paddingLeft={2}>
            <Text dimColor>{event.text}</Text>
          </Box>
        ) : null}
        {sp?.notes ? (
          <Box paddingLeft={2}>
            <Text color="yellow" dimColor>
              {`note: ${sp.notes}`}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  if (event.role === "plan-resumed") {
    const rp = event.resumedPlan;
    if (!rp || rp.steps.length === 0) return null;
    const total = rp.steps.length;
    const done = rp.completedStepIds.length;
    const completedSet = new Set(rp.completedStepIds);
    const statuses = new Map(
      rp.steps.map((s) => [
        s.id,
        completedSet.has(s.id) ? ("done" as const) : ("pending" as const),
      ]),
    );
    // Focus the first pending step so the user immediately sees where
    // execution will resume from. If the plan is fully done, no focus
    // (the picker pattern uses › for "next up").
    const nextStep = rp.steps.find((s) => !completedSet.has(s.id));
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
        <Box flexDirection="column">
          <Box>
            <Text bold color="cyan">
              ▸ resumed plan
            </Text>
            <Text dimColor>{`  ${done}/${total} done · last touched ${rp.relativeTime}`}</Text>
          </Box>
          {rp.summary ? (
            <Box>
              <Text color="cyan">{`  ${rp.summary}`}</Text>
            </Box>
          ) : null}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <PlanStepList steps={rp.steps} statuses={statuses} focusStepId={nextStep?.id} />
        </Box>
      </Box>
    );
  }
  if (event.role === "plan-replay") {
    const r = event.replayPlan;
    if (!r || r.steps.length === 0) return null;
    const total = r.steps.length;
    const completedSet = new Set(r.completedStepIds);
    const done = completedSet.size;
    const statuses = new Map(
      r.steps.map((s) => [s.id, completedSet.has(s.id) ? ("done" as const) : ("pending" as const)]),
    );
    const navHint = r.total > 1 ? ` · ${r.index}/${r.total}` : "";
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
        <Box flexDirection="column">
          <Box>
            <Text bold dimColor>
              ⏪ replay
            </Text>
            <Text
              dimColor
            >{`  completed ${r.relativeTime} · ${done}/${total} done${navHint}`}</Text>
          </Box>
          {r.summary ? (
            <Box>
              <Text dimColor>{`  ${r.summary}`}</Text>
            </Box>
          ) : null}
          <Box>
            <Text dimColor>{`  ${r.archiveBasename}`}</Text>
          </Box>
        </Box>
        {r.body ? (
          <Box marginTop={1} flexDirection="column">
            <Markdown text={r.body} projectRoot={projectRoot} />
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <PlanStepList steps={r.steps} statuses={statuses} />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {r.total > 1
              ? `(read-only · /replay ${r.index === 1 ? 2 : 1} for the ${r.index === 1 ? "next" : "newest"} archive)`
              : "(read-only · this is an archived plan)"}
          </Text>
        </Box>
      </Box>
    );
  }
  if (event.role === "warning") {
    return (
      <Box>
        <RoleGlyph glyph={ROLE_GLYPH.warning} color="yellow" />
        <Text color="yellow">
          {"  "}
          {indentContinuationLines(event.text)}
        </Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text>{event.text}</Text>
    </Box>
  );
});

/**
 * Thin horizontal rule between turns with a cyan ◆ centered as the
 * Reasonix mark. Past-turn separators live inside `<Static>` (Ink's
 * render-once optimization), so animation here would freeze at
 * tick=0 on every past turn — we keep it static by design. The
 * animated heartbeat lives in PulsingAssistantGlyph (current turn)
 * and the Wordmark (StatsPanel) where rerender is free.
 */
function TurnSeparator() {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const width = Math.max(16, cols - 2);
  const half = Math.floor((width - 3) / 2);
  const left = "─".repeat(half);
  const right = "─".repeat(width - half - 3);
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text dimColor>{left}</Text>
      <Text color="cyan" bold>
        {" ◆ "}
      </Text>
      <Text dimColor>{right}</Text>
    </Box>
  );
}

/**
 * Render the payload of an `edit_file` tool result with proper
 * diff coloring: first line is the header ("edited X (A→B chars)"),
 * subsequent lines are prefixed with `-` (removed), `+` (added), or
 * space (unchanged context). Unchanged lines render dim so the
 * changed ones pop visually. No truncation — the whole diff is
 * shown so the user can audit what landed before `/apply` or
 * `git diff` review.
 */
function EditFileDiff({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  // Line 0 is the status header ("edited X (A→B chars)"), Line 1 is
  // the unified-diff hunk header ("@@ -N,M +N,M @@"), the rest is
  // the colored diff body. We style the two headers distinctly so
  // the hunk marker stands out the way git-diff's cyan `@@` does in
  // most terminals.
  const [statusHeader, hunkHeader, ...body] = lines;
  return (
    <Box flexDirection="column">
      <Text dimColor>{` ${statusHeader ?? ""}`}</Text>
      {hunkHeader !== undefined ? (
        <Text color="cyan" bold>
          {hunkHeader}
        </Text>
      ) : null}
      {body.map((line, i) => {
        // Key includes the line content slice so React isn't forced
        // to treat purely-positional identity; lines in the same
        // diff don't reorder but could repeat (e.g. blank lines).
        const key = `${i}-${line.slice(0, 32)}`;
        if (line.startsWith("- ")) {
          return (
            <Text key={key} color="red">
              {line}
            </Text>
          );
        }
        if (line.startsWith("+ ")) {
          return (
            <Text key={key} color="green">
              {line}
            </Text>
          );
        }
        // Context line (starts with "  ") or unknown — dim.
        return (
          <Text key={key} dimColor>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

function BranchBlock({ branch }: { branch: BranchSummary }) {
  const per = branch.uncertainties
    .map((u, i) => {
      const marker = i === branch.chosenIndex ? "▸" : " ";
      const t = (branch.temperatures[i] ?? 0).toFixed(1);
      return `${marker} #${i} T=${t} u=${u}`;
    })
    .join("  ");
  return (
    <Box>
      <Text color="blue">
        {"⎇ branched "}
        <Text bold>{branch.budget}</Text>
        {` samples → picked #${branch.chosenIndex}   `}
        <Text dimColor>{per}</Text>
      </Text>
    </Box>
  );
}

function ReasoningBlock({ reasoning }: { reasoning: string }) {
  const max = 260;
  const flat = reasoning.replace(/\s+/g, " ").trim();
  // Show the TAIL of the reasoning rather than the head. R1 opens
  // with generic scaffolding ("let me look at the structure...") that
  // repeats across turns and hides the part users actually want to
  // see — the decision right before the model commits to an action.
  // Users can dump the full reasoning with `/think` if needed.
  const preview =
    flat.length <= max ? flat : `… (+${flat.length - max} earlier chars) ${flat.slice(-max)}`;
  // ▏ (LEFT ONE EIGHTH BLOCK) renders as a thin vertical rule at the
  // cell edge — subtler than the role-level ▎ above, giving a
  // visual hierarchy: thick bar = role, thin bar = nested detail
  // under that role (thinking, stats, citations, etc).
  return (
    <Box marginBottom={1}>
      <Text dimColor>▏ </Text>
      <Text dimColor italic>
        thinking {preview}
      </Text>
    </Box>
  );
}

/**
 * Compact progress view rendered while a turn is still streaming. We keep
 * this to a fixed ~3-line footprint so the dynamic region never scrolls past
 * the terminal viewport and leaves artifacts in scrollback.
 */
function Elapsed() {
  const s = useElapsedSeconds();
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return <Text dimColor>{`${mm}:${ss}`}</Text>;
}

/**
 * Animated role glyph for the actively-streaming assistant. Alternates
 * ◆ ↔ ◇ every ~480ms so the user can see the model is alive even
 * during R1's long pre-first-byte silence. Settles back to a static
 * ◆ once the turn ends (StreamingAssistant is unmounted).
 */
function PulsingAssistantGlyph() {
  const tick = useTick();
  const on = Math.floor(tick / 4) % 2 === 0;
  return (
    <Text color="green" bold>
      {on ? ROLE_GLYPH.assistant : ROLE_GLYPH.assistantPulse}
    </Text>
  );
}

function StreamingAssistant({ event }: { event: DisplayEvent }) {
  if (event.branchProgress) {
    const p = event.branchProgress;
    // completed=0 means we've just started; no sample has finished yet.
    if (p.completed === 0) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <PulsingAssistantGlyph />
            <Text color="blue">
              {"  ⎇ launching "}
              {p.total}
              {" parallel samples (R1 thinking in parallel)…  "}
            </Text>
            <Elapsed />
          </Box>
          <Text color="yellow">
            {"  "}spread across T=0.0/0.5/1.0 · reasoner typically takes 30-90s — this is normal
          </Text>
        </Box>
      );
    }
    const pct = Math.round((p.completed / p.total) * 100);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <PulsingAssistantGlyph />
          <Text color="blue">
            {"  ⎇ branching "}
            {p.completed}/{p.total}
            {" ("}
            {pct}
            {"%)  "}
          </Text>
          <Elapsed />
        </Box>
        <Text dimColor>
          {"  latest #"}
          {p.latestIndex}
          {" T="}
          {p.latestTemperature.toFixed(1)}
          {" u="}
          {p.latestUncertainties}
          {p.completed < p.total ? "  · waiting for other samples…" : "  · selecting winner…"}
        </Text>
      </Box>
    );
  }

  const tail = lastLine(event.text, 140);
  const reasoningTail = event.reasoning ? lastLine(event.reasoning, 120) : "";
  const toolCallBuild = event.toolCallBuild;
  // Four distinct phases a turn can be in — label them plainly so
  // the user doesn't have to decode "streaming · 391 + think 4506
  // chars" to figure out what's happening:
  //   pre-first-byte: request in flight, no bytes back yet
  //   reasoning-only: R1 thinking, no visible content yet
  //   tool-call-only: tool_call arguments streaming, no content/reasoning bytes
  //   writing: content streaming (R1 has already produced its thought)
  //   both: rare — content present AND reasoning still growing
  // We can't cheaply distinguish "reasoning still growing" from
  // "reasoning finished but we already saw it", so when content is
  // present we just say "writing response" and surface both counts.
  const preFirstByte = !event.text && !event.reasoning && !toolCallBuild;
  const reasoningOnly = !event.text && !!event.reasoning && !toolCallBuild;
  const toolCallOnly = !event.text && !event.reasoning && !!toolCallBuild;
  let label: string;
  let labelColor: "yellow" | "cyan" | "green" | "magenta" | undefined;
  if (preFirstByte) {
    label = "request sent · waiting for server";
    labelColor = "yellow";
  } else if (reasoningOnly) {
    label = `R1 reasoning · ${event.reasoning?.length ?? 0} chars of thought`;
    labelColor = "cyan";
  } else if (toolCallOnly) {
    label = `assembling tool call${formatToolCallIndex(toolCallBuild)} <${toolCallBuild.name}> · ${toolCallBuild.chars} chars of arguments${formatReadyTail(toolCallBuild)}`;
    labelColor = "magenta";
  } else {
    const parts: string[] = [`writing response · ${event.text.length} chars`];
    if (event.reasoning) parts.push(`after ${event.reasoning.length} chars of reasoning`);
    if (toolCallBuild) {
      parts.push(
        `building tool call${formatToolCallIndex(toolCallBuild)} <${toolCallBuild.name}> · ${toolCallBuild.chars} chars${formatReadyTail(toolCallBuild)}`,
      );
    }
    label = parts.join(" · ");
    labelColor = "green";
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <PulsingAssistantGlyph />
        <Text>{"  "}</Text>
        <Pulse />
        <Text color={labelColor}>{` ${label} `}</Text>
        <Elapsed />
      </Box>
      {reasoningTail ? (
        <Text dimColor italic>
          ↳ thinking: {reasoningTail}
        </Text>
      ) : null}
      {tail ? (
        <Text dimColor>▸ {tail}</Text>
      ) : preFirstByte ? (
        // Non-dim yellow: first-time users misread the dim version as
        // "app frozen". The reassurance has to be VISIBLE to do its job.
        <Text color="yellow" italic>
          {"  waiting for first byte — this is normal, typically 5-60s depending on model + load"}
        </Text>
      ) : reasoningOnly ? (
        <Text color="yellow" italic>
          {
            "  R1 is thinking before it speaks — body text arrives when reasoning finishes (typically 20-90s, this is normal)"
          }
        </Text>
      ) : toolCallOnly ? (
        <Text color="magenta" italic>
          {"  tool-call arguments streaming — the model is about to dispatch a tool"}
        </Text>
      ) : event.reasoning ? (
        <Text color="yellow" italic>
          {"  R1 still reasoning — body text or tool call arrives when thinking finishes"}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Blinking indicator so the user can tell the stream is alive even
 * when the reasoner hasn't produced body text yet. Uses the shared
 * tick (TICK_MS ≈ 120ms) scaled down 4× so the visible blink rate
 * lands around 500ms — feels like a heartbeat, not a progress bar.
 */
function Pulse() {
  const tick = useTick();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  return <Text color="cyan">{frames[Math.floor(tick / 4) % frames.length]}</Text>;
}

/**
 * "(call 3)" suffix for the tool-call label when we have the index.
 * Hides when the turn only has one call so the common case stays tidy.
 */
function formatToolCallIndex(tb: { index?: number; readyCount?: number } | undefined): string {
  if (!tb || tb.index === undefined) return "";
  // Only show the index when this isn't obviously the first + only call.
  if (tb.index === 0 && (tb.readyCount ?? 0) === 0) return "";
  return ` (call ${tb.index + 1})`;
}

/**
 * "· 2 ready" tail that answers "how many tool calls have finished
 * streaming so far this turn?" — user feedback for multi-file turns
 * where the response takes 10–30s to stream. Hidden until readyCount
 * > 0 so single-call turns aren't cluttered.
 */
function formatReadyTail(tb: { readyCount?: number } | undefined): string {
  const n = tb?.readyCount ?? 0;
  if (n <= 0) return "";
  return ` · ${n} ready`;
}

function lastLine(s: string, maxChars: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= maxChars ? flat : `…${flat.slice(-maxChars)}`;
}

function StatsLine({ stats }: { stats: TurnStats }) {
  const hit = (stats.cacheHitRatio * 100).toFixed(1);
  return (
    <Box>
      <Text dimColor>▏ </Text>
      <Text dimColor>
        {"cache "}
        {hit}
        {"% · tokens "}
        {stats.usage.promptTokens}
        {" → "}
        {stats.usage.completionTokens}
        {" · $"}
        {stats.cost.toFixed(6)}
      </Text>
    </Box>
  );
}
