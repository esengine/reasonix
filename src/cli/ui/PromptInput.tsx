import { Box, Text, useInput } from "ink";
import React, { useRef, useState } from "react";
import { type MultilineKey, lineAndColumn, processMultilineKey } from "./multiline-keys.js";
import { useTick } from "./ticker.js";

export interface PromptInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
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
}: PromptInputProps) {
  const [cursor, setCursor] = useState(value.length);
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

  // Shared ticker drives the cursor blink. Dividing the tick by 4 lands
  // the visible on/off cycle around 480ms — standard cursor cadence.
  const tick = useTick();
  const showCursor = disabled ? false : Math.floor(tick / 4) % 2 === 0;

  useInput(
    (input, key) => {
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
      if (action.next !== null) {
        lastLocalValueRef.current = action.next;
        onChange(action.next);
      }
      if (action.cursor !== null) {
        setCursor(action.cursor);
      }
      if (action.submit) onSubmit(action.submitValue ?? value);
    },
    { isActive: !disabled },
  );

  const effectivePlaceholder = disabled
    ? (placeholder ?? "…waiting for response…")
    : (placeholder ?? "type a message, or /command · Ctrl+J for newline");

  const lines = value.length > 0 ? value.split("\n") : [""];
  const borderColor = disabled ? "gray" : "cyan";
  const { line: cursorLine, col: cursorCol } = lineAndColumn(value, cursor);

  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      {lines.map((line, i) => {
        const isFirst = i === 0;
        const showPlaceholder = isFirst && value.length === 0;
        const isCursorLine = i === cursorLine;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable by construction — lines are derived from `value.split("\n")` and never reordered
          <Box key={i}>
            {isFirst ? (
              <Text bold color={borderColor}>
                you ›{" "}
              </Text>
            ) : (
              <Text dimColor>{"     "}</Text>
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
              />
            ) : (
              <Text>{line}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function LineWithCursor({
  line,
  col,
  showCursor,
  borderColor,
}: {
  line: string;
  col: number;
  showCursor: boolean;
  borderColor: "cyan" | "gray";
}) {
  const before = line.slice(0, col);
  const atCursor = line.slice(col, col + 1);
  const after = line.slice(col + 1);
  if (atCursor.length === 0) {
    // Cursor sits past the last char of this line (end-of-line). Render
    // a trailing block so the user sees where they're typing next.
    return (
      <>
        <Text>{before}</Text>
        <Text color={borderColor}>{showCursor ? "▌" : " "}</Text>
      </>
    );
  }
  return (
    <>
      <Text>{before}</Text>
      <Text inverse={showCursor}>{atCursor}</Text>
      <Text>{after}</Text>
    </>
  );
}
