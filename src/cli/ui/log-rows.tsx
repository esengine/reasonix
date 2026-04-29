/**
 * Row-granular log rendering pipeline. Each `DisplayEvent` is
 * decomposed into one or more {@link LogItem}s — either a 1-row
 * inline `LogRow` (most chat noise: info / warn / error /
 * step-progress) or a multi-row atomic `LogBlock` (complex
 * components like plan / ctx-breakdown that we haven't broken
 * down yet).
 *
 * Why this exists: Ink's `overflow="hidden"` does NOT reliably clip
 * children with negative `marginTop` — content bleeds upward into
 * sibling regions (the chrome pills disappeared at scroll=0 in 0.13.0
 * because of exactly this). Clipping IS reliable for positive
 * overflow at the BOTTOM of a fixed-height parent. So instead of
 * fighting layout, we pre-flatten events into terminal-row units,
 * slice the row list, and render the slice as a stack of `<Box
 * height={1}>` items. Each item maps 1:1 to a terminal line, the
 * parent's overflow=hidden naturally clips overflow at the bottom,
 * and `justifyContent="flex-end"` (when at scroll=0) clips overflow
 * at the top by the same mechanism.
 *
 * Migration plan:
 *   · 0.13.x : info / warn / error / step-progress → rows.
 *              Everything else falls back to a single `LogBlock`
 *              wrapping the existing `<EventRow>` component, so
 *              the pipeline works end-to-end while complex roles
 *              keep their old rendering.
 *   · later  : user / assistant text bodies → rows (split on \n,
 *              one row per visual line).
 *   · later  : tool / edit_file diff → rows.
 *   · later  : plan / plan-replay / ctx-breakdown → rows.
 *
 * The slicer (`sliceLogItems`) treats `LogBlock`s as snap-points:
 * a partially-visible block at the viewport's top edge gets either
 * fully included or fully excluded, the user briefly "sticks" on
 * boundaries when wheel-scrolling through one. Once everything is
 * migrated to rows, scrolling is uniformly smooth.
 */

import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { type DisplayEvent, EventRow } from "./EventLog.js";
import { COLOR } from "./theme.js";

/**
 * Greedy character-count wrap. Accurate for ASCII / Latin; CJK
 * (where one char ≈ 2 cells) under-counts, but the parent's
 * overflow="hidden" still clips the bleed — at worst a visually-
 * tight row, not a layout break. Word-aware wrap is a future polish;
 * for now we just need the row count to be close enough that the
 * slicer's row arithmetic and the scrollbar thumb position aren't
 * obviously off.
 */
function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      out.push("");
      continue;
    }
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let i = 0;
    while (i < line.length) {
      out.push(line.slice(i, i + width));
      i += width;
    }
  }
  return out;
}

/**
 * One terminal line. Always renders inside an outer `<Box height={1}
 * flexShrink={0}>` so the slicer's row arithmetic stays exact —
 * overlong content soft-wraps in Ink unless we constrain row height,
 * which we don't here, but the parent's `overflow="hidden"` clips
 * any wrap-induced overflow.
 */
export interface LogRow {
  kind: "row";
  /** Stable React key. Must be unique within the rendered slice. */
  id: string;
  content: React.ReactElement;
}

/**
 * A multi-row atomic component. Used as the fall-back when an event
 * role hasn't been broken down into individual rows yet. The slicer
 * snaps to block boundaries — partially-visible blocks at the viewport
 * top either render in full or get excluded.
 */
export interface LogBlock {
  kind: "block";
  id: string;
  /** Estimated terminal row count. Used by the slicer for cumulative
   *  row arithmetic. Over-estimates are safer (reserve more rows
   *  than needed) than under-estimates (block crowds the viewport
   *  and content past the bottom clips silently). */
  rows: number;
  content: React.ReactElement;
}

export type LogItem = LogRow | LogBlock;

/**
 * Row count for an item, used by the slicer.
 * `LogRow` is always 1; `LogBlock` carries its own estimate.
 */
export function itemRows(item: LogItem): number {
  return item.kind === "row" ? 1 : item.rows;
}

/**
 * Detect the leading glyph in an info-row text and pick a color tone.
 * Mirrors the existing dispatch in `EventLog.tsx` so migrated rows
 * look identical to the legacy renderer for the same event payload.
 */
function detectInfoTone(text: string): { lead: string; color: string; body: string } {
  const m = text.match(/^([▸▶▲⚠✓✗✖↻ⓘ])\s*(.*)$/s);
  const lead = m?.[1] ?? "▸";
  const body = m?.[2] ?? text;
  let color: string = COLOR.info;
  if (lead === "▲" || lead === "⚠") color = COLOR.warn;
  else if (lead === "✓") color = COLOR.ok;
  else if (lead === "✗" || lead === "✖") color = COLOR.err;
  else if (lead === "↻") color = COLOR.primary;
  return { lead, color, body };
}

/**
 * Render a single accent-bar row. The bar is the left vertical
 * border of the wrapper Box; subsequent rows of the same event share
 * the bar's color so vertically-adjacent rows visually merge into one
 * continuous bar (which is what users read as "this is one log entry").
 *
 * `prefix` is rendered inline before the line's body; pass `null` for
 * continuation lines that should align under the body, not the glyph.
 */
function AccentRow({
  color,
  prefix,
  body,
  bodyColor,
  bodyDim,
}: {
  color: string;
  prefix: React.ReactNode | null;
  body: string;
  bodyColor?: string;
  bodyDim?: boolean;
}) {
  return (
    <Box
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={color}
      paddingLeft={1}
    >
      {prefix}
      <Text color={bodyColor} dimColor={bodyDim}>
        {body}
      </Text>
    </Box>
  );
}

/**
 * Decompose a plain "accent-bar + glyph + multiline text" event into
 * one row per visual line, word-wrapping at `width`. The first line
 * carries the glyph; continuation lines align under the body so they
 * read as one entry.
 */
function accentRows(
  baseId: string,
  glyph: string,
  glyphColor: string,
  text: string,
  bodyColor: string | undefined,
  bodyDim: boolean,
  width: number,
): LogRow[] {
  // Reserve cells for the border (1) + paddingLeft (1) + glyph + 2-space
  // gap so the wrap width matches the visual content column.
  const indentCells = 1 + 1 + glyph.length + 2;
  const inner = Math.max(8, width - indentCells);
  const lines = wrapToWidth(text, inner);
  return lines.map((line, i) => ({
    kind: "row" as const,
    id: `${baseId}/${i}`,
    content:
      i === 0 ? (
        <AccentRow
          color={glyphColor}
          prefix={
            <>
              <Text color={glyphColor} bold>
                {glyph}
              </Text>
              <Text>{"  "}</Text>
            </>
          }
          body={line}
          bodyColor={bodyColor}
          bodyDim={bodyDim}
        />
      ) : (
        <AccentRow
          color={glyphColor}
          prefix={<Text>{" ".repeat(glyph.length + 2)}</Text>}
          body={line}
          bodyColor={bodyColor}
          bodyDim={bodyDim}
        />
      ),
  }));
}

/**
 * Decompose a finished `assistant` event into rows so a long summary
 * scrolls one terminal line at a time. Header (glyph + model badge)
 * is its own row; body becomes one row per wrapped line under the
 * assistant accent bar; stats / repair occupy dedicated trailing rows.
 *
 * **Fall-through:** events that carry branch / reasoning / non-empty
 * planState fall back to the legacy `LogBlock` because those
 * sub-components have their own internal layout we haven't row-split
 * yet. This keeps every advanced-feature event readable; the dominant
 * case (a plain summary turn) gets row-level scrolling.
 *
 * **Trade-off:** the row body bypasses the markdown renderer, so
 * inline formatting (bold / italic / code spans) is rendered as plain
 * text. Most assistant prose reads fine without it, and the original
 * formatted text is still in `~/.reasonix/sessions/<name>.jsonl`. If
 * code-block fidelity matters, users can /transcript or pipe the file
 * to `bat`. Worth it for the scrolling win.
 */
function assistantToRows(event: DisplayEvent, projectRoot?: string, width = 80): LogItem[] {
  // Skip row migration for events with branch / reasoning / planState —
  // those sub-blocks have nested layout we'd lose by flattening, and
  // they're uncommon enough that LogBlock fall-back is fine for v1.
  const hasComplexSub =
    event.branch || event.reasoning || (event.planState && Object.keys(event.planState).length > 0);
  if (hasComplexSub) {
    return [
      {
        kind: "block",
        id: event.id,
        rows: estimatedHeight(event),
        content: <EventRow event={event} projectRoot={projectRoot} />,
      },
    ];
  }

  const items: LogItem[] = [];
  // Top spacer matches the legacy renderer's `marginTop={1}`.
  items.push({
    kind: "row",
    id: `${event.id}/spacer-top`,
    content: <Text> </Text>,
  });
  // Header: assistant glyph + (optional) model badge.
  items.push({
    kind: "row",
    id: `${event.id}/head`,
    content: (
      <Box>
        <Text color={COLOR.assistant} bold>
          {"◆"}
        </Text>
        {event.stats ? (
          <>
            <Text>{"  "}</Text>
            <Text backgroundColor={COLOR.assistant} color="black" bold>
              {` ${event.stats.model.replace(/^deepseek-/, "")} `}
            </Text>
          </>
        ) : null}
      </Box>
    ),
  });
  // Body rows — one per wrapped line, all sharing the assistant
  // accent bar on the left so they read as one entry visually even
  // though they're independent rows for scroll arithmetic.
  const body = event.text || "(empty body — likely tool-call only)";
  const dim = !event.text;
  items.push(...accentRows(event.id, "", COLOR.assistant, body, COLOR.assistant, dim, width));
  // Repair note: single line, accent violet, indented under the body.
  if (event.repair) {
    items.push({
      kind: "row",
      id: `${event.id}/repair`,
      content: (
        <Box paddingLeft={2}>
          <Text color={COLOR.accent}>{event.repair}</Text>
        </Box>
      ),
    });
  }
  // Stats line — inlined here (kept as a 1-row LogRow rather than a
  // LogBlock) so the user can scroll past it cleanly.
  if (event.stats) {
    const hit = (event.stats.cacheHitRatio * 100).toFixed(1);
    const hitColor =
      event.stats.cacheHitRatio >= 0.7
        ? "#4ade80"
        : event.stats.cacheHitRatio >= 0.4
          ? "#fcd34d"
          : "#f87171";
    items.push({
      kind: "row",
      id: `${event.id}/stats`,
      content: (
        <Box paddingLeft={2}>
          <Text color={hitColor} bold>
            {`⌬ ${hit}%`}
          </Text>
          <Text dimColor>{"  ·  "}</Text>
          <Text color="#94a3b8">{"in "}</Text>
          <Text color="#67e8f9" bold>
            {event.stats.usage.promptTokens}
          </Text>
          <Text color="#94a3b8">{" → out "}</Text>
          <Text color="#c4b5fd" bold>
            {event.stats.usage.completionTokens}
          </Text>
          <Text dimColor>{"  ·  "}</Text>
          <Text color="#86efac" bold>{`$${event.stats.cost.toFixed(6)}`}</Text>
        </Box>
      ),
    });
  }
  return items;
}

/**
 * Convert a single `DisplayEvent` to its row-pipeline representation.
 * Migrated roles return `LogRow[]` (one item per visual terminal line,
 * word-wrapped to `width`); everything else falls back to a single
 * `LogBlock` wrapping the legacy `<EventRow>` component.
 *
 * `projectRoot` is forwarded to the legacy renderer for fall-back
 * blocks (used by the markdown renderer to resolve relative paths).
 *
 * `width` is the terminal column count. Used to word-wrap accent rows
 * so a single long line decomposes into the right number of rows —
 * this matters for the slicer's row arithmetic and for the scrollbar
 * thumb position, both of which assume row count == visual lines.
 */
export function eventToItems(event: DisplayEvent, projectRoot?: string, width = 80): LogItem[] {
  if (event.role === "info") {
    const { lead, color, body } = detectInfoTone(event.text);
    return accentRows(event.id, lead, color, body, undefined, true, width);
  }
  if (event.role === "warning") {
    return accentRows(event.id, "▲ warn", COLOR.warn, event.text, COLOR.warn, false, width);
  }
  if (event.role === "error") {
    return accentRows(event.id, "✦ error", COLOR.err, event.text, COLOR.err, false, width);
  }
  if (event.role === "assistant" && !event.streaming) {
    return assistantToRows(event, projectRoot, width);
  }
  if (event.role === "step-progress") {
    const sp = event.stepProgress;
    const counter = sp && sp.total > 0 ? `${sp.completed}/${sp.total}` : "";
    const label = sp?.title ? `${sp.stepId} · ${sp.title}` : (sp?.stepId ?? "");
    const rows: LogRow[] = [];
    // marginTop={1} in the legacy renderer — emit one blank spacer row.
    rows.push({
      kind: "row",
      id: `${event.id}/spacer`,
      content: <Text> </Text>,
    });
    // Header row: green-on-black STEP pill + counter + label.
    rows.push({
      kind: "row",
      id: `${event.id}/head`,
      content: (
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
      ),
    });
    // Optional body lines (one per \n-split line).
    if (event.text) {
      for (const [i, line] of event.text.split("\n").entries()) {
        rows.push({
          kind: "row",
          id: `${event.id}/body/${i}`,
          content: (
            <Box paddingLeft={2}>
              <Text dimColor>{line}</Text>
            </Box>
          ),
        });
      }
    }
    if (sp?.notes) {
      rows.push({
        kind: "row",
        id: `${event.id}/notes`,
        content: (
          <Box paddingLeft={2}>
            <Text color="#fbbf24" dimColor>
              {`note: ${sp.notes}`}
            </Text>
          </Box>
        ),
      });
    }
    return rows;
  }

  // Fallback: render the whole event as one atomic block via the
  // legacy `EventRow`. Estimates row count via a copy of the slicer's
  // heightOf logic. Once a role is migrated above, this branch stops
  // running for that role.
  return [
    {
      kind: "block",
      id: event.id,
      rows: estimatedHeight(event),
      content: <EventRow event={event} projectRoot={projectRoot} />,
    },
  ];
}

/**
 * Mirror of the slicer's `heightOfEvent` from App.tsx — kept in sync
 * by hand. Used only for fall-back `LogBlock`s; migrated roles
 * compute their row count exactly via the row count itself.
 */
function estimatedHeight(e: DisplayEvent): number {
  const text = e.text ?? "";
  const wrapLines = Math.max(0, Math.floor(text.length / 80));
  if (e.role === "user") return 3 + wrapLines;
  if (e.role === "assistant") {
    let h = 4 + wrapLines;
    if (e.reasoning) h += 3;
    if (e.branch) h += 4;
    return h;
  }
  if (e.role === "tool") {
    const isEditFile = e.toolName === "edit_file" || e.toolName?.endsWith("_edit_file");
    if (isEditFile) {
      const diffLines = (text.match(/\n/g)?.length ?? 0) + 1;
      return 6 + Math.min(20, diffLines);
    }
    return 2;
  }
  if (e.role === "plan" || e.role === "plan-replay" || e.role === "plan-resumed") return 10;
  if (e.role === "ctx-breakdown") return 7;
  return 2;
}

export interface RowSlice {
  items: LogItem[];
  /** Highest valid scroll offset (rows). Caller clamps with this. */
  maxScrollRows: number;
  /** Total rows across all events (informational, e.g. for "↑ N rows above" hints). */
  totalRows: number;
}

/**
 * Slice the flat `LogItem` list to fit `available` viewport rows,
 * scrolled up by `scrollOffsetRows` from the bottom.
 *
 * Snap behavior: if the viewport top edge would fall *inside* a
 * `LogBlock`, the block is included in full (so it might extend
 * partially above the viewport — clipped by the parent's flex-end
 * + overflow=hidden). The same trick that makes the BOTTOM of a tall
 * latest event readable is what makes block snap-rendering safe.
 */
export function sliceLogItems(
  items: readonly LogItem[],
  available: number,
  scrollOffsetRows: number,
): RowSlice {
  if (items.length === 0) {
    return { items: [], maxScrollRows: 0, totalRows: 0 };
  }
  const heights = items.map(itemRows);
  const totalRows = heights.reduce((a, b) => a + b, 0);
  // Cap the scroll so the OLDEST viewport-full of rows (oldest line at
  // the top of the viewport) is reachable but the user never scrolls
  // past it into empty space. With `totalRows - 1` the user could
  // scroll until only one row remained visible — scrollbar at the top
  // and viewport mostly empty, which feels broken. Leaving a viewport-
  // worth of rows below the absolute top means Home / max-scroll lands
  // on a fully-populated viewport showing the start of the log.
  const maxScrollRows = Math.max(0, totalRows - available);
  const offset = Math.max(0, Math.min(scrollOffsetRows, maxScrollRows));

  const viewportBottom = totalRows - offset;
  const viewportTop = Math.max(0, viewportBottom - available);

  // Walk forward, picking items whose row range overlaps the viewport.
  // Items entirely above viewport are dropped; entirely below ends the
  // walk early.
  let cursor = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < items.length; i++) {
    const eStart = cursor;
    const eEnd = cursor + heights[i]!;
    cursor = eEnd;
    if (eEnd <= viewportTop) continue;
    if (eStart >= viewportBottom) break;
    if (firstIdx === -1) firstIdx = i;
    lastIdx = i;
  }
  if (firstIdx === -1) {
    // Should not happen with clamped offset + non-empty items, but
    // fall back to "render the last item" so the user never sees a
    // blank middle.
    return { items: [items[items.length - 1]!], maxScrollRows, totalRows };
  }
  return {
    items: items.slice(firstIdx, lastIdx + 1),
    maxScrollRows,
    totalRows,
  };
}

/**
 * Wrap a `LogItem` in the height-1 (or natural-height for blocks) Box
 * that keeps the slicer's row arithmetic exact. `flexShrink={0}`
 * prevents Ink from squashing rows when the parent's content overflows.
 */
export function renderLogItem(item: LogItem): React.ReactElement {
  if (item.kind === "row") {
    return (
      <Box key={item.id} height={1} flexShrink={0}>
        {item.content}
      </Box>
    );
  }
  return (
    <Box key={item.id} flexShrink={0}>
      {item.content}
    </Box>
  );
}

/**
 * One-row hint pinned at the bottom of the log viewport when the user
 * has scrolled up. Tells them how many rows of newer content sit
 * below the visible window and how to jump back. Hidden when the user
 * is at the bottom (offset === 0) since there's nothing to point to.
 *
 * `rowsBelow` is the same as the active `logScrollOffset` (rows from
 * the bottom that aren't currently visible).
 */
export function BottomHint({
  rowsBelow,
  totalRows,
  viewportRows,
}: {
  rowsBelow: number;
  totalRows: number;
  viewportRows: number;
}) {
  if (rowsBelow <= 0) return null;
  const maxScroll = Math.max(1, totalRows - viewportRows);
  const ratioFromTop = Math.max(0, Math.min(1, (totalRows - rowsBelow - viewportRows) / maxScroll));
  const pct = Math.round((1 - ratioFromTop) * 100);
  const rowsAbove = Math.max(0, totalRows - viewportRows - rowsBelow);
  const barCells = 16;
  const markerAt = Math.max(0, Math.min(barCells - 1, Math.round(ratioFromTop * (barCells - 1))));
  const left = "─".repeat(markerAt);
  const right = "─".repeat(barCells - 1 - markerAt);
  return (
    <Box height={1} flexShrink={0}>
      <Text color={COLOR.primary} bold>
        {`↑ ${rowsAbove}`}
      </Text>
      <Text>{"  "}</Text>
      <Text dimColor>▕</Text>
      <Text color={COLOR.info} dimColor>
        {left}
      </Text>
      <Text color={COLOR.brand} bold>
        ●
      </Text>
      <Text color={COLOR.info} dimColor>
        {right}
      </Text>
      <Text dimColor>▏</Text>
      <Text>{"  "}</Text>
      <Text color={COLOR.primary} bold>{`${pct}%`}</Text>
      <Text>{"  "}</Text>
      <Text color={COLOR.primary}>{`↓ ${rowsBelow}`}</Text>
      <Text dimColor>{"  ·  End to jump · wheel to scroll"}</Text>
    </Box>
  );
}
