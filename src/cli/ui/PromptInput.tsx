import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React as a runtime value (classic transform compiles JSX to React.createElement)
import React, { useRef, useState } from "react";
import { useKeystroke } from "./keystroke-context.js";
import { type MultilineKey, lineAndColumn, processMultilineKey } from "./multiline-keys.js";
import {
  PASTE_SENTINEL_RANGE,
  type PasteEntry,
  encodePasteSentinel,
  expandPasteSentinels,
  listPasteIdsInBuffer,
  makePasteEntry,
} from "./paste-sentinels.js";
import { type Segment, buildViewport, stringCells } from "./prompt-viewport.js";
import { GRADIENT } from "./theme.js";

/**
 * Visual anchor: a left vertical rule (▎ + space) running down every
 * line of the input. Colored with the accent color so disabled state
 * dims it; gives the input area a clear "you type here" boundary
 * without using bordered Boxes (those amplified Ink's eraseLines
 * miscount on Windows). Length is fixed at 2 so the prefix-cell math
 * stays trivial.
 */
const BAR = "▎ ";

/**
 * Prompt input v2 — no Ink useInput, no Yoga text wrapping, no
 * cursor blink. Replaces the bordered-Box / multi-Text approach
 * that was driving the Windows ghost-row regressions.
 *
 * Pipeline:
 *   - Subscribes to the global keystroke bus (which is fed by our
 *     own raw stdin parser, NOT Ink's parse-keypress).
 *   - Pure events: `paste` events go to the paste registry; everything
 *     else flows through `processMultilineKey` (the existing reducer
 *     with all the cursor / submit / history-recall semantics).
 *   - Render: one logical line per <Box> row. Each row renders as
 *     EXACTLY one visual row — content longer than the visible cell
 *     budget is clipped via `buildViewport`, with `‹` / `›` markers
 *     where content is hidden. The cursor moves the viewport so it
 *     stays visible.
 *
 * Cursor blinks at ~480 ms half-period. The ticker that drives the
 * blink also flows the left-bar gradient and the wordmark, so
 * we're already paying for re-render every tick — the cursor blink
 * is free on top of that. Disabled state freezes the cursor solid
 * so the disabled prompt doesn't compete with the active spinner.
 */

export interface PromptInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /**
   * History recall. Fired when ↑/↓ hits a buffer boundary (empty
   * buffer, or cursor already at the first/last line of a multi-line
   * buffer). Parent walks its prompt history and swaps the value via
   * `onChange`. Absent → keys are consumed silently.
   */
  onHistoryPrev?: () => void;
  onHistoryNext?: () => void;
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  onHistoryPrev,
  onHistoryNext,
}: PromptInputProps) {
  const [cursor, setCursor] = useState(value.length);

  // Paste registry — keyed by sentinel id, holds original content.
  const pastesRef = useRef<Map<number, PasteEntry>>(new Map());
  const nextPasteIdRef = useRef<number>(0);

  // Track external value replacement (history recall, slash completion).
  // When the parent swaps `value` we snap cursor to end.
  const lastLocalValueRef = useRef(value);
  if (value !== lastLocalValueRef.current) {
    lastLocalValueRef.current = value;
    if (cursor !== value.length) setCursor(value.length);
  }

  /**
   * Register one paste blob and insert its sentinel at the current
   * cursor. Used both by `paste` events from the stdin reader (the
   * normal path on terminals that support DECSET 2004) and by the
   * fallback path inside `processMultilineKey` for chunks that
   * arrived without bracketed-paste markers.
   */
  const registerPaste = (content: string) => {
    const v = lastLocalValueRef.current;
    const c = cursor;
    const id = nextPasteIdRef.current % PASTE_SENTINEL_RANGE;
    nextPasteIdRef.current = id + 1;
    pastesRef.current.set(id, makePasteEntry(id, content));
    const sentinel = encodePasteSentinel(id);
    const next = v.slice(0, c) + sentinel + v.slice(c);
    lastLocalValueRef.current = next;
    onChange(next);
    setCursor(c + 1);
  };

  useKeystroke((ev) => {
    if (disabled) return;
    if (ev.paste) {
      // Bracketed-paste content delivered by the stdin reader.
      // Insert as one sentinel regardless of length.
      if (ev.input.length > 0) registerPaste(ev.input);
      return;
    }
    const key: MultilineKey = {
      input: ev.input,
      return: ev.return,
      shift: ev.shift,
      ctrl: ev.ctrl,
      meta: ev.meta,
      backspace: ev.backspace,
      delete: ev.delete,
      tab: ev.tab,
      upArrow: ev.upArrow,
      downArrow: ev.downArrow,
      leftArrow: ev.leftArrow,
      rightArrow: ev.rightArrow,
      escape: ev.escape,
      pageUp: ev.pageUp,
      pageDown: ev.pageDown,
    };
    const action = processMultilineKey(value, cursor, key);
    if (action.pasteRequest) {
      registerPaste(action.pasteRequest.content);
      return;
    }
    if (action.next !== null) {
      lastLocalValueRef.current = action.next;
      onChange(action.next);
    }
    if (action.cursor !== null) {
      setCursor(action.cursor);
    }
    if (action.submit) {
      const raw = action.submitValue ?? value;
      const expanded = expandPasteSentinels(raw, pastesRef.current);
      // GC unreachable paste entries — anything backspace'd out of
      // the buffer before submit. Keeps the registry from growing
      // unbounded across many turns.
      const reachable = new Set(listPasteIdsInBuffer(raw));
      for (const id of pastesRef.current.keys()) {
        if (!reachable.has(id)) pastesRef.current.delete(id);
      }
      onSubmit(expanded);
    }
    if (action.historyHandoff === "prev") onHistoryPrev?.();
    if (action.historyHandoff === "next") onHistoryNext?.();
  }, !disabled);

  // ── Render ──────────────────────────────────────────────────────

  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const narrow = cols <= 90;
  const promptBody = narrow ? "› " : "you › ";
  const promptPrefix = BAR + promptBody;
  const continuationIndent = BAR + " ".repeat(promptBody.length);
  const prefixCells = promptPrefix.length;
  // Reserve 2 cells for the surrounding `paddingX={1}` plus 1 cell
  // for the cursor block when at end-of-line. Net visible budget per
  // line.
  const visibleCells = Math.max(8, cols - prefixCells - 3);

  const placeholderActive = narrow
    ? "type a message, or /command"
    : "type a message, or /command  ·  [Ctrl+J] newline  ·  [Ctrl+P/N] history";
  const effectivePlaceholder = disabled
    ? (placeholder ?? "…waiting for response…")
    : (placeholder ?? placeholderActive);

  const lines = value.length > 0 ? value.split("\n") : [""];
  const accentColor = disabled ? "gray" : "cyan";
  // Static bar + static cursor. Earlier versions flowed the bar
  // gradient and blinked the cursor via the global ticker; both
  // drove per-tick re-renders that interleaved badly with terminal
  // resize (Ink's eraseLines miscounts logical vs visual rows on
  // wrap, ghost frames stack). The bar still gets a gradient — just
  // a fixed sweep based on row index, no time component.
  const barColorAt = (rowIdx: number): string =>
    disabled ? "gray" : GRADIENT[((rowIdx % GRADIENT.length) + GRADIENT.length) % GRADIENT.length]!;
  const cursorVisible = true;
  const { line: cursorLine, col: cursorCol } = lineAndColumn(value, cursor);

  // Big-buffer mitigation: if the buffer has many logical lines,
  // collapse middle rows so Ink isn't redrawing 500+ rows per
  // keystroke.
  const renderItems = collapseLinesForDisplay(lines, cursorLine);
  const showHugeBufferHints = lines.length > 20;

  return (
    <Box flexDirection="column" paddingX={1}>
      {renderItems.map((item, renderIdx) => {
        if (item.kind === "skip") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable — collapse markers derive from a fixed sliding window
            <Box key={`skip-${renderIdx}`}>
              <Text color={barColorAt(renderIdx)}>{BAR}</Text>
              <Text dimColor>{continuationIndent.slice(BAR.length)}</Text>
              <Text dimColor>
                {`[… ${item.linesHidden} line${item.linesHidden === 1 ? "" : "s"} hidden — full content kept, submitted on Enter …]`}
              </Text>
            </Box>
          );
        }
        const i = item.originalIndex;
        const line = item.line;
        const isFirst = i === 0;
        const isCursorLine = i === cursorLine;
        const showPlaceholder = isFirst && value.length === 0;
        return (
          <PromptLine
            key={`ln-${i}`}
            line={line}
            isFirst={isFirst}
            isCursorLine={isCursorLine && !disabled}
            cursorCol={isCursorLine ? cursorCol : null}
            cursorVisible={cursorVisible}
            showPlaceholder={showPlaceholder}
            placeholderText={effectivePlaceholder}
            promptPrefix={promptPrefix}
            continuationIndent={continuationIndent}
            visibleCells={visibleCells}
            accentColor={accentColor}
            barColor={barColorAt(i)}
            pastes={pastesRef.current}
            disabled={disabled === true}
          />
        );
      })}
      {showHugeBufferHints && !disabled ? (
        <Box>
          <Text color={barColorAt(0)}>{BAR}</Text>
          <Text dimColor>{continuationIndent.slice(BAR.length)}</Text>
          <Text dimColor>
            {`[${lines.length} lines · PageUp/PageDown jump to top/bottom · Ctrl+U clear · Ctrl+W del word]`}
          </Text>
        </Box>
      ) : null}
      {!disabled && !narrow && value.length > 0 && !value.includes("\n") ? (
        <Box>
          <Text color={barColorAt(0)}>{BAR}</Text>
          <Text dimColor>{continuationIndent.slice(BAR.length)}</Text>
          <Text dimColor>
            [Ctrl+J] newline · [Enter] submit · ends with \ for line continuation
          </Text>
        </Box>
      ) : null}
      {!disabled && !narrow && value.length === 0 ? (
        <Box>
          <Text color={barColorAt(0)}>{BAR}</Text>
          <Text dimColor>{continuationIndent.slice(BAR.length)}</Text>
          <Text dimColor>
            [PgUp/PgDn] scroll log · [End] jump to latest · drag to select & copy · /mouse on for
            wheel
          </Text>
        </Box>
      ) : null}
      {disabled ? (
        <Box>
          <Text color={barColorAt(0)}>{BAR}</Text>
          <Text dimColor>{continuationIndent.slice(BAR.length)}</Text>
          <Text dimColor>[Esc] to stop</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ── PromptLine ────────────────────────────────────────────────────

interface PromptLineProps {
  line: string;
  isFirst: boolean;
  isCursorLine: boolean;
  cursorCol: number | null;
  /** True when the cursor block / inverse char should be drawn this tick. */
  cursorVisible: boolean;
  showPlaceholder: boolean;
  placeholderText: string;
  promptPrefix: string;
  continuationIndent: string;
  visibleCells: number;
  accentColor: "cyan" | "gray";
  /** Animated gradient color for the leading ▎ bar. Differs per row + tick. */
  barColor: string;
  pastes: ReadonlyMap<number, PasteEntry>;
  disabled: boolean;
}

function PromptLine({
  line,
  isFirst,
  isCursorLine,
  cursorCol,
  cursorVisible,
  showPlaceholder,
  placeholderText,
  promptPrefix,
  continuationIndent,
  visibleCells,
  accentColor,
  barColor,
  pastes,
  disabled,
}: PromptLineProps) {
  // The leading BAR cells of every prefix/continuation are the left
  // anchor bar — render them as a separate span colored by the
  // animated gradient so the bar appears to flow vertically.
  const barText = promptPrefix.slice(0, BAR.length);
  const bodyPrefix = promptPrefix.slice(BAR.length);
  const bodyContinuation = continuationIndent.slice(BAR.length);
  if (showPlaceholder) {
    return (
      <Box>
        <Text color={barColor}>{barText}</Text>
        <Text bold color={accentColor}>
          {bodyPrefix}
        </Text>
        {!disabled ? <Text color={accentColor}>{cursorVisible ? "▌" : " "}</Text> : null}
        <Text dimColor>{placeholderText}</Text>
      </Box>
    );
  }

  const viewport = buildViewport(line, isCursorLine ? cursorCol : null, visibleCells, pastes);

  // Render: prefix + (left marker?) + segments-with-cursor + (right marker?)
  return (
    <Box>
      <Text color={barColor}>{barText}</Text>
      {isFirst ? (
        <Text bold color={accentColor}>
          {bodyPrefix}
        </Text>
      ) : (
        <Text dimColor>{bodyContinuation}</Text>
      )}
      {viewport.hiddenLeft ? (
        <Text color="gray" dimColor>
          ‹
        </Text>
      ) : null}
      <ViewportContent
        segments={viewport.segments}
        cursorCell={isCursorLine ? viewport.cursorCell : null}
        accentColor={accentColor}
        cursorVisible={cursorVisible}
      />
      {viewport.hiddenRight ? (
        <Text color="gray" dimColor>
          ›
        </Text>
      ) : null}
    </Box>
  );
}

// ── ViewportContent ────────────────────────────────────────────────

/**
 * Render a viewport's segments with a cursor block at `cursorCell`.
 * Walks segments in order; the cursor splits at most one segment
 * (the one containing the cursor cell), producing an inverted char
 * at that position.
 *
 * End-of-line cursor (cursorCell points past the last cell of the
 * last segment): emit a trailing block.
 */
function ViewportContent({
  segments,
  cursorCell,
  accentColor,
  cursorVisible,
}: {
  segments: Segment[];
  cursorCell: number | null;
  accentColor: "cyan" | "gray";
  cursorVisible: boolean;
}) {
  // No cursor on this line — straight render.
  if (cursorCell === null) {
    return <>{segments.map((seg, i) => renderSegment(seg, i, false))}</>;
  }

  // Walk segments tallying cells; once we reach `cursorCell`, split
  // the segment to insert the cursor block.
  const out: React.ReactNode[] = [];
  let cells = 0;
  let placed = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const segCells = segmentCells(seg);
    if (placed) {
      out.push(renderSegment(seg, i, false));
      continue;
    }
    if (cursorCell >= cells + segCells) {
      // Cursor isn't in this segment.
      out.push(renderSegment(seg, i, false));
      cells += segCells;
      continue;
    }
    // Cursor lands inside this segment.
    if (seg.kind === "paste") {
      // The cursor is "on" the paste sentinel — render the paste
      // block inversed so the user sees they're at it. Inverse
      // toggles with the blink so the paste sentinel stays
      // legible during the cursor's "off" half-cycle.
      out.push(
        <Text key={`p-${i}-cursor`} color="magenta" bold inverse={cursorVisible}>
          {seg.label}
        </Text>,
      );
      placed = true;
      cells += segCells;
      continue;
    }
    // text segment — split before/at-cursor/after by cell offset.
    const offsetIntoSeg = cursorCell - cells;
    const split = splitTextByCells(seg.text, offsetIntoSeg);
    if (split.before.length > 0) {
      out.push(<Text key={`t-${i}-b`}>{split.before}</Text>);
    }
    if (split.atCursor.length > 0) {
      out.push(
        <Text key={`t-${i}-c`} inverse={cursorVisible} color={accentColor}>
          {split.atCursor}
        </Text>,
      );
    } else {
      // Cursor sits past the segment's last char (end-of-text in this
      // segment). Render block here, blinking with the tick.
      out.push(
        <Text key={`t-${i}-c-eol`} color={accentColor}>
          {cursorVisible ? "▌" : " "}
        </Text>,
      );
    }
    if (split.after.length > 0) {
      out.push(<Text key={`t-${i}-a`}>{split.after}</Text>);
    }
    placed = true;
    cells += segCells;
  }

  // Cursor sits past every segment (end of line).
  if (!placed) {
    out.push(
      <Text key="cursor-eol" color={accentColor}>
        {cursorVisible ? "▌" : " "}
      </Text>,
    );
  }

  return <>{out}</>;
}

function segmentCells(seg: Segment): number {
  if (seg.kind === "paste") return seg.label.length;
  return stringCells(seg.text);
}

/**
 * Split a text string at a cell offset, returning the chars before
 * the offset, the char AT the offset (the cursor block highlights
 * it), and the chars after. A wide char that straddles the offset
 * is treated as the cursor's char.
 */
function splitTextByCells(
  text: string,
  cellOffset: number,
): { before: string; atCursor: string; after: string } {
  let cells = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const cw = charCellsForText(ch);
    if (cells === cellOffset) {
      return { before: text.slice(0, i), atCursor: ch, after: text.slice(i + 1) };
    }
    if (cells + cw > cellOffset) {
      // The wide char straddles the offset — show it as the cursor char.
      return { before: text.slice(0, i), atCursor: ch, after: text.slice(i + 1) };
    }
    cells += cw;
  }
  // Cursor at end of text.
  return { before: text, atCursor: "", after: "" };
}

/**
 * Local cell-counting helper — duplicates `charCells` from
 * prompt-viewport but inlined to avoid a back-and-forth import (this
 * function is hot per-keystroke). Keep in sync.
 */
function charCellsForText(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return 0;
  if (code < 0x1100) return 1;
  if (code >= 0x1100 && code <= 0x115f) return 2;
  if (code >= 0x2e80 && code <= 0x303e) return 2;
  if (code >= 0x3041 && code <= 0x33ff) return 2;
  if (code >= 0x3400 && code <= 0x4dbf) return 2;
  if (code >= 0x4e00 && code <= 0x9fff) return 2;
  if (code >= 0xa000 && code <= 0xa4cf) return 2;
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0xfe30 && code <= 0xfe4f) return 2;
  if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  return 1;
}

function renderSegment(seg: Segment, key: number, _inverse: boolean): React.ReactNode {
  if (seg.kind === "text") {
    return <Text key={`s-${key}`}>{seg.text}</Text>;
  }
  // Paste sentinels render as a fuchsia bg-pill so they're visually
  // distinct from typed text — the user can see "this is the
  // collapsed paste, not 47 lines of code I typed". Matches the
  // bg-pill idiom used elsewhere (mode bars, tool names).
  return (
    <Text key={`s-${key}`} backgroundColor="#f0abfc" color="black" bold>
      {seg.label}
    </Text>
  );
}

// ── collapse helper (preserved from v1) ────────────────────────────

type RenderItem =
  | { kind: "line"; line: string; originalIndex: number }
  | { kind: "skip"; linesHidden: number };

const COLLAPSE_THRESHOLD = 20;
const COLLAPSE_HEAD_LINES = 3;
const COLLAPSE_TAIL_LINES = 2;

export function collapseLinesForDisplay(lines: string[], cursorLine: number): RenderItem[] {
  if (lines.length <= COLLAPSE_THRESHOLD) {
    return lines.map((line, i) => ({ kind: "line" as const, line, originalIndex: i }));
  }
  const keep = new Set<number>();
  for (let i = 0; i < COLLAPSE_HEAD_LINES && i < lines.length; i++) keep.add(i);
  for (let i = Math.max(0, lines.length - COLLAPSE_TAIL_LINES); i < lines.length; i++) keep.add(i);
  if (cursorLine >= 0 && cursorLine < lines.length) keep.add(cursorLine);
  const sorted = [...keep].sort((a, b) => a - b);
  const out: RenderItem[] = [];
  let prev = -1;
  for (const idx of sorted) {
    if (idx - prev > 1) {
      out.push({ kind: "skip", linesHidden: idx - prev - 1 });
    }
    out.push({ kind: "line", line: lines[idx] ?? "", originalIndex: idx });
    prev = idx;
  }
  return out;
}
