/**
 * Phase 2 of the Frame-compiler migration: per-event Frame builders
 * + an Atom-based slicer that handles row-precise scrolling for
 * Frame atoms and snap-to-boundary for unmigrated Ink-component
 * atoms.
 *
 * Architecture vs. the old `log-rows.tsx`:
 *
 *   log-rows: per-event return list of `LogRow` (one Ink Box each)
 *             plus `LogBlock` fallback for unmigrated roles. Layout
 *             came from Ink's flexbox + bordered boxes; we hand-rolled
 *             accent bars by stacking single-row Boxes with borderLeft.
 *
 *   log-frame: per-event return either a `Frame` (rows of styled
 *              cells, pure data) or a `InkBlock` (legacy ReactElement
 *              with an estimated row count). Layout comes from
 *              Frame primitives — borderLeft, vstack, text-with-wrap,
 *              etc. No Ink involvement until paint, which serializes
 *              each Frame row to ANSI and renders inside `<Text>`.
 *
 * Why a Frame *and* InkBlock atom type instead of just Frame:
 *
 *   The complex roles (plan / plan-replay / plan-resumed,
 *   ctx-breakdown, edit_file diff, user, tool) have nested layout
 *   that's not yet migrated. Forcing them to be Frames now would
 *   either drop their rich rendering or require porting all of them
 *   in one commit. The Atom union lets us migrate role-by-role —
 *   each phase shrinks the InkBlock surface area until it's empty.
 *
 * Slicer behaviour:
 *
 *   `viewportLog(atoms, scrollOffset, available)` walks atoms in
 *   cumulative-row coordinates and returns:
 *     · atoms — the subset whose row range overlaps the viewport
 *     · topSkip — how many rows of the FIRST atom to clip from the
 *       top (Frame-only; for InkBlock this rounds to 0 = include
 *       fully or excluded)
 *     · bottomSkip — analogous, for the LAST atom (Frame-only)
 *     · totalRows / maxScrollRows — clamps for the keystroke layer
 *
 * The renderer slices a Frame atom's rows by `topSkip..rows.length-bottomSkip`,
 * so a single tall assistant turn or info-stream can be wheel-scrolled
 * one row at a time across event boundaries — without negative
 * margins (which Ink doesn't reliably clip; verified in 0.13.0).
 */

import { Box, Text } from "ink";
import React from "react";
import {
  type Frame,
  borderLeft,
  empty,
  frameToAnsi,
  pad,
  text,
  vstack,
} from "../../frame/index.js";
import { type DisplayEvent, EventRow } from "./EventLog.js";
import { COLOR } from "./theme.js";

// ─── atom type ───────────────────────────────────────────────────

/**
 * One piece of the log. A migrated role produces a `frame` atom
 * with deterministic layout; an unmigrated role wraps its existing
 * `<EventRow>` JSX as an `ink` atom with an estimated row count.
 */
export type LogAtom =
  | { kind: "frame"; id: string; frame: Frame }
  | { kind: "ink"; id: string; rows: number; element: React.ReactElement };

/** Total row count for an atom, used by the slicer's row arithmetic. */
function atomRows(a: LogAtom): number {
  return a.kind === "frame" ? a.frame.rows.length : a.rows;
}

// ─── per-role frame builders ─────────────────────────────────────

/**
 * Detect the leading glyph in an info-row text and pick a color tone.
 * Mirrors the dispatch in `EventLog.tsx` so a Frame-rendered info row
 * looks identical to the legacy renderer for the same event payload.
 */
function detectInfoTone(rawText: string): { lead: string; color: string; body: string } {
  const m = rawText.match(/^([▸▶▲⚠✓✗✖↻ⓘ])\s*(.*)$/s);
  const lead = m?.[1] ?? "▸";
  const body = m?.[2] ?? rawText;
  let color: string = COLOR.info;
  if (lead === "▲" || lead === "⚠") color = COLOR.warn;
  else if (lead === "✓") color = COLOR.ok;
  else if (lead === "✗" || lead === "✖") color = COLOR.err;
  else if (lead === "↻") color = COLOR.primary;
  return { lead, color, body };
}

/**
 * Frame for a "[bar] [glyph] [text]" log entry. The bar runs down
 * the left of every wrapped row; the glyph appears once on the
 * first row only; subsequent rows align under the body so they read
 * as continuation. Width budget = `width`; bar takes 1 cell, glyph
 * takes its own width + 2 spaces of separator, body wraps at the
 * remainder.
 */
function accentFrame(
  glyph: string,
  glyphColor: string,
  body: string,
  bodyColor: string | undefined,
  bodyDim: boolean,
  width: number,
): Frame {
  const indentCells = 1 /* bar */ + glyph.length + 2 /* gap */;
  const inner = Math.max(8, width - indentCells);
  const bodyFrame = text(body, {
    width: inner,
    fg: bodyColor,
    dim: bodyDim,
  });
  // Build one column for the indent, one for the body — first row
  // gets the glyph, rest gets spaces.
  const rows: Frame[] = [];
  for (let i = 0; i < bodyFrame.rows.length; i++) {
    const indent =
      i === 0
        ? text(`${glyph}  `, { width: indentCells - 1, fg: glyphColor, bold: true })
        : text(" ".repeat(indentCells - 1), { width: indentCells - 1 });
    rows.push({
      width: bodyFrame.width + indent.width,
      rows: [[...indent.rows[0]!, ...bodyFrame.rows[i]!]],
    });
  }
  const stacked = vstack(...rows);
  return borderLeft(stacked, glyphColor);
}

/** Frame for `info` events with auto-toned glyph. */
function infoFrame(event: DisplayEvent, width: number): Frame {
  const { lead, color, body } = detectInfoTone(event.text);
  return accentFrame(lead, color, body, undefined, true, width);
}

/** Frame for `warning` events. */
function warningFrame(event: DisplayEvent, width: number): Frame {
  return accentFrame("▲ warn", COLOR.warn, event.text, COLOR.warn, false, width);
}

/** Frame for `error` events. */
function errorFrame(event: DisplayEvent, width: number): Frame {
  return accentFrame("✦ error", COLOR.err, event.text, COLOR.err, false, width);
}

/** Frame for `step-progress` events: green pill + counter + label,
 *  optional body lines indented, optional `note: ...` line. */
function stepProgressFrame(event: DisplayEvent, width: number): Frame {
  const sp = event.stepProgress;
  const counter = sp && sp.total > 0 ? `${sp.completed}/${sp.total}` : "";
  const label = sp?.title ? `${sp.stepId} · ${sp.title}` : (sp?.stepId ?? "");
  // Header row: " ✓ STEP " (green bg) + "  " + counter (green bold) + "  " + label (bright green)
  // We simulate the inverse pill via bg color on those cells.
  const pillFrame = text(" ✓ STEP ", { width: 8, bg: "#4ade80", fg: "black", bold: true });
  const counterFrame = counter
    ? text(`  ${counter}`, { width: 2 + counter.length, fg: "#4ade80", bold: true })
    : empty(0);
  const labelFrame = text(`  ${label}`, { width: width - 8 - counterFrame.width, fg: "#86efac" });
  // Hstack via row concat
  const headerWidth = pillFrame.width + counterFrame.width + labelFrame.width;
  const headerRow: Frame = {
    width: headerWidth,
    rows: [[...pillFrame.rows[0]!, ...counterFrame.rows[0]!, ...labelFrame.rows[0]!]],
  };
  // Body lines (if any) indented by 2 spaces.
  const bodyParts: Frame[] = [];
  if (event.text) {
    bodyParts.push(pad(text(event.text, { width: width - 2, dim: true }), 0, 0, 0, 2));
  }
  if (sp?.notes) {
    bodyParts.push(
      pad(text(`note: ${sp.notes}`, { width: width - 2, fg: "#fbbf24", dim: true }), 0, 0, 0, 2),
    );
  }
  // Top-spacer (legacy used marginTop={1})
  const spacer = text("", { width });
  return vstack(spacer, headerRow, ...bodyParts);
}

/**
 * Frame for finished `assistant` events when they're "simple" — no
 * branch, no reasoning, no non-empty planState. The body bypasses
 * the markdown renderer (loses bold / code spans) in exchange for
 * row-level scroll. Most summary turns are plain prose where this
 * trade is invisible; turns with rich formatting fall back to the
 * legacy InkBlock path below.
 */
function simpleAssistantFrame(event: DisplayEvent, width: number): Frame {
  // Top spacer
  const spacer = text("", { width });
  // Header: ◆ + optional model badge.
  const glyph = text("◆", { width: 1, fg: COLOR.assistant, bold: true });
  let header: Frame = glyph;
  if (event.stats) {
    const badge = text(` ${event.stats.model.replace(/^deepseek-/, "")} `, {
      width: 2 + event.stats.model.replace(/^deepseek-/, "").length,
      bg: COLOR.assistant,
      fg: "black",
      bold: true,
    });
    const gap = text("  ", { width: 2 });
    header = {
      width: glyph.width + gap.width + badge.width,
      rows: [[...glyph.rows[0]!, ...gap.rows[0]!, ...badge.rows[0]!]],
    };
  }
  // Body — accent-bar bordered rows, plain text wrap.
  const bodyText = event.text || "(empty body — likely tool-call only)";
  const bodyDim = !event.text;
  const bodyInner = text(bodyText, {
    width: width - 1 - 2 /* bar + 2 indent */,
    fg: COLOR.assistant,
    dim: bodyDim,
  });
  const bodyIndented = pad(bodyInner, 0, 0, 0, 2);
  const bodyBordered = borderLeft(bodyIndented, COLOR.assistant);
  // Optional repair note: 1 row, indented under body.
  const parts: Frame[] = [spacer, header, bodyBordered];
  if (event.repair) {
    parts.push(pad(text(event.repair, { width: width - 2, fg: COLOR.accent }), 0, 0, 0, 2));
  }
  // Stats line — `⌬ XX.X%  ·  in N → out N  ·  $X.XXXXXX`
  if (event.stats) {
    const hit = (event.stats.cacheHitRatio * 100).toFixed(1);
    const hitColor =
      event.stats.cacheHitRatio >= 0.7
        ? "#4ade80"
        : event.stats.cacheHitRatio >= 0.4
          ? "#fcd34d"
          : "#f87171";
    const statsLine = `⌬ ${hit}%  ·  in ${event.stats.usage.promptTokens} → out ${event.stats.usage.completionTokens}  ·  $${event.stats.cost.toFixed(6)}`;
    parts.push(pad(text(statsLine, { width: width - 2, fg: hitColor }), 0, 0, 0, 2));
  }
  return vstack(...parts);
}

// ─── public surface ──────────────────────────────────────────────

/**
 * Convert a single event to its Atom representation. Migrated roles
 * return `frame` atoms; unmigrated roles wrap their legacy
 * `<EventRow>` as an `ink` atom with `estimatedHeight` rows.
 *
 * `projectRoot` is forwarded to the legacy renderer for ink atoms.
 * `width` is the terminal column count — every Frame is built to
 * fit exactly this width so rows align cleanly when stacked.
 */
export function eventToAtom(
  event: DisplayEvent,
  projectRoot: string | undefined,
  width: number,
): LogAtom {
  if (event.role === "info") {
    return { kind: "frame", id: event.id, frame: infoFrame(event, width) };
  }
  if (event.role === "warning") {
    return { kind: "frame", id: event.id, frame: warningFrame(event, width) };
  }
  if (event.role === "error") {
    return { kind: "frame", id: event.id, frame: errorFrame(event, width) };
  }
  if (event.role === "step-progress") {
    return { kind: "frame", id: event.id, frame: stepProgressFrame(event, width) };
  }
  if (event.role === "assistant" && !event.streaming) {
    const hasComplexSub =
      event.branch ||
      event.reasoning ||
      (event.planState && Object.keys(event.planState).length > 0);
    if (!hasComplexSub) {
      return { kind: "frame", id: event.id, frame: simpleAssistantFrame(event, width) };
    }
  }
  // Fall back to legacy Ink rendering for roles we haven't migrated.
  return {
    kind: "ink",
    id: event.id,
    rows: estimatedHeight(event),
    element: <EventRow event={event} projectRoot={projectRoot} />,
  };
}

/** Mirror of the legacy slicer's heightOf. Only used for `ink` atoms. */
function estimatedHeight(e: DisplayEvent): number {
  const t = e.text ?? "";
  const wrapLines = Math.max(0, Math.floor(t.length / 80));
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
      const diffLines = (t.match(/\n/g)?.length ?? 0) + 1;
      return 6 + Math.min(20, diffLines);
    }
    return 2;
  }
  if (e.role === "plan" || e.role === "plan-replay" || e.role === "plan-resumed") return 10;
  if (e.role === "ctx-breakdown") return 7;
  return 2;
}

// ─── slicer ──────────────────────────────────────────────────────

export interface AtomViewport {
  /** Atoms whose row range overlaps the viewport. */
  atoms: LogAtom[];
  /** For the FIRST atom (only meaningful for `frame`): rows to clip
   *  from the top. The renderer slices `frame.rows.slice(topSkip)`. */
  topSkip: number;
  /** For the LAST atom (only meaningful for `frame`): rows to clip
   *  from the bottom. */
  bottomSkip: number;
  /** Total cumulative row count — for scrollbar arithmetic. */
  totalRows: number;
  /** Highest valid scroll offset (rows). Caller clamps with this. */
  maxScrollRows: number;
}

/**
 * Slice atoms by row range. `scrollOffset` is rows-from-the-bottom
 * (0 = newest content visible at the bottom of `available` rows).
 *
 * Frame atoms support row-precise clipping (topSkip / bottomSkip);
 * Ink atoms snap — they're either fully included or fully excluded
 * based on whether their row range touches the viewport. Once every
 * role is Frame, the snap branch goes away.
 */
export function viewportLog(
  atoms: readonly LogAtom[],
  scrollOffset: number,
  available: number,
): AtomViewport {
  if (atoms.length === 0 || available <= 0) {
    return { atoms: [], topSkip: 0, bottomSkip: 0, totalRows: 0, maxScrollRows: 0 };
  }
  const heights = atoms.map(atomRows);
  const totalRows = heights.reduce((a, b) => a + b, 0);
  const maxScrollRows = Math.max(0, totalRows - available);
  const offset = Math.max(0, Math.min(scrollOffset, maxScrollRows));
  const viewportBottom = totalRows - offset;
  const viewportTop = Math.max(0, viewportBottom - available);

  // Walk forward, pick atoms overlapping [viewportTop, viewportBottom).
  let cursor = 0;
  let firstIdx = -1;
  let firstStart = 0;
  let lastIdx = -1;
  let lastEnd = 0;
  for (let i = 0; i < atoms.length; i++) {
    const start = cursor;
    const end = cursor + heights[i]!;
    cursor = end;
    if (end <= viewportTop) continue;
    if (start >= viewportBottom) break;
    if (firstIdx === -1) {
      firstIdx = i;
      firstStart = start;
    }
    lastIdx = i;
    lastEnd = end;
  }
  if (firstIdx === -1) {
    // Defensive fallback — shouldn't happen with clamped offset.
    return {
      atoms: [atoms[atoms.length - 1]!],
      topSkip: 0,
      bottomSkip: 0,
      totalRows,
      maxScrollRows,
    };
  }
  const sliced = atoms.slice(firstIdx, lastIdx + 1);
  // Compute clip amounts. Ink atoms can't be clipped, so if the
  // boundary lands inside an ink atom we round to the atom edge —
  // user briefly "sticks" at the boundary, which is the cost of an
  // unmigrated role.
  const firstAtom = sliced[0]!;
  const lastAtom = sliced[sliced.length - 1]!;
  let topSkip = 0;
  let bottomSkip = 0;
  if (firstAtom.kind === "frame") {
    topSkip = Math.max(0, viewportTop - firstStart);
  }
  if (lastAtom.kind === "frame") {
    bottomSkip = Math.max(0, lastEnd - viewportBottom);
  }
  return { atoms: sliced, topSkip, bottomSkip, totalRows, maxScrollRows };
}

// ─── renderer ────────────────────────────────────────────────────

/**
 * Render an Atom-viewport result as an Ink JSX subtree. Frame atoms
 * are sliced by the (topSkip, bottomSkip) hints and emitted as one
 * `<Box height={1}>` per visible row. Ink atoms render their
 * legacy ReactElement directly.
 *
 * Until Phase 4 lands a direct stdout paint layer, this is where
 * Frames meet Ink — each row's ANSI string goes inside `<Text>`.
 */
export function renderViewport(v: AtomViewport): React.ReactElement {
  return (
    <>
      {v.atoms.map((atom, i) => {
        if (atom.kind === "ink") {
          return <React.Fragment key={atom.id}>{atom.element}</React.Fragment>;
        }
        // Frame atom: slice rows by topSkip/bottomSkip if this is the
        // first/last atom in the viewport.
        const start = i === 0 ? v.topSkip : 0;
        const end =
          i === v.atoms.length - 1 ? atom.frame.rows.length - v.bottomSkip : atom.frame.rows.length;
        const rows = atom.frame.rows.slice(start, end);
        return (
          <React.Fragment key={atom.id}>
            {rows.map((row, ri) => (
              <Box key={`${atom.id}/${start + ri}`} height={1} flexShrink={0}>
                <Text>{frameToAnsi({ width: atom.frame.width, rows: [row] })}</Text>
              </Box>
            ))}
          </React.Fragment>
        );
      })}
    </>
  );
}

/**
 * Convenience: convert a list of events to atoms in one pass. The
 * caller (App.tsx) flatMaps historical → atoms and feeds the result
 * into `viewportLog`.
 */
export function eventsToAtoms(
  events: readonly DisplayEvent[],
  projectRoot: string | undefined,
  width: number,
): LogAtom[] {
  const out: LogAtom[] = [];
  for (const e of events) out.push(eventToAtom(e, projectRoot, width));
  return out;
}
