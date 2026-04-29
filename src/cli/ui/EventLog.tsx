import { Box, Text, useStdout } from "ink";
import React from "react";
import { type TypedPlanState, isPlanStateEmpty } from "../../harvest.js";
import type { BranchProgress, BranchSummary } from "../../loop.js";
import type { TurnStats } from "../../telemetry.js";
import type { PlanStep } from "../../tools/plan.js";
import { PlanStateBlock } from "./PlanStateBlock.js";
import { PlanStepList } from "./PlanStepList.js";
import { Markdown } from "./markdown.js";
import { COLOR, GLYPH, gradientCells } from "./theme.js";
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
  | "plan-replay"
  /**
   * Token-usage breakdown rendered by the `/context` slash. Carries
   * a structured `ctxBreakdown` payload so EventLog can render the
   * stacked colored char-bar with proper Box+Text layout — slash
   * info text can't carry per-segment color, so /context pushes this
   * specialized event role instead of plain "info".
   */
  | "ctx-breakdown";

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
  /**
   * Populated on `ctx-breakdown` rows. Token counts per category +
   * the context window cap. EventLog renders this as a 4-color
   * stacked char-bar using truecolor segment colors; falls back to
   * sequential block characters on legacy terminals.
   */
  ctxBreakdown?: {
    systemTokens: number;
    toolsTokens: number;
    logTokens: number;
    inputTokens: number;
    ctxMax: number;
    /** Number of tools registered, surfaced in the legend's tools row. */
    toolsCount: number;
    /** Number of messages in the conversation log. */
    logMessages: number;
    /**
     * Top-N heaviest tool results (by token count) for the "where's
     * the bloat" follow-up. Empty when no tool results in the log.
     */
    topTools: Array<{ name: string; tokens: number; turn: number }>;
  };
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
 * Tool name + status indicator. Bracket-text style (not solid-bg pill)
 * because tool calls cluster — a turn with 6 reads + 2 edits + a grep
 * would mean 9 high-contrast color blocks fighting for attention.
 * Bracket text + colored glyph + colored name gives the eye a clear
 * landmark per row without making every row shout.
 *
 *   ▣ read_file        → ok
 *   ▥ run_command      → err  (rose)
 *
 * Visual grammar matches the design doc: status icon first, name in
 * the matching color, no padded-bg block.
 */
function ToolPill({ label, status }: { label: string; status: "ok" | "err" }) {
  const color = status === "err" ? COLOR.toolErr : COLOR.tool;
  const symbol = status === "err" ? GLYPH.toolErr : GLYPH.toolOk;
  return (
    <Text color={color} bold>
      {`${symbol} ${label}`}
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
    // Compact one-line render for everything else. Wrapped in a
    // yellow-left-bar Box so it shares the same "card column" visual
    // language as user/assistant turns — the eye reads the conversation
    // log as one continuous column with role-coded accents, not as a
    // mix of bordered turns and disconnected naked rows.
    const summary = summarizeToolResult(event.toolName ?? "?", event.text);
    const status: "ok" | "err" = summary.isError ? "err" : "ok";
    const durationLabel =
      event.durationMs !== undefined && event.durationMs >= 100
        ? formatDuration(event.durationMs)
        : "";
    const indexHint = event.toolIndex !== undefined ? `  /tool ${event.toolIndex}` : "";
    return (
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={status === "err" ? COLOR.toolErr : COLOR.tool}
        paddingLeft={1}
      >
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
      <Box
        marginTop={1}
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={COLOR.err}
        paddingLeft={1}
      >
        <Text color={COLOR.err} bold>
          ✦ error
        </Text>
        <Text>{"  "}</Text>
        <Text color={COLOR.err}>{indentContinuationLines(event.text)}</Text>
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
    // Same conversation-column visual: left bar in the lead's color,
    // glyph + body indented under it. Without the bar, info rows looked
    // like floating debug text rather than a coherent log entry.
    return (
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={leadColor}
        paddingLeft={1}
      >
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
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={COLOR.warn}
        paddingLeft={1}
      >
        <Text color={COLOR.warn} bold>
          ▲ warn
        </Text>
        <Text>{"  "}</Text>
        <Text color={COLOR.warn}>{indentContinuationLines(event.text)}</Text>
      </Box>
    );
  }
  if (event.role === "ctx-breakdown" && event.ctxBreakdown) {
    return <CtxBreakdownBlock data={event.ctxBreakdown} />;
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

/**
 * `/context` token-usage breakdown — 4-color stacked char-bar across
 * 48 cells, with a legend showing per-category token counts. Matches
 * the design doc's `ctx-chart` state.
 *
 *   ▣ context · 94.2K of 128K (74%)
 *   ████████████████████████████████░░░░░░░░░░░░░░░░
 *   ■ system  5.6K   ■ tools  10.4K   ■ log  68.2K   ■ input  2.8K   free  25.0K
 *
 * Each `█` cell of the bar is colored per the category it represents
 * (brand teal / accent violet / primary cyan / tool amber). The legend
 * uses the same colors on the swatches so the user can map cell-to-row
 * by color alone.
 */
function CtxBreakdownBlock({
  data,
}: {
  data: NonNullable<DisplayEvent["ctxBreakdown"]>;
}) {
  const total = data.systemTokens + data.toolsTokens + data.logTokens + data.inputTokens;
  const winPct = data.ctxMax > 0 ? Math.round((total / data.ctxMax) * 100) : 0;
  const barWidth = 48;
  // Compute filled cells per segment proportionally to ctxMax. Segments
  // sum to <=barWidth; remainder is "free".
  const cellOf = (n: number) => (data.ctxMax > 0 ? Math.round((n / data.ctxMax) * barWidth) : 0);
  const sysCells = cellOf(data.systemTokens);
  const toolsCells = cellOf(data.toolsTokens);
  const logCells = cellOf(data.logTokens);
  const inputCells = cellOf(data.inputTokens);
  const used = sysCells + toolsCells + logCells + inputCells;
  const freeCells = Math.max(0, barWidth - used);

  const sevColor = winPct >= 80 ? COLOR.err : winPct >= 60 ? COLOR.warn : COLOR.ok;

  // Wrapped in a brand-colored left-bar Box so the breakdown shares
  // the same conversation-column visual language as user / assistant /
  // tool turns. Without the bar, /context output read as a disconnected
  // floating block. With it, the eye sees "this belongs to the column".
  return (
    <Box
      flexDirection="column"
      marginY={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={COLOR.brand}
      paddingLeft={1}
    >
      <Box>
        <Text color={COLOR.brand} bold>
          ▣ context
        </Text>
        <Text dimColor>
          {`  ${formatTokensCompact(total)} of ${formatTokensCompact(data.ctxMax)}`}
        </Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text color={sevColor} bold>
          {`${winPct}%`}
        </Text>
        {winPct >= 80 ? (
          <Text color={COLOR.err} bold>
            {"  ·  /compact"}
          </Text>
        ) : null}
      </Box>
      <Box>
        <Text color={COLOR.brand}>{"█".repeat(sysCells)}</Text>
        <Text color={COLOR.accent}>{"█".repeat(toolsCells)}</Text>
        <Text color={COLOR.primary}>{"█".repeat(logCells)}</Text>
        <Text color={COLOR.tool}>{"█".repeat(inputCells)}</Text>
        <Text color={COLOR.info} dimColor>
          {"░".repeat(freeCells)}
        </Text>
      </Box>
      <Box>
        <Text color={COLOR.brand}>■</Text>
        <Text dimColor>{` system ${formatTokensCompact(data.systemTokens)}`}</Text>
        <Text>{"   "}</Text>
        <Text color={COLOR.accent}>■</Text>
        <Text dimColor>{` tools ${formatTokensCompact(data.toolsTokens)}`}</Text>
        <Text dimColor>{` (${data.toolsCount})`}</Text>
        <Text>{"   "}</Text>
        <Text color={COLOR.primary}>■</Text>
        <Text dimColor>{` log ${formatTokensCompact(data.logTokens)}`}</Text>
        <Text dimColor>{` (${data.logMessages} msg)`}</Text>
        <Text>{"   "}</Text>
        <Text color={COLOR.tool}>■</Text>
        <Text dimColor>{` input ${formatTokensCompact(data.inputTokens)}`}</Text>
      </Box>
      {data.topTools.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{`  top tool results by cost (${data.topTools.length}):`}</Text>
          {data.topTools.map((t) => (
            <Box key={`${t.turn}-${t.name}`}>
              <Text dimColor>{`    turn ${String(t.turn).padStart(3)}  `}</Text>
              <Text color={COLOR.info}>{t.name.padEnd(22)}</Text>
              <Text dimColor>{`  ${formatTokensCompact(t.tokens).padStart(8)}`}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>{"  /compact shrinks oversized tool results · /new wipes log"}</Text>
      </Box>
    </Box>
  );
}

/** Compact 1.2K / 128K formatter. Mirrors StatsPanel's formatTokens. */
function formatTokensCompact(n: number): string {
  if (n < 1024) return String(n);
  const k = n / 1024;
  return k >= 100 ? `${k.toFixed(0)}K` : `${k.toFixed(1)}K`;
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
  // Approximate tokens for the meta line — R1 reasoning_content runs
  // 4-6 chars/token in English, which is what /think also uses for
  // its summary header. Rough is fine; the user reads "ballpark size"
  // not "exact bill".
  const tokensApprox = Math.max(1, Math.round(flat.length / 4.5));
  const tokLabel =
    tokensApprox >= 1000 ? `${(tokensApprox / 1000).toFixed(1)}k` : `${tokensApprox}`;
  // Layout (matches design/tui-redesign-ink.html R1 reasoning state):
  //   R1 ↯ reasoning · ~Nk tok
  //   │  <preview text — dim violet italic, left-bordered>
  // The left border is a Box `borderStyle="single" borderLeft` colored
  // violet — same idiom user/assistant turns use, just dimmer to mark
  // this as supplementary thought rather than primary content.
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={COLOR.accent} bold>
          R1 ↯
        </Text>
        <Text dimColor>{`  reasoning · ~${tokLabel} tok · /think for full`}</Text>
      </Box>
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={COLOR.accent}
        paddingLeft={1}
      >
        <Text color={COLOR.accent} italic dimColor>
          {preview}
        </Text>
      </Box>
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

  const toolCallBuild = event.toolCallBuild;
  const text = event.text;
  const reasoning = event.reasoning;
  const preFirstByte = !text && !reasoning && !toolCallBuild;
  const reasoningOnly = !text && !!reasoning && !toolCallBuild;
  const toolCallOnly = !text && !reasoning && !!toolCallBuild;

  let phaseVerb: string | null = null;
  let phaseColor: string = COLOR.assistant;
  if (preFirstByte) {
    phaseVerb = "waiting";
    phaseColor = COLOR.warn;
  } else if (reasoningOnly) {
    phaseVerb = "thinking";
    phaseColor = COLOR.accent;
  } else if (toolCallOnly) {
    phaseVerb = `dispatching ${toolCallBuild.name}`;
    phaseColor = COLOR.accent;
  }

  const verb = phaseVerb ?? "responding";
  const verbColor = phaseVerb ? phaseColor : COLOR.info;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <PulsingAssistantGlyph />
        <Text>{"  "}</Text>
        <Text color={verbColor} dimColor={!phaseVerb}>
          {verb}
        </Text>
        <Text> </Text>
        <Marquee />
        <Text> </Text>
        <Elapsed />
      </Box>
      <Box
        marginTop={1}
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={COLOR.assistant}
        paddingLeft={1}
        flexDirection="column"
      >
        {reasoning ? <ReasoningBlock reasoning={reasoning} /> : null}
        {text ? (
          <Text>
            {text}
            <BlinkingCursor />
          </Text>
        ) : (
          <Text dimColor>
            {preFirstByte
              ? "waiting for first byte — 5-60s typical"
              : reasoningOnly
                ? `R1 thinking · ~${Math.round((reasoning?.length ?? 0) / 4)} tok so far`
                : toolCallOnly
                  ? `assembling ${toolCallBuild.name}${formatToolCallIndex(toolCallBuild)} · ${toolCallBuild.chars} chars${formatReadyTail(toolCallBuild)}`
                  : ""}
            <Text> </Text>
            <BlinkingCursor />
          </Text>
        )}
      </Box>
    </Box>
  );
}

/** Blinking ▌ at the end of the streaming body. ~960ms cycle (matches the
 *  design's 900ms steps(2) blink; integer-tick approximation). */
function BlinkingCursor() {
  const tick = useTick();
  const visible = Math.floor(tick / 4) % 2 === 0;
  return <Text color={COLOR.primary}>{visible ? "▌" : " "}</Text>;
}

/** Char-marching responding indicator. 12-cell track; a 5-char wave
 *  (▒▓█▓▒) shifts one cell per fast tick (120ms). Matches the design
 *  HTML's `.thinking .marquee` exactly. */
const MARQUEE_W = 12;
const MARQUEE_WAVE = ["▒", "▓", "█", "▓", "▒"] as const;
function Marquee() {
  const tick = useTick();
  const cells = new Array(MARQUEE_W).fill("░");
  for (let i = 0; i < MARQUEE_WAVE.length; i++) {
    cells[(tick + i) % MARQUEE_W] = MARQUEE_WAVE[i]!;
  }
  return <Text color={COLOR.primary}>{cells.join("")}</Text>;
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
