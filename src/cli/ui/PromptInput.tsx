import { Box, Text, useInput, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React as a runtime value (classic transform compiles JSX to React.createElement)
import React, { useRef, useState } from "react";
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
import { useTick } from "./ticker.js";

/**
 * DECSET 2004 (bracketed paste) markers. The terminal sends these
 * around every paste action when bracketed-paste mode is enabled
 * (App.tsx writes the enable sequence at mount). Surface as exact
 * literal byte strings so we can locate them in `input` regardless
 * of how stdin chunks the surrounding bytes.
 */
const PASTE_START_MARKER = "\u001b[200~";
const PASTE_END_MARKER = "\u001b[201~";
/**
 * Merge-fallback window for terminals that strip bracketed-paste
 * markers (Windows PowerShell + ConPTY + Ink eats `\x1b[200~`).
 * One Ctrl+V arrives as N chunks 1-5ms apart; we collapse them by
 * checking arrival time + that the previous sentinel is still at
 * cursor-1 (no typing happened). 30ms is well below the ~100ms
 * minimum a human can release+repress Ctrl+V, so deliberate
 * back-to-back pastes never falsely merge.
 */
const PASTE_MERGE_WINDOW_MS = 30;

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

/**
 * Input box with real cursor support. ←/→ move one column, ↑/↓ move
 * across lines in multi-line buffers, Ctrl+A / Ctrl+E jump to
 * start/end of the current line. Backspace deletes before cursor,
 * Delete deletes under cursor. Multi-line composition via Ctrl+J,
 * Shift+Enter, or bash-style `\<Enter>`.
 *
 * Cursor state lives locally. When the parent replaces `value` out
 * of band (history recall, slash completion, setup wizard) the
 * cursor jumps to end; the `lastLocalValueRef` guards distinguishes
 * that case from our own edits.
 */
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
  // Paste registry. Maps sentinel id → original paste content. Each
  // entry is keyed by the codepoint stored in the buffer string.
  // Lives in a ref because rendering doesn't depend on identity —
  // mutating the map in-place is fine, the per-keystroke render
  // reads the current state directly. `nextPasteIdRef` wraps modulo
  // PASTE_SENTINEL_RANGE; collisions are rare in practice (256 slots,
  // typical session has <10 pastes).
  const pastesRef = useRef<Map<number, PasteEntry>>(new Map());
  const nextPasteIdRef = useRef<number>(0);
  // Bracketed-paste accumulator. When a paste begins, the terminal
  // sends `\x1b[200~`; when it ends, `\x1b[201~`. We accumulate
  // everything between markers into ONE entry. Works on terminals
  // that pass markers through to Ink intact (iTerm, kitty, alacritty,
  // most modern terminals on macOS/Linux). Doesn't work on Windows
  // PowerShell+ConPTY where Ink's parse-keypress eats the markers
  // before we see them — fallback below covers that case.
  // null = not currently inside a paste; string = accumulating.
  const pasteAccumRef = useRef<string | null>(null);
  // Tight time-window merge fallback. When bracketed-paste markers
  // don't reach us (Ink ate them, terminal didn't send them, etc.),
  // a single user paste arrives as N stdin chunks 1-5ms apart, and
  // each chunk on its own looks like a paste burst (multi-line
  // content). Without merging the user gets four `[paste #N]`
  // placeholders for one Ctrl+V. With a 30ms window + a guard that
  // the previous sentinel is still right at cursor-1 (no typing
  // happened in between), chunks of one paste collapse into one
  // entry. The window is below human reaction time for double-
  // pasting (Ctrl+V release → re-press takes 100ms+), so two
  // deliberate pastes never falsely merge.
  const lastPasteRef = useRef<{ id: number; at: number } | null>(null);
  // Tracks the last `value` we ourselves produced via onChange. If the
  // incoming `value` prop diverges from this, the parent (or some other
  // source) replaced the buffer — we reset the cursor to end.
  const lastLocalValueRef = useRef(value);
  if (value !== lastLocalValueRef.current) {
    lastLocalValueRef.current = value;
    if (cursor !== value.length) {
      // Conditional setState during render is the "derived state" pattern;
      // React schedules the re-render and the else branch of the `if`
      // prevents infinite loops.
      setCursor(value.length);
    }
  }
  // Synchronous mirror of `cursor` for the same reason. When two
  // useInput firings happen in the same React tick (PowerShell+Ink
  // emits useInput twice per stdin chunk), the second fire's
  // closure still sees the stale `cursor` from before the first
  // fire's setCursor took effect. Reading from a ref we update
  // synchronously inside `registerPaste` lets the second fire's
  // merge guard see the just-inserted sentinel at cursor-1.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // Shared ticker drives the cursor blink. Dividing the tick by 4 lands
  // the visible on/off cycle around 480ms — standard cursor cadence.
  const tick = useTick();
  const showCursor = disabled ? false : Math.floor(tick / 4) % 2 === 0;

  // Helper: register an accumulated paste blob and insert its
  // sentinel into the buffer at the current cursor. If the previous
  // paste's sentinel is still at cursor-1 AND we're inside the
  // sub-human-reaction merge window, append to that entry instead
  // of creating a new sentinel — this collapses chunks of one
  // user paste action that arrived as multiple stdin reads (the
  // PowerShell+ConPTY+Ink case where bracketed-paste markers got
  // eaten upstream).
  const registerPaste = (content: string) => {
    // Read from refs, NOT from closure variables. PowerShell+Ink
    // fires useInput twice per stdin chunk; both fires close over
    // the same stale `value` and `cursor` from React state. Refs
    // get updated synchronously below, so the second fire sees the
    // just-inserted sentinel at cursor-1 and the merge guard fires
    // correctly. This was the core reason a single Ctrl+V kept
    // producing four `[paste #N]` placeholders.
    const v = lastLocalValueRef.current;
    const c = cursorRef.current;
    const now = Date.now();
    const last = lastPasteRef.current;
    const prevChar = c > 0 ? v[c - 1] : null;
    const prevId = prevChar ? decodePasteSentinel(prevChar) : null;
    const canMerge =
      last !== null &&
      prevId === last.id &&
      now - last.at < PASTE_MERGE_WINDOW_MS &&
      pastesRef.current.has(last.id);
    if (canMerge && last) {
      const existing = pastesRef.current.get(last.id);
      if (existing) {
        const merged = existing.content + content;
        pastesRef.current.set(last.id, makePasteEntry(last.id, merged));
        lastPasteRef.current = { id: last.id, at: now };
        return;
      }
    }
    const id = nextPasteIdRef.current % PASTE_SENTINEL_RANGE;
    nextPasteIdRef.current = id + 1;
    pastesRef.current.set(id, makePasteEntry(id, content));
    const sentinel = encodePasteSentinel(id);
    const next = v.slice(0, c) + sentinel + v.slice(c);
    // Update refs synchronously so the SECOND useInput fire (same
    // React tick) sees the new buffer + cursor. Then schedule the
    // React state updates for re-render.
    lastLocalValueRef.current = next;
    cursorRef.current = c + 1;
    onChange(next);
    setCursor(c + 1);
    lastPasteRef.current = { id, at: now };
  };

  useInput(
    (input, key) => {
      // Bracketed-paste accumulator. The terminal tells us EXACTLY
      // when a paste begins / ends via `\x1b[200~` / `\x1b[201~`.
      // Even when a 50KB paste arrives across many stdin reads,
      // the markers bracket the entire paste once. We accumulate
      // everything between them into a single sentinel — solving
      // the "one user paste shows up as N adjacent placeholders"
      // bug without resorting to time-based heuristics that would
      // wrongly merge two quick deliberate pastes. On terminals
      // that don't support DECSET 2004 (cmd.exe), markers never
      // appear and we fall back to the per-chunk pasteRequest
      // path below — chunks split visually but stay correct.
      if (pasteAccumRef.current !== null) {
        const endIdx = input.indexOf(PASTE_END_MARKER);
        if (endIdx === -1) {
          pasteAccumRef.current += input;
          return;
        }
        const content = pasteAccumRef.current + input.slice(0, endIdx);
        pasteAccumRef.current = null;
        registerPaste(content);
        return;
      }
      const startIdx = input.indexOf(PASTE_START_MARKER);
      if (startIdx !== -1) {
        const afterStart = input.slice(startIdx + PASTE_START_MARKER.length);
        const endIdx = afterStart.indexOf(PASTE_END_MARKER);
        if (endIdx !== -1) {
          // Whole paste in one read — register and we're done.
          registerPaste(afterStart.slice(0, endIdx));
        } else {
          // Open paste mode for subsequent useInput events.
          pasteAccumRef.current = afterStart;
        }
        return;
      }

      const ke: MultilineKey = {
        input,
        return: key.return,
        shift: key.shift,
        ctrl: key.ctrl,
        meta: key.meta,
        backspace: key.backspace,
        delete: key.delete,
        tab: key.tab,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        leftArrow: key.leftArrow,
        rightArrow: key.rightArrow,
        escape: key.escape,
        pageUp: key.pageUp,
        pageDown: key.pageDown,
      };
      const action = processMultilineKey(value, cursor, ke);
      if (action.pasteRequest) {
        // No bracketed-paste markers were seen — terminal doesn't
        // support DECSET 2004, or Ink's key parser ate them. Fall
        // back to per-chunk paste registration. Two chunks of the
        // same big paste land as two placeholders; correctness
        // preserved, only visual cohesion lost.
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
        // Expand sentinels back to real paste content before handing
        // the prompt up to the parent. The buffer carries placeholders
        // for display; the model needs the full text.
        const raw = action.submitValue ?? value;
        const expanded = expandPasteSentinels(raw, pastesRef.current);
        // GC unreachable paste entries — anything whose sentinel was
        // backspace'd out of the buffer before submit. Keeps the
        // registry from growing unbounded across many turns.
        const reachable = new Set(listPasteIdsInBuffer(raw));
        for (const id of pastesRef.current.keys()) {
          if (!reachable.has(id)) pastesRef.current.delete(id);
        }
        onSubmit(expanded);
      }
      if (action.historyHandoff === "prev") onHistoryPrev?.();
      if (action.historyHandoff === "next") onHistoryNext?.();
    },
    { isActive: !disabled },
  );

  // Narrow-terminal mode: drop the `you ›` (6 col) prefix to a `›` (2
  // col) marker so the writable area on 80-col terminals reclaims 4
  // cols. Threshold of 90 keeps the friendly `you ›` on anything that
  // resembles a normal terminal; modern laptops tend to default to
  // 100+ cols, narrow ones (split panes, embedded shells) tend to be
  // <=90. Continuation indent shrinks proportionally so wrapped lines
  // still align under the prompt arrow.
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const narrow = cols <= 90;
  const promptPrefix = narrow ? "› " : "you › ";
  const continuationIndent = narrow ? " " : "     ";
  const placeholderActive = narrow
    ? "type a message, or /command"
    : "type a message, or /command  ·  [Shift+Enter] / [Ctrl+J] newline";
  const effectivePlaceholder = disabled
    ? (placeholder ?? "…waiting for response…")
    : (placeholder ?? placeholderActive);

  const lines = value.length > 0 ? value.split("\n") : [""];
  const borderColor = disabled ? "gray" : "cyan";
  const { line: cursorLine, col: cursorCol } = lineAndColumn(value, cursor);
  // For large buffers (e.g. a big paste), rendering every line
  // re-runs Ink's layout + terminal write on every keystroke. Each
  // keystroke touching 500 rendered lines flickers visibly on most
  // terminals. Collapse to HEAD + cursor-line + TAIL with a dim
  // `[… N lines hidden …]` marker. Edit position is still anywhere;
  // the visible cursor line follows the cursor into/out of the
  // collapsed region so the user never loses sight of what they're
  // typing. Submitted value is the FULL buffer — collapse is purely
  // visual.
  const renderItems = collapseLinesForDisplay(lines, cursorLine);
  // When the buffer is large enough to be collapsed, surface a dim
  // hint about the buffer-wide shortcuts. The user just pasted 500
  // lines; without this they have no idea PageUp/Ctrl+U exist and
  // ↑×500 is the only path back to the top.
  const showHugeBufferHints = lines.length > 20;

  return (
    <>
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
        {renderItems.map((item, renderIdx) => {
          if (item.kind === "skip") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable — skip markers are derived from a fixed-size window over `lines`
              <Box key={`skip-${renderIdx}`}>
                <Text dimColor>{continuationIndent}</Text>
                <Text
                  dimColor
                >{`[… ${item.linesHidden} line${item.linesHidden === 1 ? "" : "s"} hidden — full content kept, submitted on Enter …]`}</Text>
              </Box>
            );
          }
          const line = item.line;
          const i = item.originalIndex;
          const isFirst = i === 0;
          const showPlaceholder = isFirst && value.length === 0;
          const isCursorLine = i === cursorLine;
          return (
            <Box key={`ln-${i}`}>
              {isFirst ? (
                <Text bold color={borderColor}>
                  {promptPrefix}
                </Text>
              ) : (
                <Text dimColor>{continuationIndent}</Text>
              )}
              {showPlaceholder ? (
                <>
                  {isCursorLine && !disabled ? (
                    <Text color={borderColor}>{showCursor ? "▌" : " "}</Text>
                  ) : null}
                  <Text dimColor>{effectivePlaceholder}</Text>
                </>
              ) : isCursorLine && !disabled ? (
                <LineWithCursor
                  line={line}
                  col={cursorCol}
                  showCursor={showCursor}
                  borderColor={borderColor}
                  pastes={pastesRef.current}
                />
              ) : (
                <RenderLine line={line} pastes={pastesRef.current} />
              )}
            </Box>
          );
        })}
        {showHugeBufferHints && !disabled ? (
          <Box>
            <Text dimColor>{continuationIndent}</Text>
            <Text dimColor>
              {`[${lines.length} lines · PageUp/PageDown jump to top/bottom · Ctrl+U clear · Ctrl+W del word]`}
            </Text>
          </Box>
        ) : null}
      </Box>
      {disabled ? (
        <Box paddingX={1}>
          <Text dimColor>[Esc] to stop</Text>
        </Box>
      ) : null}
    </>
  );
}

/**
 * One visual slot in the rendered prompt box. Either a real buffer
 * line (with its original index so the cursor / first-line prefix
 * still line up) or a "skip" marker summarizing hidden rows.
 */
type RenderItem =
  | { kind: "line"; line: string; originalIndex: number }
  | { kind: "skip"; linesHidden: number };

/**
 * Above this line count we stop rendering every line on every
 * keystroke — a 500-line paste would otherwise make Ink redraw
 * hundreds of rows per character typed, which is visibly janky.
 * Chosen empirically: under 20 lines the user is still visually
 * scanning the buffer; above that they're almost always looking
 * at a pasted blob that should be summarized.
 */
const COLLAPSE_THRESHOLD = 20;
const COLLAPSE_HEAD_LINES = 3;
const COLLAPSE_TAIL_LINES = 2;

export function collapseLinesForDisplay(lines: string[], cursorLine: number): RenderItem[] {
  if (lines.length <= COLLAPSE_THRESHOLD) {
    return lines.map((line, i) => ({ kind: "line" as const, line, originalIndex: i }));
  }
  // Always show the first HEAD lines, the last TAIL lines, and
  // the cursor line if it falls in the collapsed middle. Union
  // the indices so head/cursor/tail overlap collapses cleanly.
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

/**
 * Render a buffer line with paste sentinels expanded into magenta
 * `[paste #N · …]` placeholder blocks. Used for non-cursor lines and
 * for the prefix / suffix segments around the cursor on the cursor
 * line.
 *
 * Each codepoint is emitted as either:
 *   - text: accumulated in `buf`, flushed when a sentinel or the end
 *     of the line is reached.
 *   - placeholder block: a styled `[paste #N · 3337l · 184KB]` Text.
 *
 * No layout magic — the emitted segments sit inline in the parent
 * Box's row, just like plain text.
 */
function RenderLine({
  line,
  pastes,
  inverse,
}: {
  line: string;
  pastes: ReadonlyMap<number, PasteEntry>;
  inverse?: boolean;
}) {
  const segments: React.ReactNode[] = [];
  let buf = "";
  let segIdx = 0;
  const flushBuf = () => {
    if (buf.length === 0) return;
    segments.push(
      <Text key={`t-${segIdx++}`} inverse={inverse}>
        {buf}
      </Text>,
    );
    buf = "";
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const id = decodePasteSentinel(ch);
    if (id === null) {
      buf += ch;
      continue;
    }
    flushBuf();
    const entry = pastes.get(id);
    const label = entry
      ? `[paste #${id + 1} · ${entry.lineCount}l · ${formatBytesShort(entry.charCount)}]`
      : `[paste #${id + 1} · (missing)]`;
    segments.push(
      <Text key={`p-${segIdx++}`} color="magenta" bold inverse={inverse}>
        {label}
      </Text>,
    );
  }
  flushBuf();
  if (segments.length === 0) {
    // Empty line — return a single empty Text so Ink still renders a
    // row. Otherwise this Box collapses to zero height.
    return <Text> </Text>;
  }
  return <>{segments}</>;
}

function LineWithCursor({
  line,
  col,
  showCursor,
  borderColor,
  pastes,
}: {
  line: string;
  col: number;
  showCursor: boolean;
  borderColor: "cyan" | "gray";
  pastes: ReadonlyMap<number, PasteEntry>;
}) {
  const before = line.slice(0, col);
  const atCursor = line.slice(col, col + 1);
  const after = line.slice(col + 1);
  if (atCursor.length === 0) {
    // Cursor sits past the last char of this line (end-of-line). Render
    // a trailing block so the user sees where they're typing next.
    return (
      <>
        <RenderLine line={before} pastes={pastes} />
        <Text color={borderColor}>{showCursor ? "▌" : " "}</Text>
      </>
    );
  }
  return (
    <>
      <RenderLine line={before} pastes={pastes} />
      <RenderLine line={atCursor} pastes={pastes} inverse={showCursor} />
      <RenderLine line={after} pastes={pastes} />
    </>
  );
}
