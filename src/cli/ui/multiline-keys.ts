/** Pure keystroke→action reducer; arrow keys at buffer boundary defer to the parent for history recall. */

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
  home?: boolean;
  end?: boolean;
}

export interface MultilineAction {
  /** New buffer value. `null` = unchanged. */
  next: string | null;
  /** New cursor position (0..value.length). `null` = unchanged. */
  cursor: number | null;
  /** When `true`, fire `onSubmit(submitValue ?? value)`. */
  submit: boolean;
  submitValue?: string;
  /** Set when ↑/↓ hits a buffer boundary — parent handles history recall. */
  historyHandoff?: "prev" | "next";
  /** Reducer is pure — hands raw paste to PromptInput which allocates a sentinel and inserts that. */
  pasteRequest?: { content: string };
}

import { recoverCsiTail, stripCsiFragments } from "./key-normalize.js";

const BACKSLASH_SUFFIX = /\\$/;

const NOOP: MultilineAction = { next: null, cursor: null, submit: false };

export function processMultilineKey(
  value: string,
  cursor: number,
  keyIn: MultilineKey,
): MultilineAction {
  // CSI recovery — bare `[A` / `[C` / `[Z` / `[5~` / etc. that
  // Windows ConPTY leaves in `input` after parse-keypress eats the
  // leading `\x1b`. See key-normalize.ts for the long version.
  const recovered = recoverCsiTail(keyIn.input, keyIn);
  const key: MultilineKey = recovered ? { ...keyIn, ...recovered, input: "" } : keyIn;

  // Parent-owned keys: Tab (slash-complete), Esc (abort).
  if (key.tab || key.escape) {
    return NOOP;
  }

  // Buffer-wide navigation. Per-line motion (↑/↓ / Ctrl+A / Ctrl+E)
  // is already covered; PageUp/PageDown are the missing "jump to
  // top / bottom of the WHOLE buffer" pair, useful after pasting a
  // 500-line blob where ↑×500 is absurd. Repurposed from the
  // previous NOOP behavior (PageUp/Down had no binding).
  if (key.pageUp) {
    return cursor === 0 ? NOOP : { next: null, cursor: 0, submit: false };
  }
  if (key.pageDown) {
    return cursor === value.length ? NOOP : { next: null, cursor: value.length, submit: false };
  }

  // History recall is bound to Ctrl+P / Ctrl+N (bash readline
  // convention) rather than ↑/↓. Reason: Windows Terminal + ConPTY
  // translates mouse wheel events to ↑/↓ keystrokes for raw-mode
  // child processes — indistinguishable at the byte level. If ↑/↓
  // recalled history, every wheel-scroll would corrupt the prompt
  // with a prior message. Ctrl+P/N is wheel-immune.
  if (key.ctrl && key.input === "p") {
    return { ...NOOP, historyHandoff: "prev" };
  }
  if (key.ctrl && key.input === "n") {
    return { ...NOOP, historyHandoff: "next" };
  }

  // Cursor motion. Empty single-line buffer + ↑/↓ is now a no-op
  // (used to recall history; see Ctrl+P/N comment above).
  if (key.leftArrow) {
    return { next: null, cursor: Math.max(0, cursor - 1), submit: false };
  }
  if (key.rightArrow) {
    return { next: null, cursor: Math.min(value.length, cursor + 1), submit: false };
  }
  if (key.upArrow) {
    if (value.length === 0) return { ...NOOP, historyHandoff: "prev" };
    const moved = moveCursorUp(value, cursor);
    return moved === cursor ? NOOP : { next: null, cursor: moved, submit: false };
  }
  if (key.downArrow) {
    if (value.length === 0) return { ...NOOP, historyHandoff: "next" };
    const moved = moveCursorDown(value, cursor);
    return moved === cursor ? NOOP : { next: null, cursor: moved, submit: false };
  }

  // Emacs-style line jumps. Home/End come through our own stdin reader
  // (see stdin-reader.ts CSI_TAIL_MAP); Ctrl+A/E stay as universal aliases.
  if ((key.ctrl && key.input === "a") || key.home) {
    return { next: null, cursor: startOfLine(value, cursor), submit: false };
  }
  if ((key.ctrl && key.input === "e") || key.end) {
    return { next: null, cursor: endOfLine(value, cursor), submit: false };
  }
  // Bash / readline conventions:
  //   Ctrl+U — clear the whole buffer (readline treats this as
  //     "clear from cursor to start"; for our text-area we treat it
  //     as "clear all" because there's no ergonomic way to clear a
  //     huge paste otherwise).
  //   Ctrl+K — kill from cursor to end of current line.
  //   Ctrl+W / Alt+Backspace — delete the word before the cursor.
  //   Alt+B / Alt+F — jump cursor backward / forward by one word.
  if (key.ctrl && key.input === "u") {
    return value.length === 0 ? NOOP : { next: "", cursor: 0, submit: false };
  }
  if (key.ctrl && key.input === "k") {
    const lineEnd = endOfLine(value, cursor);
    if (lineEnd === cursor) return NOOP;
    return {
      next: value.slice(0, cursor) + value.slice(lineEnd),
      cursor,
      submit: false,
    };
  }
  if (
    (key.ctrl && key.input === "w") ||
    (key.meta && (key.backspace || key.input === "\x7f" || key.input === "\b"))
  ) {
    if (cursor === 0) return NOOP;
    const wordStart = previousWordStart(value, cursor);
    return {
      next: value.slice(0, wordStart) + value.slice(cursor),
      cursor: wordStart,
      submit: false,
    };
  }
  if (key.meta && key.input === "b") {
    const target = previousWordStart(value, cursor);
    return target === cursor ? NOOP : { next: null, cursor: target, submit: false };
  }
  if (key.meta && key.input === "f") {
    const target = nextWordEnd(value, cursor);
    return target === cursor ? NOOP : { next: null, cursor: target, submit: false };
  }

  // Paste-burst detection. If `input` contains a newline (or
  // bracketed-paste markers from a terminal that supports them),
  // this is a paste — surface it as a `pasteRequest` so the parent
  // can register the blob and insert ONE sentinel codepoint instead
  // of the full content. The buffer stays small + readable; the
  // user sees `[paste #N · M lines]` where the paste lives.
  //
  // Always overrides `key.return` for pastes: Ink occasionally sets
  // key.return when a paste's trailing \n looks like Enter, which
  // would submit the partial buffer mid-paste and silently truncate
  // the content. Pastes always insert; Enter only submits typed
  // content. We normalize \r\n and bare \r to \n so mixed-line-
  // ending pastes (Windows clipboard, web copy) land cleanly.
  // Strip every recognised CSI fragment (paste markers, arrow tails,
  // etc.) defensively — if any leaked past structured-key recovery
  // they shouldn't get inserted into the buffer as text.
  const stripped = stripCsiFragments(key.input);
  // Paste = newline-containing input with MORE than just the newline
  // itself. A bare "\n" is Ctrl+J / one-keystroke newline (handled
  // below); only multi-char input wrapped around a newline is a real
  // paste burst that warrants a sentinel.
  const looksLikePaste =
    stripped.length > 1 && (stripped.includes("\n") || stripped.includes("\r"));
  if (looksLikePaste) {
    const normalized = stripped.replace(/\r\n?/g, "\n");
    return {
      next: null,
      cursor: null,
      submit: false,
      pasteRequest: { content: normalized },
    };
  }
  // Single-char Ctrl+J / LF: insert one newline.
  if (key.input === "\n" || (key.ctrl && key.input === "j")) {
    return insertAt(value, cursor, "\n");
  }

  if (key.return) {
    if (key.shift || key.meta) return insertAt(value, cursor, "\n");
    // Bash-style line continuation: trailing '\' + Enter (only when the
    // cursor sits at end-of-buffer, so a stray '\' mid-line doesn't
    // trigger it).
    if (cursor === value.length && BACKSLASH_SUFFIX.test(value)) {
      const replaced = `${value.slice(0, -1)}\n`;
      return { next: replaced, cursor: replaced.length, submit: false };
    }
    return { next: null, cursor: null, submit: true, submitValue: value };
  }

  // Backspace = delete the char BEFORE the cursor. We also accept
  // `key.delete` and the raw DEL (0x7f) / BS (0x08) bytes as backspace
  // for the same purpose — some Windows terminals (cmd.exe, certain
  // winpty configs) report plain Backspace without setting
  // `key.backspace`, which used to leave the user typing into a prompt
  // where the Backspace key did nothing. Reasonix doesn't offer a
  // separate forward-delete operation, so collapsing them is safe.
  if (key.backspace || key.delete || key.input === "\x7f" || key.input === "\b") {
    if (cursor === 0) return NOOP;
    return {
      next: value.slice(0, cursor - 1) + value.slice(cursor),
      cursor: cursor - 1,
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

/** Skips trailing whitespace first so Ctrl+W after a space still removes the previous word. */
function previousWordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(value[i - 1] ?? "")) i--;
  while (i > 0 && !/\s/.test(value[i - 1] ?? "")) i--;
  return i;
}

/** Symmetric to previousWordStart: skip leading whitespace, then run to next word boundary. */
function nextWordEnd(value: string, cursor: number): number {
  let i = cursor;
  const n = value.length;
  while (i < n && /\s/.test(value[i] ?? "")) i++;
  while (i < n && !/\s/.test(value[i] ?? "")) i++;
  return i;
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
