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
  type Cell,
  type Frame,
  borderLeft,
  empty,
  frameToAnsi,
  hstack,
  pad,
  text,
  vstack,
} from "../../frame/index.js";
import { type TypedPlanState, isPlanStateEmpty } from "../../harvest.js";
import type { BranchSummary } from "../../loop.js";
import { type DisplayEvent, EventRow } from "./EventLog.js";
import { markdownToFrame } from "./markdown-frame.js";
import { formatTokens } from "./primitives.js";
import { COLOR, GLYPH, gradientCells } from "./theme.js";
import { formatDuration, summarizeToolResult } from "./tool-summary.js";

const ROLE_GLYPH = {
  user: "◇",
  toolOk: GLYPH.toolOk,
  toolErr: GLYPH.toolErr,
} as const;

const SPACE_CELL: Cell = { char: " ", width: 1 };

/**
 * Single-row frame from a horizontal sequence of pre-built 1-row
 * frames. Concatenates cells, then either truncates (if total cells
 * exceed `width`) or right-pads with spaces. Used for layouts that
 * are conceptually one line of mixed-style segments — tool-compact
 * pills, header rows, etc.
 */
function rowFrame(parts: readonly Frame[], width?: number): Frame {
  const cells: Cell[] = [];
  for (const p of parts) {
    if (p.rows.length > 0) cells.push(...p.rows[0]!);
  }
  const w = width ?? cells.reduce((a, c) => a + (c.tail ? 0 : c.width), 0);
  if (cells.length > w) cells.length = w;
  while (cells.reduce((a, c) => a + (c.tail ? 0 : c.width), 0) < w) cells.push(SPACE_CELL);
  return { width: w, rows: [cells] };
}

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
  // Body — accent-bar bordered rows. Markdown is parsed via the
  // markdown-frame compiler so inline bold / italic / code / links
  // and block-level headings / lists / code blocks render with
  // proper styling. Empty body falls back to a dim placeholder.
  const bodyInnerWidth = width - 1 - 2; // bar + 2 indent
  const bodyInner = event.text
    ? markdownToFrame(event.text, bodyInnerWidth)
    : text("(empty body — likely tool-call only)", {
        width: bodyInnerWidth,
        fg: COLOR.assistant,
        dim: true,
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

/**
 * Decorative gradient rule with a centered `◆` brand mark, used as
 * the lead separator before a fresh user turn. Mirrors the legacy
 * `<TurnSeparator>` Ink component visually but composes from cells.
 */
function turnSeparatorFrame(width: number): Frame {
  const w = Math.max(16, width - 2);
  const sideWidth = Math.max(2, Math.floor((w - 5) / 2));
  const left = gradientCells(sideWidth, "─");
  const right = gradientCells(sideWidth, "─");
  const sideCells = (cells: typeof left): Cell[] =>
    cells.map(({ ch, color }) => ({ char: ch, width: 1, fg: color }));
  const center: Cell[] = [
    SPACE_CELL,
    SPACE_CELL,
    { char: "◆", width: 1, fg: COLOR.brand, bold: true },
    SPACE_CELL,
    SPACE_CELL,
  ];
  const totalUsed = sideWidth * 2 + 5;
  const padLeft = Math.max(0, Math.floor((width - totalUsed) / 2));
  const padRight = Math.max(0, width - totalUsed - padLeft);
  const padCells = (n: number): Cell[] => Array.from({ length: n }, () => SPACE_CELL);
  return {
    width,
    rows: [
      [
        ...padCells(padLeft),
        ...sideCells(left),
        ...center,
        ...sideCells(right),
        ...padCells(padRight),
      ],
    ],
  };
}

/**
 * Frame for `user` events. Renders as `◇  │ <text>` with the cyan
 * accent bar continuing down every wrapped row. An optional turn
 * separator (gradient rule) sits above when `event.leadSeparator`
 * is set — that's the visual cue marking a fresh user turn after
 * the previous assistant reply.
 */
function userFrame(event: DisplayEvent, width: number): Frame {
  const indentWidth = 3; // glyph + 2 spaces
  // Body width = total - glyph-indent - bar - inner padding.
  const bodyInner = text(event.text, { width: Math.max(8, width - indentWidth - 2) });
  const padded = pad(bodyInner, 0, 0, 0, 1);
  const bordered = borderLeft(padded, COLOR.user);
  // Build the indent column row-by-row: glyph in row 0, blanks elsewhere.
  const indentRows: Frame[] = bordered.rows.map((_, i) =>
    i === 0
      ? text(`${ROLE_GLYPH.user}  `, { width: indentWidth, fg: "cyan", bold: true })
      : text(" ".repeat(indentWidth), { width: indentWidth }),
  );
  const indentCol = vstack(...indentRows);
  let body = hstack(indentCol, bordered);
  if (event.leadSeparator) {
    body = vstack(turnSeparatorFrame(width), body);
  }
  return body;
}

/**
 * Frame for the COMPACT tool-result row: `[bar] [pill] [duration]
 * [summary] [/tool index]`. Mirrors the legacy renderer's single
 * yellow-bordered line; still uses summarize-tool-result for the
 * body so the frame matches the previous visual.
 */
function toolCompactFrame(event: DisplayEvent, width: number): Frame {
  const summary = summarizeToolResult(event.toolName ?? "?", event.text);
  const status: "ok" | "err" = summary.isError ? "err" : "ok";
  const symbol = status === "err" ? ROLE_GLYPH.toolErr : ROLE_GLYPH.toolOk;
  const pillFg = status === "err" ? "red" : "cyan";
  const accent = status === "err" ? COLOR.toolErr : COLOR.tool;
  const innerWidth = width - 2; // bar + pad
  const segments: Frame[] = [];
  const pillText = `${symbol} ${event.toolName ?? "?"}`;
  segments.push(text(pillText, { width: pillText.length, fg: pillFg, bold: true }));
  if (event.durationMs !== undefined && event.durationMs >= 100) {
    const dur = `  ${formatDuration(event.durationMs)}`;
    segments.push(text(dur, { width: dur.length, dim: true }));
  }
  segments.push(text("  ", { width: 2, dim: true }));
  // Summary takes the rest. Wrap-friendly: build at remaining budget.
  const used = segments.reduce((a, p) => a + p.width, 0);
  const indexHint = event.toolIndex !== undefined ? `  /tool ${event.toolIndex}` : "";
  const summaryBudget = Math.max(8, innerWidth - used - indexHint.length);
  segments.push(
    text(summary.summary, {
      width: summaryBudget,
      fg: status === "err" ? "red" : undefined,
      dim: status === "ok",
    }),
  );
  if (indexHint) {
    segments.push(text(indexHint, { width: indexHint.length, dim: true }));
  }
  // Tool summary may have wrapped to multiple rows — vstack each
  // segment row, padding shorter columns. Easier path: render the
  // summary frame independently and stack rows under the pill.
  // For the v1 we just take the first row of each segment, keeping
  // a one-line tool entry. Multi-line summaries truncate.
  const inner = rowFrame(
    segments.map((s) => ({ width: s.width, rows: [s.rows[0] ?? []] })),
    innerWidth,
  );
  return borderLeft(pad(inner, 0, 0, 0, 1), accent);
}

/**
 * Frame for `edit_file` tool results. The text payload is already
 * a formatted unified diff produced by the loop:
 *
 *   line 0       — status header ("edited X (A→B chars)")
 *   line 1       — hunk header ("@@ -N,M +N,M @@") with magenta pill bg
 *   line 2..n    — diff body, each line prefixed with `  ` (context),
 *                  `- ` (removal), or `+ ` (addition)
 *
 * The rendered frame puts a teal accent bar down the left of the
 * whole block (matching the tool-result column style), with the
 * pill header and gutter-glyph diff lines underneath.
 */
function editFileDiffFrame(event: DisplayEvent, width: number): Frame {
  const lines = event.text.split(/\r?\n/);
  const [statusHeader, hunkHeader, ...body] = lines;
  const innerWidth = width - 2; // bar + pad
  const parts: Frame[] = [];
  // Header row — tool pill + "diff:" label
  parts.push(
    rowFrame(
      [
        text(`${ROLE_GLYPH.toolOk} ${event.toolName ?? "edit_file"}`, {
          width: 2 + (event.toolName ?? "edit_file").length,
          fg: "cyan",
          bold: true,
        }),
        text("   diff:", { width: 8, dim: true }),
      ],
      innerWidth,
    ),
  );
  // Status header (dim, leading space)
  if (statusHeader !== undefined) {
    parts.push(text(` ${statusHeader}`, { width: innerWidth, dim: true }));
  }
  // Spacer
  parts.push(text("", { width: innerWidth }));
  // Hunk header — magenta pill background. Trim because diffs sometimes
  // include trailing whitespace.
  if (hunkHeader !== undefined) {
    const hunk = hunkHeader.trim();
    parts.push(
      rowFrame(
        [
          text(` ${hunk} `, {
            width: hunk.length + 2,
            bg: "#c4b5fd",
            fg: "black",
            bold: true,
          }),
        ],
        innerWidth,
      ),
    );
  }
  // Body lines — strip the leading "  " indent the formatter adds and
  // emit a colored gutter glyph + tinted text.
  for (const line of body) {
    const stripped = line.replace(/^ {2}/, "");
    if (stripped.startsWith("- ")) {
      parts.push(
        rowFrame(
          [
            text("− ", { width: 2, fg: "#f87171", bold: true }),
            text(stripped.slice(2), { width: innerWidth - 2, fg: "#fca5a5" }),
          ],
          innerWidth,
        ),
      );
    } else if (stripped.startsWith("+ ")) {
      parts.push(
        rowFrame(
          [
            text("+ ", { width: 2, fg: "#4ade80", bold: true }),
            text(stripped.slice(2), { width: innerWidth - 2, fg: "#86efac" }),
          ],
          innerWidth,
        ),
      );
    } else {
      // Context — dim
      parts.push(
        rowFrame(
          [
            text("  ", { width: 2, dim: true }),
            text(stripped, { width: innerWidth - 2, dim: true }),
          ],
          innerWidth,
        ),
      );
    }
  }
  const inner = vstack(...parts);
  return borderLeft(pad(inner, 0, 0, 0, 1), COLOR.tool);
}

/**
 * Frame for R1 reasoning preview block. Shows a meta-line with token
 * estimate + footer hint (`/think for full`) and a violet-bordered
 * preview of the trailing 260 chars of reasoning. Mirrors the legacy
 * `<ReasoningBlock>`.
 */
function reasoningFrame(reasoning: string, width: number): Frame {
  const max = 260;
  const flat = reasoning.replace(/\s+/g, " ").trim();
  const preview =
    flat.length <= max ? flat : `… (+${flat.length - max} earlier chars) ${flat.slice(-max)}`;
  const tokensApprox = Math.max(1, Math.round(flat.length / 4.5));
  const tokLabel =
    tokensApprox >= 1000 ? `${(tokensApprox / 1000).toFixed(1)}k` : `${tokensApprox}`;
  const header = rowFrame(
    [
      text("R1 ↯", { width: 5, fg: COLOR.accent, bold: true }),
      text(`  reasoning · ~${tokLabel} tok · /think for full`, {
        width: 28 + tokLabel.length,
        dim: true,
      }),
    ],
    width,
  );
  const previewBody = pad(
    text(preview, { width: width - 2, fg: COLOR.accent, italic: true, dim: true }),
    0,
    0,
    0,
    1,
  );
  const previewBordered = borderLeft(previewBody, COLOR.accent);
  // marginBottom={1} — append a blank row.
  const trail = text("", { width });
  return vstack(header, previewBordered, trail);
}

/**
 * Frame for branch summary header + per-branch uncertainty list.
 * Matches `<BranchBlock>` — pill header + `▸ #N T=X u=description`
 * lines indented by 2.
 */
function branchFrame(branch: BranchSummary, width: number): Frame {
  const pill = rowFrame(
    [
      text(` ⎇ BRANCH ×${branch.budget} `, {
        width: 12 + String(branch.budget).length,
        bg: "#93c5fd",
        fg: "black",
        bold: true,
      }),
      text("  ", { width: 2 }),
      text("picked ", { width: 7, fg: "#93c5fd" }),
      text(`#${branch.chosenIndex}`, {
        width: 1 + String(branch.chosenIndex).length,
        fg: "#93c5fd",
        bold: true,
      }),
    ],
    width,
  );
  const items: Frame[] = [];
  for (let i = 0; i < branch.uncertainties.length; i++) {
    const u = branch.uncertainties[i]!;
    const chosen = i === branch.chosenIndex;
    const t = (branch.temperatures[i] ?? 0).toFixed(1);
    items.push(
      pad(
        rowFrame(
          [
            text(chosen ? "▸ " : "  ", {
              width: 2,
              fg: chosen ? "#93c5fd" : "#475569",
              bold: chosen,
            }),
            text(`#${i}`, {
              width: 1 + String(i).length,
              fg: chosen ? "#93c5fd" : "#94a3b8",
              bold: chosen,
            }),
            text(` T=${t}  u=${u}`, {
              width: width - 2 - 1 - String(i).length,
              dim: true,
            }),
          ],
          width - 2,
        ),
        0,
        0,
        0,
        2,
      ),
    );
  }
  // marginBottom={1}
  const trail = text("", { width });
  return vstack(pill, ...items, trail);
}

/**
 * Frame for typed plan-state block: 1 row per non-empty field with
 * bold colored label + count + items joined by `·`.
 */
function planStateFrame(planState: TypedPlanState, width: number): Frame {
  const fields: Array<[string, string[], string, boolean]> = [];
  if (planState.subgoals.length)
    fields.push(["subgoals", planState.subgoals, COLOR.primary, false]);
  if (planState.hypotheses.length)
    fields.push(["hypotheses", planState.hypotheses, COLOR.assistant, false]);
  if (planState.uncertainties.length)
    fields.push(["uncertainties", planState.uncertainties, COLOR.warn, false]);
  if (planState.rejectedPaths.length)
    fields.push(["rejected", planState.rejectedPaths, COLOR.info, true]);
  if (fields.length === 0) return empty(width);
  const rows: Frame[] = fields.map(([label, items, color, dim]) => {
    const header = `${label} (${items.length})  · `;
    const itemsStr = items.join(" · ");
    return rowFrame(
      [
        text(label, { width: label.length, fg: color, bold: true, dim }),
        text(` (${items.length})  · `, { width: 7 + String(items.length).length, dim: true }),
        text(itemsStr, {
          width: Math.max(8, width - header.length),
          fg: dim ? undefined : COLOR.info,
          dim,
        }),
      ],
      width,
    );
  });
  const trail = text("", { width });
  return vstack(...rows, trail);
}

/**
 * Frame for `/context` token-usage breakdown: 4-color stacked
 * char-bar across 48 cells + legend with per-category counts.
 * Mirrors `<CtxBreakdownBlock>`.
 */
function ctxBreakdownFrame(data: NonNullable<DisplayEvent["ctxBreakdown"]>, width: number): Frame {
  const total = data.systemTokens + data.toolsTokens + data.logTokens + data.inputTokens;
  const winPct = data.ctxMax > 0 ? Math.round((total / data.ctxMax) * 100) : 0;
  const barWidth = 48;
  const cellOf = (n: number) => (data.ctxMax > 0 ? Math.round((n / data.ctxMax) * barWidth) : 0);
  const sysCells = cellOf(data.systemTokens);
  const toolsCells = cellOf(data.toolsTokens);
  const logCells = cellOf(data.logTokens);
  const inputCells = cellOf(data.inputTokens);
  const used = sysCells + toolsCells + logCells + inputCells;
  const freeCells = Math.max(0, barWidth - used);
  const sevColor = winPct >= 80 ? COLOR.err : winPct >= 60 ? COLOR.warn : COLOR.ok;
  const innerWidth = width - 2;

  // Header row
  const headerSegments: Frame[] = [
    text("▣ context", { width: 9, fg: COLOR.brand, bold: true }),
    text(`  ${formatTokens(total)} of ${formatTokens(data.ctxMax)}`, {
      width: 4 + formatTokens(total).length + formatTokens(data.ctxMax).length,
      dim: true,
    }),
    text("  ·  ", { width: 5, dim: true }),
    text(`${winPct}%`, { width: 1 + String(winPct).length, fg: sevColor, bold: true }),
  ];
  if (winPct >= 80) {
    headerSegments.push(text("  ·  /compact", { width: 13, fg: COLOR.err, bold: true }));
  }
  const header = rowFrame(headerSegments, innerWidth);

  // Bar row — 4 colored segments + dim free
  const bar = rowFrame(
    [
      text("█".repeat(sysCells), { width: sysCells, fg: COLOR.brand }),
      text("█".repeat(toolsCells), { width: toolsCells, fg: COLOR.accent }),
      text("█".repeat(logCells), { width: logCells, fg: COLOR.primary }),
      text("█".repeat(inputCells), { width: inputCells, fg: COLOR.tool }),
      text("░".repeat(freeCells), { width: freeCells, fg: COLOR.info, dim: true }),
    ],
    innerWidth,
  );

  // Legend row
  const legend = rowFrame(
    [
      text("■", { width: 1, fg: COLOR.brand }),
      text(` system ${formatTokens(data.systemTokens)}`, {
        width: 8 + formatTokens(data.systemTokens).length,
        dim: true,
      }),
      text("   ", { width: 3 }),
      text("■", { width: 1, fg: COLOR.accent }),
      text(` tools ${formatTokens(data.toolsTokens)}`, {
        width: 7 + formatTokens(data.toolsTokens).length,
        dim: true,
      }),
      text("   ", { width: 3 }),
      text("■", { width: 1, fg: COLOR.primary }),
      text(` log ${formatTokens(data.logTokens)}`, {
        width: 5 + formatTokens(data.logTokens).length,
        dim: true,
      }),
      text("   ", { width: 3 }),
      text("■", { width: 1, fg: COLOR.tool }),
      text(` input ${formatTokens(data.inputTokens)}`, {
        width: 7 + formatTokens(data.inputTokens).length,
        dim: true,
      }),
    ],
    innerWidth,
  );

  const inner = vstack(header, bar, legend);
  // marginY={1} = blank row above + below
  const spacer = text("", { width });
  return vstack(spacer, borderLeft(pad(inner, 0, 0, 0, 1), COLOR.brand), spacer);
}

/**
 * Frame for the COMPLEX assistant turn — branch / reasoning /
 * planState sub-blocks composed into one bordered body, followed by
 * markdown body (rendered as plain text — full markdown→Frame
 * compilation is a future phase), stats, repair.
 */
function complexAssistantFrame(event: DisplayEvent, width: number): Frame {
  const spacer = text("", { width });
  // Header row
  const headerSegs: Frame[] = [text("◆", { width: 1, fg: COLOR.assistant, bold: true })];
  if (event.stats) {
    const modelName = event.stats.model.replace(/^deepseek-/, "");
    headerSegs.push(
      text("  ", { width: 2 }),
      text(` ${modelName} `, {
        width: 2 + modelName.length,
        bg: COLOR.assistant,
        fg: "black",
        bold: true,
      }),
    );
  }
  const header = rowFrame(headerSegs, width);
  // Body sub-blocks (composed inside the bordered column)
  const bodyParts: Frame[] = [];
  const bodyWidth = width - 2; // bar + pad
  if (event.branch) {
    bodyParts.push(branchFrame(event.branch, bodyWidth));
  }
  if (event.reasoning) {
    bodyParts.push(reasoningFrame(event.reasoning, bodyWidth));
  }
  if (event.planState && !isPlanStateEmpty(event.planState)) {
    bodyParts.push(planStateFrame(event.planState, bodyWidth));
  }
  // Body text — markdown-compiled so bold / italic / code / links /
  // headings / lists / code blocks render with their styling.
  // Empty body falls back to a dim placeholder.
  bodyParts.push(
    event.text
      ? markdownToFrame(event.text, bodyWidth)
      : text("(empty body — likely tool-call only)", {
          width: bodyWidth,
          fg: COLOR.assistant,
          dim: true,
        }),
  );
  // Stats line
  if (event.stats) {
    const hit = (event.stats.cacheHitRatio * 100).toFixed(1);
    const hitColor =
      event.stats.cacheHitRatio >= 0.7
        ? "#4ade80"
        : event.stats.cacheHitRatio >= 0.4
          ? "#fcd34d"
          : "#f87171";
    const statsLine = `⌬ ${hit}%  ·  in ${event.stats.usage.promptTokens} → out ${event.stats.usage.completionTokens}  ·  $${event.stats.cost.toFixed(6)}`;
    bodyParts.push(text(statsLine, { width: bodyWidth, fg: hitColor }));
  }
  // Repair note
  if (event.repair) {
    bodyParts.push(text(event.repair, { width: bodyWidth, fg: COLOR.accent }));
  }
  const inner = vstack(...bodyParts);
  const bordered = borderLeft(pad(inner, 0, 0, 0, 1), COLOR.assistant);
  return vstack(spacer, header, spacer, bordered);
}

/**
 * Frame for `plan` events. Header bar + markdown-compiled body, so
 * the model's plan proposal renders with proper inline styling and
 * bullet lists.
 */
function planFrame(event: DisplayEvent, width: number): Frame {
  const header = text("📋 plan proposed — pick a choice below", {
    width: 39,
    fg: "cyan",
    bold: true,
  });
  const headerPadded = rowFrame([header], width);
  const body = markdownToFrame(event.text, width - 2);
  const inner = vstack(headerPadded, text("", { width }), pad(body, 0, 0, 0, 1));
  // marginY={1} on outer
  const spacer = text("", { width });
  return vstack(spacer, inner, spacer);
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
  if (event.role === "user") {
    return { kind: "frame", id: event.id, frame: userFrame(event, width) };
  }
  if (event.role === "tool") {
    const isExplicitError = event.text.startsWith("ERROR:");
    const isEditFile =
      (event.toolName === "edit_file" || event.toolName?.endsWith("_edit_file")) &&
      !isExplicitError;
    if (isEditFile) {
      return { kind: "frame", id: event.id, frame: editFileDiffFrame(event, width) };
    }
    return { kind: "frame", id: event.id, frame: toolCompactFrame(event, width) };
  }
  if (event.role === "assistant" && !event.streaming) {
    const hasComplexSub =
      event.branch || event.reasoning || (event.planState && !isPlanStateEmpty(event.planState));
    if (hasComplexSub) {
      return { kind: "frame", id: event.id, frame: complexAssistantFrame(event, width) };
    }
    return { kind: "frame", id: event.id, frame: simpleAssistantFrame(event, width) };
  }
  if (event.role === "plan") {
    return { kind: "frame", id: event.id, frame: planFrame(event, width) };
  }
  if (event.role === "ctx-breakdown" && event.ctxBreakdown) {
    return {
      kind: "frame",
      id: event.id,
      frame: ctxBreakdownFrame(event.ctxBreakdown, width),
    };
  }
  // Fall back to legacy Ink rendering for roles we haven't migrated
  // (currently: streaming assistant, plan-replay, plan-resumed; the
  // remaining inkblocks are all transient or rare turn-state events).
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
