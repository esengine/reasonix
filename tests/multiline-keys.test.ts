import { describe, expect, it } from "vitest";
import {
  type MultilineKey,
  lineAndColumn,
  processMultilineKey,
} from "../src/cli/ui/multiline-keys.js";

function key(overrides: Partial<MultilineKey> = {}): MultilineKey {
  return { input: "", ...overrides };
}

describe("processMultilineKey — inserts at cursor", () => {
  it("inserts a printable char at the cursor (mid-string)", () => {
    // "heo", cursor after "he" → insert "ll" in the middle
    const r = processMultilineKey("heo", 2, key({ input: "ll" }));
    expect(r.next).toBe("hello");
    expect(r.cursor).toBe(4);
  });

  it("appends when cursor is at end", () => {
    const r = processMultilineKey("hel", 3, key({ input: "l" }));
    expect(r.next).toBe("hell");
    expect(r.cursor).toBe(4);
  });

  it("inserts at position 0", () => {
    const r = processMultilineKey("bc", 0, key({ input: "a" }));
    expect(r.next).toBe("abc");
    expect(r.cursor).toBe(1);
  });

  it("multi-char paste burst inserts as a block", () => {
    const r = processMultilineKey("ab", 1, key({ input: "XYZ" }));
    expect(r.next).toBe("aXYZb");
    expect(r.cursor).toBe(4);
  });

  it("pasted newline lands inline (not a submit)", () => {
    const r = processMultilineKey("a", 1, key({ input: "\nmore" }));
    expect(r.next).toBe("a\nmore");
    expect(r.submit).toBe(false);
  });
});

describe("processMultilineKey — submit + newline", () => {
  it("Enter submits by default", () => {
    const r = processMultilineKey("hi", 2, key({ return: true }));
    expect(r.submit).toBe(true);
    expect(r.submitValue).toBe("hi");
  });

  it("Shift+Enter inserts a newline at the cursor", () => {
    const r = processMultilineKey("abc", 1, key({ return: true, shift: true }));
    expect(r.next).toBe("a\nbc");
    expect(r.cursor).toBe(2);
    expect(r.submit).toBe(false);
  });

  it("Ctrl+J inserts a newline at the cursor (ASCII LF form)", () => {
    const r = processMultilineKey("abc", 2, key({ input: "\n" }));
    expect(r.next).toBe("ab\nc");
    expect(r.cursor).toBe(3);
  });

  it("Ctrl+J normalized as ctrl+'j' also inserts a newline", () => {
    const r = processMultilineKey("abc", 2, key({ input: "j", ctrl: true }));
    expect(r.next).toBe("ab\nc");
  });

  it("Enter with trailing \\\\ at end-of-buffer → bash continuation", () => {
    const v = "line1\\";
    const r = processMultilineKey(v, v.length, key({ return: true }));
    expect(r.submit).toBe(false);
    expect(r.next).toBe("line1\n");
    expect(r.cursor).toBe(6);
  });

  it("Enter with \\\\ mid-buffer (cursor not at end) does NOT trigger continuation", () => {
    // User has "foo\\bar" and hits Enter with cursor after "foo\\" — that's
    // a real edit, not a continuation marker. Submit instead.
    const r = processMultilineKey("foo\\bar", 4, key({ return: true }));
    expect(r.submit).toBe(true);
    expect(r.next).toBeNull();
  });

  it("plain Enter on an empty buffer still submits", () => {
    const r = processMultilineKey("", 0, key({ return: true }));
    expect(r.submit).toBe(true);
    expect(r.submitValue).toBe("");
  });
});

describe("processMultilineKey — deletion", () => {
  it("Backspace deletes the char BEFORE the cursor, cursor moves back", () => {
    const r = processMultilineKey("abcd", 2, key({ backspace: true }));
    expect(r.next).toBe("acd");
    expect(r.cursor).toBe(1);
  });

  it("Backspace at cursor 0 is a no-op", () => {
    const r = processMultilineKey("abc", 0, key({ backspace: true }));
    expect(r.next).toBeNull();
    expect(r.cursor).toBeNull();
  });

  it("Delete removes the char AT the cursor, cursor stays", () => {
    const r = processMultilineKey("abcd", 1, key({ delete: true }));
    expect(r.next).toBe("acd");
    expect(r.cursor).toBe(1);
  });

  it("Delete at end-of-buffer is a no-op", () => {
    const r = processMultilineKey("abc", 3, key({ delete: true }));
    expect(r.next).toBeNull();
  });

  it("Backspace across a newline removes the newline", () => {
    const r = processMultilineKey("a\nb", 2, key({ backspace: true }));
    expect(r.next).toBe("ab");
    expect(r.cursor).toBe(1);
  });
});

describe("processMultilineKey — cursor motion", () => {
  it("←/→ clamp to the buffer", () => {
    expect(processMultilineKey("abc", 2, key({ leftArrow: true })).cursor).toBe(1);
    expect(processMultilineKey("abc", 0, key({ leftArrow: true })).cursor).toBe(0);
    expect(processMultilineKey("abc", 2, key({ rightArrow: true })).cursor).toBe(3);
    expect(processMultilineKey("abc", 3, key({ rightArrow: true })).cursor).toBe(3);
  });

  it("↑/↓ on a single-line non-empty buffer is a no-op (doesn't eat for history)", () => {
    // Single-line buffer: moveCursorUp has nowhere to go. Returns NOOP so
    // the parent can decide what to do — but parent only does history on
    // empty buffer, so the net effect is "nothing happens."
    const up = processMultilineKey("hello", 3, key({ upArrow: true }));
    expect(up).toEqual({ next: null, cursor: null, submit: false });
    const down = processMultilineKey("hello", 3, key({ downArrow: true }));
    expect(down).toEqual({ next: null, cursor: null, submit: false });
  });

  it("↑/↓ on an empty buffer defers to the parent (history recall)", () => {
    expect(processMultilineKey("", 0, key({ upArrow: true }))).toEqual({
      next: null,
      cursor: null,
      submit: false,
    });
    expect(processMultilineKey("", 0, key({ downArrow: true }))).toEqual({
      next: null,
      cursor: null,
      submit: false,
    });
  });

  it("↑ moves cursor to the previous line, preserving column when possible", () => {
    //  line 0: "hello" (cols 0-5)
    //  line 1: "world" (cols 0-5)
    //  cursor at col 3 on line 1 = index 5 (for "\n") + 3 + 1 = 9
    const v = "hello\nworld";
    const up = processMultilineKey(v, 9, key({ upArrow: true }));
    // target: line 0 col 3 → index 3
    expect(up.cursor).toBe(3);
  });

  it("↑ clamps column when the previous line is shorter", () => {
    const v = "hi\nworld";
    // cursor at line 1 col 4 = index 3 + 4 = 7
    const up = processMultilineKey(v, 7, key({ upArrow: true }));
    // target: line 0 col min(4, 2) = 2 → index 2
    expect(up.cursor).toBe(2);
  });

  it("↓ moves cursor to the next line, preserving column", () => {
    const v = "hello\nworld";
    // cursor at line 0 col 2 = index 2
    const down = processMultilineKey(v, 2, key({ downArrow: true }));
    // target: line 1 col 2 → index 6 + 2 = 8
    expect(down.cursor).toBe(8);
  });

  it("↓ clamps column when the next line is shorter", () => {
    const v = "world\nhi";
    // cursor at line 0 col 4 = index 4
    const down = processMultilineKey(v, 4, key({ downArrow: true }));
    // target: line 1 col min(4, 2) = 2 → index 6 + 2 = 8
    expect(down.cursor).toBe(8);
  });

  it("Ctrl+A jumps to start of current line, Ctrl+E to end", () => {
    const v = "one\ntwo\nthree";
    // cursor mid-"two" at index 5 (o in two)
    expect(processMultilineKey(v, 5, key({ input: "a", ctrl: true })).cursor).toBe(4);
    expect(processMultilineKey(v, 5, key({ input: "e", ctrl: true })).cursor).toBe(7);
  });
});

describe("processMultilineKey — parent-owned keys are ignored", () => {
  it("Tab / Escape / PageUp / PageDown are dropped", () => {
    expect(processMultilineKey("x", 1, key({ tab: true }))).toEqual({
      next: null,
      cursor: null,
      submit: false,
    });
    expect(processMultilineKey("x", 1, key({ escape: true })).next).toBeNull();
    expect(processMultilineKey("x", 1, key({ pageUp: true })).next).toBeNull();
    expect(processMultilineKey("x", 1, key({ pageDown: true })).next).toBeNull();
  });

  it("unhandled Ctrl-<letter> chords are dropped (no accidental insert)", () => {
    const r = processMultilineKey("x", 1, key({ input: "c", ctrl: true }));
    expect(r.next).toBeNull();
    expect(r.cursor).toBeNull();
  });

  it("Meta (Alt) key events are dropped", () => {
    const r = processMultilineKey("x", 1, key({ input: "a", meta: true }));
    expect(r.next).toBeNull();
  });
});

describe("lineAndColumn", () => {
  it("maps a cursor offset to {line, col}", () => {
    expect(lineAndColumn("abc", 2)).toEqual({ line: 0, col: 2 });
    expect(lineAndColumn("abc\ndef", 4)).toEqual({ line: 1, col: 0 });
    expect(lineAndColumn("abc\ndef", 6)).toEqual({ line: 1, col: 2 });
    expect(lineAndColumn("a\n\nb", 2)).toEqual({ line: 1, col: 0 });
    expect(lineAndColumn("a\n\nb", 3)).toEqual({ line: 2, col: 0 });
  });

  it("clamps cursor values past value.length", () => {
    expect(lineAndColumn("abc", 99)).toEqual({ line: 0, col: 3 });
  });
});
