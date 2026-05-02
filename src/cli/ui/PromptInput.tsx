import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React as a runtime value (classic transform compiles JSX to React.createElement)
import React, { useRef, useState } from "react";
import { useKeystroke } from "./keystroke-context.js";
import { useReserveRows } from "./layout/viewport-budget.js";
import { type MultilineKey, lineAndColumn, processMultilineKey } from "./multiline-keys.js";
import {
  PASTE_SENTINEL_RANGE,
  type PasteEntry,
  decodePasteSentinel,
  encodePasteSentinel,
  expandPasteSentinels,
  formatBytesShort,
  listPasteIdsInBuffer,
  makePasteEntry,
} from "./paste-sentinels.js";
import { type Segment, buildViewport, stringCells } from "./prompt-viewport.js";
import { FG, SURFACE, TONE } from "./theme/tokens.js";

/** Raw-stdin keystroke bus → multiline reducer; one logical line per Box row, viewport-clipped. */

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
  // Cap at 24 — collapseLinesForDisplay hides content past ~20 logical lines.
  const inputLineCount = value.length > 0 ? value.split("\n").length : 1;
  useReserveRows("input", { min: 1, max: Math.min(inputLineCount + 3, 24) });

  const [cursor, setCursor] = useState(value.length);

  // Paste registry — keyed by sentinel id, holds original content.
  const pastesRef = useRef<Map<number, PasteEntry>>(new Map());
  const nextPasteIdRef = useRef<number>(0);

  // Refs (not props/state) — multiple keystrokes in one stdin chunk dispatch
  // before re-render, so the handler must read the latest value/cursor.
  const lastLocalValueRef = useRef(value);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  if (value !== lastLocalValueRef.current) {
    lastLocalValueRef.current = value;
    if (cursor !== value.length) {
      cursorRef.current = value.length;
      setCursor(value.length);
    }
  }

  const registerPaste = (content: string) => {
    const v = lastLocalValueRef.current;
    const c = cursorRef.current;
    const id = nextPasteIdRef.current % PASTE_SENTINEL_RANGE;
    nextPasteIdRef.current = id + 1;
    pastesRef.current.set(id, makePasteEntry(id, content));
    const sentinel = encodePasteSentinel(id);
    const next = v.slice(0, c) + sentinel + v.slice(c);
    lastLocalValueRef.current = next;
    cursorRef.current = c + 1;
    onChange(next);
    setCursor(c + 1);
  };

  useKeystroke((ev) => {
    if (disabled) return;
    if (ev.paste) {
      // Bracketed-paste content delivered by the stdin reader.
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
      home: ev.home,
      end: ev.end,
    };
    const action = processMultilineKey(lastLocalValueRef.current, cursorRef.current, key);
    if (action.pasteRequest) {
      registerPaste(action.pasteRequest.content);
      return;
    }
    if (action.next !== null) {
      lastLocalValueRef.current = action.next;
      onChange(action.next);
    }
    if (action.cursor !== null) {
      cursorRef.current = action.cursor;
      setCursor(action.cursor);
    }
    if (action.submit) {
      const raw = action.submitValue ?? lastLocalValueRef.current;
      const expanded = expandPasteSentinels(raw, pastesRef.current);
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
  const promptPrefix = "› ";
  const continuationIndent = "  ";
  const prefixCells = promptPrefix.length;
  const visibleCells = Math.max(8, cols - prefixCells - 3);

  // Hint avoids literal `/` and `@` glyphs — they render in the same row as
  // a just-cleared buffer and read as residual typed input on dim-poor terminals.
  const effectivePlaceholder = disabled
    ? (placeholder ?? "…waiting for response…")
    : (placeholder ?? "type a message · slash for commands · at-sign for files");

  const lines = value.length > 0 ? value.split("\n") : [""];
  const accentColor = disabled ? FG.faint : TONE.brand;
  const cursorVisible = true;
  const { line: cursorLine, col: cursorCol } = lineAndColumn(value, cursor);

  const renderItems = collapseLinesForDisplay(lines, cursorLine);
  const showHugeBufferHints = lines.length > 20;

  return (
    <Box flexDirection="column" paddingX={1}>
      {(() => {
        const rows: React.ReactNode[] = [];
        let firstRowEmitted = false;
        for (let renderIdx = 0; renderIdx < renderItems.length; renderIdx++) {
          const item = renderItems[renderIdx]!;
          if (item.kind === "skip") {
            rows.push(
              <Box key={`skip-${renderIdx}`}>
                <Text color={FG.faint}>{continuationIndent}</Text>
                <Text color={FG.faint}>
                  {`[… ${item.linesHidden} line${item.linesHidden === 1 ? "" : "s"} hidden — full content kept, submitted on Enter …]`}
                </Text>
              </Box>,
            );
            continue;
          }
          const i = item.originalIndex;
          const line = item.line;
          const isCursorLine = i === cursorLine;
          const showPlaceholder = i === 0 && value.length === 0;
          if (showPlaceholder) {
            rows.push(
              <PromptLine
                key={`ln-${i}-text-0`}
                line=""
                isFirst={true}
                isCursorLine={isCursorLine && !disabled}
                cursorCol={isCursorLine ? cursorCol : null}
                cursorVisible={cursorVisible}
                showPlaceholder
                placeholderText={effectivePlaceholder}
                promptPrefix={promptPrefix}
                continuationIndent={continuationIndent}
                visibleCells={visibleCells}
                accentColor={accentColor}
                pastes={pastesRef.current}
                disabled={disabled === true}
              />,
            );
            firstRowEmitted = true;
            continue;
          }
          const segs = splitLineByPastes(line);
          for (let segIdx = 0; segIdx < segs.length; segIdx++) {
            const seg = segs[segIdx]!;
            const isFirst = !firstRowEmitted;
            firstRowEmitted = true;
            if (seg.kind === "paste") {
              const cursorOnIt =
                isCursorLine && cursorCol >= seg.startOffset && cursorCol <= seg.startOffset + 1;
              rows.push(
                <PasteChipRow
                  key={`ln-${i}-paste-${segIdx}`}
                  entry={pastesRef.current.get(seg.id)}
                  pasteId={seg.id}
                  isFirst={isFirst}
                  active={cursorOnIt && !disabled}
                  visibleCells={visibleCells}
                  accentColor={accentColor}
                />,
              );
              continue;
            }
            const segHasCursor =
              isCursorLine &&
              cursorCol >= seg.startOffset &&
              cursorCol <= seg.startOffset + seg.text.length;
            rows.push(
              <PromptLine
                key={`ln-${i}-text-${segIdx}`}
                line={seg.text}
                isFirst={isFirst}
                isCursorLine={segHasCursor && !disabled}
                cursorCol={segHasCursor ? cursorCol - seg.startOffset : null}
                cursorVisible={cursorVisible}
                showPlaceholder={false}
                placeholderText=""
                promptPrefix={promptPrefix}
                continuationIndent={continuationIndent}
                visibleCells={visibleCells}
                accentColor={accentColor}
                pastes={pastesRef.current}
                disabled={disabled === true}
              />,
            );
          }
          if (segs.length === 0) {
            const isFirst = !firstRowEmitted;
            firstRowEmitted = true;
            rows.push(
              <PromptLine
                key={`ln-${i}-empty`}
                line=""
                isFirst={isFirst}
                isCursorLine={isCursorLine && !disabled}
                cursorCol={isCursorLine ? 0 : null}
                cursorVisible={cursorVisible}
                showPlaceholder={false}
                placeholderText=""
                promptPrefix={promptPrefix}
                continuationIndent={continuationIndent}
                visibleCells={visibleCells}
                accentColor={accentColor}
                pastes={pastesRef.current}
                disabled={disabled === true}
              />,
            );
          }
        }
        return rows;
      })()}
      {showHugeBufferHints && !disabled ? (
        <Box>
          <Text color={FG.faint}>
            {`  [${lines.length} lines · PgUp/PgDn jump · Ctrl+U clear · Ctrl+W del word]`}
          </Text>
        </Box>
      ) : null}
      {!disabled ? (
        <Box marginTop={1}>
          <Text color={FG.faint}>
            {"  ⏎ send  ·  shift/alt+⏎ newline  ·  ↑↓ history  ·  esc abort  ·  ctrl-c quit"}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={FG.faint}>{"  esc to stop"}</Text>
        </Box>
      )}
    </Box>
  );
}

type LineSegment =
  | { kind: "text"; text: string; startOffset: number }
  | { kind: "paste"; id: number; startOffset: number };

function splitLineByPastes(line: string): LineSegment[] {
  const out: LineSegment[] = [];
  let textBuf = "";
  let textStart = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const id = decodePasteSentinel(ch);
    if (id === null) {
      if (textBuf === "") textStart = i;
      textBuf += ch;
      continue;
    }
    if (textBuf !== "") {
      out.push({ kind: "text", text: textBuf, startOffset: textStart });
      textBuf = "";
    }
    out.push({ kind: "paste", id, startOffset: i });
  }
  if (textBuf !== "") out.push({ kind: "text", text: textBuf, startOffset: textStart });
  return out;
}

interface PasteChipRowProps {
  entry: PasteEntry | undefined;
  pasteId: number;
  isFirst: boolean;
  active: boolean;
  visibleCells: number;
  accentColor: string;
}

function PasteChipRow({
  entry,
  pasteId,
  isFirst,
  active,
  visibleCells,
  accentColor,
}: PasteChipRowProps): React.ReactElement {
  const promptPrefix = "› ";
  const continuationIndent = "  ";
  const lead = isFirst ? promptPrefix : continuationIndent;
  const leadColor = isFirst ? accentColor : FG.faint;
  const labelText = formatChipLabel(entry, pasteId, visibleCells - 6);
  if (active) {
    return (
      <Box>
        <Text bold color={leadColor}>
          {lead}
        </Text>
        <Text bold color={accentColor}>
          {"▸ "}
        </Text>
        <Text bold color="black" backgroundColor={accentColor}>
          {`  ${labelText}  `}
        </Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text bold color={leadColor}>
        {lead}
      </Text>
      <Text color={FG.faint}>{"  "}</Text>
      <Text color={FG.meta}>{"┌ "}</Text>
      <Text color={FG.body} backgroundColor={SURFACE.bgElev}>
        {`${labelText} `}
      </Text>
      <Text color={FG.meta}>{" ┐"}</Text>
    </Box>
  );
}

function formatChipLabel(entry: PasteEntry | undefined, pasteId: number, budget: number): string {
  if (!entry) return `📋 paste #${pasteId + 1} · (missing)`;
  const lines = `${entry.lineCount} line${entry.lineCount === 1 ? "" : "s"}`;
  const bytes = formatBytesShort(entry.charCount);
  const kind = sniffChipKind(entry.content);
  const full = `📋 pasted  ${lines} · ${bytes}  ·  ${kind}  ^O expand · ⌫ remove`;
  if (full.length <= Math.max(40, budget)) return full;
  const compact = `📋 pasted  ${lines} · ${bytes}  ·  ${kind}`;
  if (compact.length <= Math.max(30, budget)) return compact;
  return `📋 pasted  ${lines} · ${bytes}`;
}

function sniffChipKind(content: string): string {
  const head = content.slice(0, 1024);
  if (/^\s*[{[]/.test(head)) {
    try {
      JSON.parse(head);
      return "json";
    } catch {
      /* not parseable; fall through */
    }
  }
  if (/\n\s+at\s+\S+\s*\(/.test(head)) return "stacktrace";
  if (/^(diff --git|@@ )/m.test(head)) return "diff";
  if (/^\s*<!doctype|^\s*<html/i.test(head)) return "html";
  if (/^\s*\$\s+\w/.test(head) || /\n\s*\$\s+\w/.test(head)) return "shell";
  return "text";
}

// ── PromptLine ────────────────────────────────────────────────────

interface PromptLineProps {
  line: string;
  isFirst: boolean;
  isCursorLine: boolean;
  cursorCol: number | null;
  cursorVisible: boolean;
  showPlaceholder: boolean;
  placeholderText: string;
  promptPrefix: string;
  continuationIndent: string;
  visibleCells: number;
  accentColor: string;
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
  pastes,
  disabled,
}: PromptLineProps) {
  if (showPlaceholder) {
    return (
      <Box>
        <Text bold color={accentColor}>
          {promptPrefix}
        </Text>
        {!disabled ? <Text color={accentColor}>{cursorVisible ? "▌" : " "}</Text> : null}
        <Text color={FG.faint}>{placeholderText}</Text>
      </Box>
    );
  }

  const viewport = buildViewport(line, isCursorLine ? cursorCol : null, visibleCells, pastes);

  return (
    <Box>
      {isFirst ? (
        <Text bold color={accentColor}>
          {promptPrefix}
        </Text>
      ) : (
        <Text color={FG.faint}>{continuationIndent}</Text>
      )}
      {viewport.hiddenLeft ? <Text color={FG.faint}>{"‹"}</Text> : null}
      <ViewportContent
        segments={viewport.segments}
        cursorCell={isCursorLine ? viewport.cursorCell : null}
        accentColor={accentColor}
        cursorVisible={cursorVisible}
      />
      {viewport.hiddenRight ? <Text color={FG.faint}>{"›"}</Text> : null}
    </Box>
  );
}

// ── ViewportContent ────────────────────────────────────────────────

/** Cursor splits at most one segment; trailing block when past the last cell. */
function ViewportContent({
  segments,
  cursorCell,
  accentColor,
  cursorVisible,
}: {
  segments: Segment[];
  cursorCell: number | null;
  accentColor: string;
  cursorVisible: boolean;
}) {
  // No cursor on this line — straight render.
  if (cursorCell === null) {
    return <>{segments.map((seg, i) => renderSegment(seg, i, false))}</>;
  }

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
      out.push(renderSegment(seg, i, false));
      cells += segCells;
      continue;
    }
    if (seg.kind === "paste") {
      out.push(
        <Text
          key={`p-${i}-cursor`}
          color={FG.body}
          backgroundColor={SURFACE.bgElev}
          inverse={cursorVisible}
        >
          {seg.label}
        </Text>,
      );
      placed = true;
      cells += segCells;
      continue;
    }
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

/** Wide char straddling the offset is treated as the cursor's char. */
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
      return { before: text.slice(0, i), atCursor: ch, after: text.slice(i + 1) };
    }
    cells += cw;
  }
  return { before: text, atCursor: "", after: "" };
}

/** Inlined cell counter — hot per-keystroke; keep in sync with prompt-viewport. */
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
  return (
    <Text key={`s-${key}`} backgroundColor={SURFACE.bgElev} color={FG.body}>
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
