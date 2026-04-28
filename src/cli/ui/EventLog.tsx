import { Box, Text, useStdout } from "ink";
import React from "react";
import { type TypedPlanState, isPlanStateEmpty } from "../../harvest.js";
import type { BranchProgress, BranchSummary } from "../../loop.js";
import type { TurnStats } from "../../telemetry.js";
import type { PlanStep } from "../../tools/plan.js";
import { PlanStateBlock } from "./PlanStateBlock.js";
import { PlanStepList } from "./PlanStepList.js";
import { Markdown } from "./markdown.js";
import { COLOR, gradientCells } from "./theme.js";
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
   * Raw JSON args the model passed to the tool. Carried through so the
   * web dashboard's snapshot endpoint can reconstruct the same
   * tool-specific rendering (edit_file diff, write_file content, etc)
   * the live SSE channel already provides. Not used by the Ink TUI
   * directly — it shows the args via OngoingToolRow / tool-summary.
   */
  toolArgs?: string;
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
 * Solid-background pill for tool names. Mirrors the StatsPanel's mode
 * pills so the visual language stays consistent across the screen:
 * status (auto/review/plan), tool name, model. Status drives the
 * background color — yellow for ok/in-flight, red for errors — so a
 * scrollback full of tool dispatches reads at a glance.
 */
function ToolPill({ label, status }: { label: string; status: "ok" | "err" }) {
  const bg = status === "err" ? "red" : "yellow";
  const symbol = status === "err" ? "✗" : "✓";
  return (
    <Text backgroundColor={bg} color="black" bold>
      {` ${symbol} ${label} `}
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
      <Box flexDirection="column">
        {event.leadSeparator ? <TurnSeparator /> : null}
        <Box>
          <RoleGlyph glyph={ROLE_GLYPH.user} color="cyan" />
          <Text>{"  "}</Text>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor={COLOR.user}
            paddingLeft={1}
          >
            <Text>{indentContinuationLines(event.text)}</Text>
          </Box>
        </Box>
      </Box>
    );
  }
  if (event.role === "assistant") {
    if (event.streaming) return <StreamingAssistant event={event} />;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <RoleGlyph glyph={ROLE_GLYPH.assistant} color="green" />
          {event.stats ? (
            <>
              <Text>{"  "}</Text>
              <Text backgroundColor={COLOR.assistant} color="black" bold>
                {` ${event.stats.model.replace(/^deepseek-/, "")} `}
              </Text>
            </>
          ) : null}
        </Box>
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={COLOR.assistant}
          paddingLeft={1}
        >
          {event.branch ? <BranchBlock branch={event.branch} /> : null}
          {event.reasoning ? <ReasoningBlock reasoning={event.reasoning} /> : null}
          {!isPlanStateEmpty(event.planState) ? (
            <PlanStateBlock planState={event.planState!} />
          ) : null}
          {event.text ? (
            <Markdown text={event.text} projectRoot={projectRoot} />
          ) : (
            <Text dimColor>(empty body — likely tool-call only)</Text>
          )}
          {event.stats ? <StatsLine stats={event.stats} /> : null}
          {event.repair ? <Text color={COLOR.accent}>{event.repair}</Text> : null}
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
            <ToolPill label={event.toolName ?? "?"} status="ok" />
            <Text dimColor>{"   diff:"}</Text>
          </Box>
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor={COLOR.tool}
            paddingLeft={1}
          >
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
    const status: "ok" | "err" = summary.isError ? "err" : "ok";
    const durationLabel =
      event.durationMs !== undefined && event.durationMs >= 100
        ? formatDuration(event.durationMs)
        : "";
    const indexHint = event.toolIndex !== undefined ? `  /tool ${event.toolIndex}` : "";
    return (
      <Box>
        <ToolPill label={event.toolName ?? "?"} status={status} />
        {durationLabel ? <Text dimColor>{`  ${durationLabel}`}</Text> : null}
        <Text dimColor>{"  "}</Text>
        <Text color={status === "err" ? "red" : undefined} dimColor={status === "ok"}>
          {summary.summary}
        </Text>
        {indexHint ? <Text dimColor>{indexHint}</Text> : null}
      </Box>
    );
  }
  if (event.role === "error") {
    return (
      <Box marginTop={1}>
        <Text backgroundColor="#f87171" color="black" bold>
          {" ✦ ERROR "}
        </Text>
        <Text>{"  "}</Text>
        <Text color="#f87171">{indentContinuationLines(event.text)}</Text>
      </Box>
    );
  }
  if (event.role === "info") {
    // Detect tone from the text so the info row carries semantic
    // weight: ▲/⚠ → warn, ✓ → ok, ✗/✖ → error, ↻ → reload, otherwise
    // a neutral ▸. The leading glyph (if any) is consumed and the
    // body renders dim.
    const m = event.text.match(/^([▸▶▲⚠✓✗✖↻ⓘ])\s*(.*)$/s);
    const lead = m?.[1] ?? "▸";
    const body = m?.[2] ?? event.text;
    let leadColor: string = COLOR.info;
    if (lead === "▲" || lead === "⚠") leadColor = COLOR.warn;
    else if (lead === "✓") leadColor = COLOR.ok;
    else if (lead === "✗" || lead === "✖") leadColor = COLOR.err;
    else if (lead === "↻") leadColor = COLOR.primary;
    return (
      <Box>
        <Text color={leadColor} bold>
          {lead}
        </Text>
        <Text> </Text>
        <Text dimColor>{body}</Text>
      </Box>
    );
  }
  if (event.role === "plan") {
    return (
      <Box flexDirection="column" paddingX={1} marginY={1}>
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
    const counter = sp && sp.total > 0 ? `${sp.completed}/${sp.total}` : "";
    const label = sp?.title ? `${sp.stepId} · ${sp.title}` : (sp?.stepId ?? "");
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text backgroundColor="#4ade80" color="black" bold>
            {" ✓ STEP "}
          </Text>
          {counter ? (
            <>
              <Text>{"  "}</Text>
              <Text color="#4ade80" bold>
                {counter}
              </Text>
            </>
          ) : null}
          <Text>{"  "}</Text>
          <Text color="#86efac">{label}</Text>
        </Box>
        {event.text ? (
          <Box paddingLeft={2}>
            <Text dimColor>{event.text}</Text>
          </Box>
        ) : null}
        {sp?.notes ? (
          <Box paddingLeft={2}>
            <Text color="#fbbf24" dimColor>
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
    // execution will resume from. If the plan is fully done, no focus.
    const nextStep = rp.steps.find((s) => !completedSet.has(s.id));
    return (
      <Box flexDirection="column" paddingX={1} marginY={1}>
        <Box>
          <Text backgroundColor="#67e8f9" color="black" bold>
            {" ↻ RESUMED PLAN "}
          </Text>
          <Text>{"  "}</Text>
          <Text color="#67e8f9" bold>
            {`${done}/${total}`}
          </Text>
          <Text dimColor>{`  done  ·  last touched ${rp.relativeTime}`}</Text>
        </Box>
        {rp.summary ? (
          <Box marginTop={1}>
            <Text color="#67e8f9">{rp.summary}</Text>
          </Box>
        ) : null}
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
    const navHint = r.total > 1 ? `  ·  ${r.index}/${r.total}` : "";
    return (
      <Box flexDirection="column" paddingX={1} marginY={1}>
        <Box>
          <Text backgroundColor="#94a3b8" color="black" bold>
            {" ⏪ REPLAY "}
          </Text>
          <Text>{"  "}</Text>
          <Text color="#94a3b8" bold>
            {`${done}/${total}`}
          </Text>
          <Text dimColor>{`  done  ·  ${r.relativeTime}${navHint}`}</Text>
        </Box>
        {r.summary ? (
          <Box marginTop={1}>
            <Text color="#94a3b8">{r.summary}</Text>
          </Box>
        ) : null}
        <Box>
          <Text dimColor>{r.archiveBasename}</Text>
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
        <Text backgroundColor="#fbbf24" color="black" bold>
          {" ▲ WARN "}
        </Text>
        <Text>{"  "}</Text>
        <Text color="#fbbf24">{indentContinuationLines(event.text)}</Text>
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
 * Decorative gradient rule between turns. Uses the brand gradient
 * (teal → fuchsia) so the boundary between "old turn" and "new
 * turn" reads as a designed accent rather than a dim minus-sign
 * row. Static — past separators live inside Ink's `<Static>`, so
 * animation would freeze at tick=0 anyway.
 */
function TurnSeparator() {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const width = Math.max(16, cols - 2);
  // Reserve 5 cells for `  ◆  ` in the middle. Split the remainder
  // into two gradient halves so the brand mark sits on the seam.
  const sideWidth = Math.max(2, Math.floor((width - 5) / 2));
  const leftCells = gradientCells(sideWidth, "─");
  const rightCells = gradientCells(sideWidth, "─");
  return (
    <Box marginTop={1} marginBottom={1}>
      {leftCells.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-width gradient row
        <Text key={`tsep-l-${i}`} color={c.color}>
          {c.ch}
        </Text>
      ))}
      <Text color={COLOR.brand} bold>
        {"  ◆  "}
      </Text>
      {rightCells.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-width gradient row
        <Text key={`tsep-r-${i}`} color={c.color}>
          {c.ch}
        </Text>
      ))}
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
  // the colored diff body. The hunk header gets a magenta-bg pill —
  // same idiom as the rest of the TUI — so it visually anchors each
  // hunk. Body lines render with a colored gutter glyph + tinted bg
  // for + and -, so the diff scans like a syntax-highlighted patch
  // file rather than a wall of monochrome text.
  const [statusHeader, hunkHeader, ...body] = lines;
  return (
    <Box flexDirection="column">
      <Text dimColor>{` ${statusHeader ?? ""}`}</Text>
      {hunkHeader !== undefined ? (
        <Box marginTop={1}>
          <Text backgroundColor="#c4b5fd" color="black" bold>
            {` ${hunkHeader.trim()} `}
          </Text>
        </Box>
      ) : null}
      {body.map((line, i) => {
        // Key includes the line content slice so React isn't forced
        // to treat purely-positional identity; lines in the same
        // diff don't reorder but could repeat (e.g. blank lines).
        const key = `${i}-${line.slice(0, 32)}`;
        // Strip the leading "  " indent diff-preview adds to every
        // body line so the gutter glyph is column 0 regardless of
        // formatter changes upstream.
        const stripped = line.replace(/^ {2}/, "");
        if (stripped.startsWith("- ")) {
          return (
            <Box key={key}>
              <Text color="#f87171" bold>
                {"− "}
              </Text>
              <Text color="#fca5a5">{stripped.slice(2)}</Text>
            </Box>
          );
        }
        if (stripped.startsWith("+ ")) {
          return (
            <Box key={key}>
              <Text color="#4ade80" bold>
                {"+ "}
              </Text>
              <Text color="#86efac">{stripped.slice(2)}</Text>
            </Box>
          );
        }
        // Context line (starts with " ") or unknown — dim.
        return (
          <Box key={key}>
            <Text dimColor>{"  "}</Text>
            <Text dimColor>{stripped}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function BranchBlock({ branch }: { branch: BranchSummary }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text backgroundColor="#93c5fd" color="black" bold>
          {` ⎇ BRANCH ×${branch.budget} `}
        </Text>
        <Text>{"  "}</Text>
        <Text color="#93c5fd">picked </Text>
        <Text color="#93c5fd" bold>
          #{branch.chosenIndex}
        </Text>
      </Box>
      <Box paddingLeft={2} marginTop={1}>
        {branch.uncertainties.map((u, i) => {
          const chosen = i === branch.chosenIndex;
          const t = (branch.temperatures[i] ?? 0).toFixed(1);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: branch index is positional and stable
            <Text key={`b-${i}`}>
              <Text color={chosen ? "#93c5fd" : "#475569"} bold={chosen}>
                {chosen ? "▸ " : "  "}
              </Text>
              <Text color={chosen ? "#93c5fd" : "#94a3b8"} bold={chosen}>
                {`#${i}`}
              </Text>
              <Text dimColor>{` T=${t}  u=${u}   `}</Text>
            </Text>
          );
        })}
      </Box>
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
  return (
    <Box marginBottom={1}>
      <Text backgroundColor={COLOR.accent} color="black" bold>
        {" ⋯ thinking "}
      </Text>
      <Text> </Text>
      <Text color={COLOR.accent} italic dimColor>
        {preview}
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
 * Role glyph for the actively-streaming assistant. The braille
 * spinner sitting next to it (`Pulse`) already conveys "alive" — a
 * second animated indicator on the same row was visually noisy AND
 * doubled the fast-tick subscriber count for the streaming row. The
 * glyph stays static; the spinner does the liveness signaling.
 */
function PulsingAssistantGlyph() {
  return (
    <Text color="green" bold>
      {ROLE_GLYPH.assistant}
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
  // Phase pill — solid bg color per phase so the user reads
  // "what's happening" at a glance from across the screen. Pill text
  // is padded to a fixed width so a phase transition (WAITING →
  // THINKING → WRITING) doesn't shift everything to its right by 1
  // column. Yoga reflows on width change; locking the pill stops the
  // streaming row from twitching every time the model crosses a phase.
  const PILL_WIDTH = 8;
  let pillBg: string;
  let pillText: string;
  let label: string;
  if (preFirstByte) {
    pillBg = "#fbbf24"; // amber
    pillText = "WAITING";
    label = "request sent · waiting for server";
  } else if (reasoningOnly) {
    pillBg = "#c4b5fd"; // violet
    pillText = "THINKING";
    label = `${event.reasoning?.length ?? 0} chars of thought`;
  } else if (toolCallOnly) {
    pillBg = "#f0abfc"; // fuchsia
    pillText = "DISPATCH";
    label = `assembling${formatToolCallIndex(toolCallBuild)} <${toolCallBuild.name}> · ${toolCallBuild.chars} chars${formatReadyTail(toolCallBuild)}`;
  } else {
    pillBg = "#86efac"; // green
    pillText = "WRITING";
    const parts: string[] = [`${event.text.length} chars`];
    if (event.reasoning) parts.push(`after ${event.reasoning.length} reasoning`);
    if (toolCallBuild) {
      parts.push(
        `tool${formatToolCallIndex(toolCallBuild)} <${toolCallBuild.name}> ${toolCallBuild.chars}c${formatReadyTail(toolCallBuild)}`,
      );
    }
    label = parts.join(" · ");
  }
  pillText = pillText.padEnd(PILL_WIDTH);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <PulsingAssistantGlyph />
        <Text>{"  "}</Text>
        <Pulse />
        <Text> </Text>
        <Text backgroundColor={pillBg} color="black" bold>
          {` ${pillText} `}
        </Text>
        <Text dimColor>{`  ${label}  `}</Text>
        <Elapsed />
      </Box>
      {reasoningTail ? (
        <Box paddingLeft={3}>
          <Text color="#c4b5fd" italic dimColor>
            ↳ {reasoningTail}
          </Text>
        </Box>
      ) : null}
      {tail ? (
        <Box paddingLeft={3}>
          <Text dimColor>▸ {tail}</Text>
        </Box>
      ) : preFirstByte ? (
        // Non-dim amber: first-time users misread the dim version as
        // "app frozen". The reassurance has to be VISIBLE to do its job.
        <Box paddingLeft={3}>
          <Text color="#fbbf24" italic>
            {"waiting for first byte — typical 5–60s depending on model + load"}
          </Text>
        </Box>
      ) : reasoningOnly ? (
        <Box paddingLeft={3}>
          <Text color="#c4b5fd" italic>
            {"R1 thinks before it speaks — body text arrives when reasoning finishes (20–90s)"}
          </Text>
        </Box>
      ) : toolCallOnly ? (
        <Box paddingLeft={3}>
          <Text color="#f0abfc" italic>
            {"tool-call arguments streaming — about to dispatch"}
          </Text>
        </Box>
      ) : event.reasoning ? (
        <Box paddingLeft={3}>
          <Text color="#fbbf24" italic>
            {"R1 still reasoning — body text or tool call arrives when thinking finishes"}
          </Text>
        </Box>
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

export function lastLine(s: string, maxChars: number): string {
  // The streaming row only ever shows the last ~maxChars characters,
  // so collapsing whitespace across the entire (possibly multi-KB)
  // buffer on every 30Hz flush is wasted work. Slice a generous tail
  // first — `maxChars * 4` covers the worst case where the tail is
  // mostly whitespace that collapses away — then flatten just that.
  const tailSlice = s.length > maxChars * 4 ? s.slice(-maxChars * 4) : s;
  const flat = tailSlice.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= maxChars ? flat : `…${flat.slice(-maxChars)}`;
}

function StatsLine({ stats }: { stats: TurnStats }) {
  const hit = (stats.cacheHitRatio * 100).toFixed(1);
  const hitColor =
    stats.cacheHitRatio >= 0.7 ? "#4ade80" : stats.cacheHitRatio >= 0.4 ? "#fcd34d" : "#f87171";
  return (
    <Box marginTop={1}>
      <Text color={hitColor} bold>
        {`⌬ ${hit}%`}
      </Text>
      <Text dimColor>{"  ·  "}</Text>
      <Text color="#94a3b8">
        {"in "}
        <Text color="#67e8f9" bold>
          {stats.usage.promptTokens}
        </Text>
        {" → out "}
        <Text color="#c4b5fd" bold>
          {stats.usage.completionTokens}
        </Text>
      </Text>
      <Text dimColor>{"  ·  "}</Text>
      <Text color="#86efac" bold>{`$${stats.cost.toFixed(6)}`}</Text>
    </Box>
  );
}
