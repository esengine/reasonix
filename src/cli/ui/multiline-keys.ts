/**
 * Pure keystroke → action reducer for PromptInput.
 *
 * Kept separate from the React component so the keyboard semantics
 * are easy to unit-test. The component threads `useInput` through
 * this function and applies the returned action.
 *
 * Edit model:
 *   - Full cursor support. ←/→ move one column. ↑/↓ move across
 *     lines in a multi-line buffer (column preserved when possible).
 *     Ctrl+A / Ctrl+E jump to start / end of the current line.
 *   - Backspace deletes the char before the cursor; Delete deletes
 *     the char under the cursor.
 *   - Printable chars (including multi-char paste bursts) insert
 *     at the cursor.
 *   - Enter submits unless Shift is held (newline), the line ends
 *     with '\' and cursor is at end (bash-style continuation), or
 *     the input is Ctrl+J (LF, terminal-universal newline).
 *   - Parent owns Tab, Esc, PageUp/Down (slash-complete, abort,
 *     unused). Arrow keys are split: empty buffer → parent (history
 *     recall); non-empty → child (cursor movement).
 */

export interface MultilineKey {
  input: string;
  return?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  escape?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

export interface MultilineAction {
  /** New buffer value. `null` = unchanged. */
  next: string | null;
  /** New cursor position (0..value.length). `null` = unchanged. */
  cursor: number | null;
  /** When `true`, fire `onSubmit(submitValue ?? value)`. */
  submit: boolean;
  submitValue?: string;
}

const BACKSLASH_SUFFIX = /\\$/;

const NOOP: MultilineAction = { next: null, cursor: null, submit: false };

export function processMultilineKey(
  value: string,
  cursor: number,
  key: MultilineKey,
): MultilineAction {
  // Parent-owned keys: Tab (slash-complete), Esc (abort), PageUp/Down.
  if (key.tab || key.escape || key.pageUp || key.pageDown) {
    return NOOP;
  }

  // Empty buffer + ↑/↓ → parent handles history recall.
  if (value.length === 0 && (key.upArrow || key.downArrow)) {
    return NOOP;
  }

  // Cursor motion.
  if (key.leftArrow) {
    return { next: null, cursor: Math.max(0, cursor - 1), submit: false };
  }
  if (key.rightArrow) {
    return { next: null, cursor: Math.min(value.length, cursor + 1), submit: false };
  }
  if (key.upArrow) {
    const moved = moveCursorUp(value, cursor);
    return moved === cursor ? NOOP : { next: null, cursor: moved, submit: false };
  }
  if (key.downArrow) {
    const moved = moveCursorDown(value, cursor);
    return moved === cursor ? NOOP : { next: null, cursor: moved, submit: false };
  }

  // Emacs-style line jumps (universal across terminals; Home/End aren't
  // reliably reported by Ink so we don't depend on them).
  if (key.ctrl && key.input === "a") {
    return { next: null, cursor: startOfLine(value, cursor), submit: false };
  }
  if (key.ctrl && key.input === "e") {
    return { next: null, cursor: endOfLine(value, cursor), submit: false };
  }

  // Newline: Ctrl+J (LF literal) or ctrl+'j' normalized form.
  if (key.input === "\n" || (key.ctrl && key.input === "j")) {
    return insertAt(value, cursor, "\n");
  }

  if (key.return) {
    if (key.shift) return insertAt(value, cursor, "\n");
    // Bash-style line continuation: trailing '\' + Enter (only when the
    // cursor sits at end-of-buffer, so a stray '\' mid-line doesn't
    // trigger it).
    if (cursor === value.length && BACKSLASH_SUFFIX.test(value)) {
      const replaced = `${value.slice(0, -1)}\n`;
      return { next: replaced, cursor: replaced.length, submit: false };
    }
    return { next: null, cursor: null, submit: true, submitValue: value };
  }

  if (key.backspace) {
    if (cursor === 0) return NOOP;
    return {
      next: value.slice(0, cursor - 1) + value.slice(cursor),
      cursor: cursor - 1,
      submit: false,
    };
  }
  if (key.delete) {
    if (cursor === value.length) return NOOP;
    return {
      next: value.slice(0, cursor) + value.slice(cursor + 1),
      cursor,
      submit: false,
    };
  }

  // Bare modifier events (Ctrl/Meta with no printable) and unhandled
  // Ctrl-<letter> chords are dropped so a stray Ctrl+L doesn't insert "l".
  if ((key.ctrl || key.meta) && key.input.length === 0) return NOOP;
  if (key.ctrl || key.meta) return NOOP;

  // Printable input (may be a multi-char paste; pasted newlines land
  // inside the buffer rather than triggering submit on the first line).
  if (key.input.length > 0) {
    return insertAt(value, cursor, key.input);
  }

  return NOOP;
}

function insertAt(value: string, cursor: number, insert: string): MultilineAction {
  return {
    next: value.slice(0, cursor) + insert + value.slice(cursor),
    cursor: cursor + insert.length,
    submit: false,
  };
}

/**
 * Line + column of a cursor inside a buffer. Exported because the
 * renderer needs the same mapping for drawing the cursor block on the
 * right line.
 */
export function lineAndColumn(value: string, cursor: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  const n = Math.min(cursor, value.length);
  for (let i = 0; i < n; i++) {
    if (value[i] === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

function startOfLine(value: string, cursor: number): number {
  return value.lastIndexOf("\n", cursor - 1) + 1;
}

function endOfLine(value: string, cursor: number): number {
  const nl = value.indexOf("\n", cursor);
  return nl === -1 ? value.length : nl;
}

function moveCursorUp(value: string, cursor: number): number {
  const curStart = startOfLine(value, cursor);
  if (curStart === 0) return cursor; // already on the first line
  const col = cursor - curStart;
  const prevEnd = curStart - 1; // the '\n' between the two lines
  const prevStart = value.lastIndexOf("\n", prevEnd - 1) + 1;
  const prevLen = prevEnd - prevStart;
  return prevStart + Math.min(col, prevLen);
}

function moveCursorDown(value: string, cursor: number): number {
  const nextNl = value.indexOf("\n", cursor);
  if (nextNl === -1) return cursor; // already on the last line
  const curStart = startOfLine(value, cursor);
  const col = cursor - curStart;
  const nextStart = nextNl + 1;
  const followingNl = value.indexOf("\n", nextStart);
  const nextLen = (followingNl === -1 ? value.length : followingNl) - nextStart;
  return nextStart + Math.min(col, nextLen);
}
