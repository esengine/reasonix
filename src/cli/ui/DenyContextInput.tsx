/**
 * Inline single-line text input for the "deny with context" flow.
 *
 * Replaces `ink-text-input` (which depends on Ink's `useInput`) with
 * our own `useKeystroke` — Reasonix replaces Ink's input layer with
 * its own KeystrokeContext, so ink-text-input's key handler never
 * fires. This component is a ~50-line drop-in that uses the same
 * KeyEvent bus as every other modal component.
 *
 * Renders a prompt label, the typed text, a cursor indicator, and
 * Enter / Esc affordances. Parent switches to this when the user
 * presses Tab on a denyWithContext item in SingleSelect.
 */

import { Box, Text } from "ink";
import React, { useState } from "react";
import { useKeystroke } from "./keystroke-context.js";

export interface DenyContextInputProps {
  /**
   * Label shown before the input field, e.g. "Reason:".
   * Defaults to "Reason for denying:".
   */
  label?: string;
  /** Called with the typed text when the user presses Enter. */
  onSubmit: (context: string) => void;
  /** Called when the user presses Esc — return to the select phase. */
  onCancel: () => void;
}

/**
 * Minimal single-line text input. Cursor is rendered as a block
 * character at the end of the text. Backspace deletes the last
 * character. Enter submits, Esc cancels.
 */
export function DenyContextInput({
  label = "Reason for denying:",
  onSubmit,
  onCancel,
}: DenyContextInputProps) {
  const [value, setValue] = useState("");
  const cursorVisible = true;

  useKeystroke((ev) => {
    if (ev.paste) return;
    if (ev.escape) {
      onCancel();
      return;
    }
    if (ev.return) {
      onSubmit(value);
      return;
    }
    if (ev.backspace) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    // Printable input — append to the value
    if (ev.input && !ev.tab && !ev.upArrow && !ev.downArrow && !ev.leftArrow && !ev.rightArrow) {
      setValue((v) => v + ev.input);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{label} </Text>
        <Text>{value}</Text>
        {cursorVisible ? (
          <Text backgroundColor="#67e8f9" color="black">
            {" "}
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {"["}
          <Text color="#67e8f9" bold>
            Enter
          </Text>
          {"] confirm  ·  ["}
          <Text color="#67e8f9" bold>
            Esc
          </Text>
          {"] cancel"}
        </Text>
      </Box>
    </Box>
  );
}
