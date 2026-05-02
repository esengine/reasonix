/** Stdin reader CSI parser — drives the state machine via `feed()`; safety net for the input layer. */

import { describe, expect, it } from "vitest";
import { type KeyEvent, StdinReader } from "../src/cli/ui/stdin-reader.js";

function setup() {
  const reader = new StdinReader();
  const events: KeyEvent[] = [];
  reader.subscribe((ev) => events.push(ev));
  return { reader, events };
}

describe("StdinReader — CSI sequences (well-behaved)", () => {
  it("parses arrow keys", () => {
    const { reader, events } = setup();
    reader.feed("\x1b[A");
    reader.feed("\x1b[B");
    reader.feed("\x1b[C");
    reader.feed("\x1b[D");
    expect(events).toEqual([
      { input: "", upArrow: true },
      { input: "", downArrow: true },
      { input: "", rightArrow: true },
      { input: "", leftArrow: true },
    ]);
  });

  it("parses page-nav keys", () => {
    const { reader, events } = setup();
    reader.feed("\x1b[5~");
    reader.feed("\x1b[6~");
    reader.feed("\x1b[3~");
    expect(events).toEqual([
      { input: "", pageUp: true },
      { input: "", pageDown: true },
      { input: "", delete: true },
    ]);
  });

  it("parses Shift+Tab as `\\x1b[Z`", () => {
    const { reader, events } = setup();
    reader.feed("\x1b[Z");
    expect(events).toEqual([{ input: "", shift: true, tab: true }]);
  });

  it("parses SS3 arrow forms (`\\x1bO<letter>`)", () => {
    const { reader, events } = setup();
    reader.feed("\x1bOA");
    reader.feed("\x1bOC");
    expect(events).toEqual([
      { input: "", upArrow: true },
      { input: "", rightArrow: true },
    ]);
  });

  it("drops unknown CSI silently (no garbage text inserted)", () => {
    const { reader, events } = setup();
    reader.feed("\x1b[42m"); // SGR — irrelevant to us, skip
    expect(events).toEqual([]);
  });
});

describe("StdinReader — CSI sequences (Windows ConPTY ESC-stripped)", () => {
  it("recovers arrow keys when leading ESC is missing", () => {
    const { reader, events } = setup();
    reader.feed("[A");
    reader.feed("[C");
    expect(events).toEqual([
      { input: "", upArrow: true },
      { input: "", rightArrow: true },
    ]);
  });

  it("recovers Shift+Tab from bare `[Z`", () => {
    const { reader, events } = setup();
    reader.feed("[Z");
    expect(events).toEqual([{ input: "", shift: true, tab: true }]);
  });

  it("recovers PgUp / PgDn / Delete from bare CSI tails", () => {
    const { reader, events } = setup();
    reader.feed("[5~");
    reader.feed("[6~");
    reader.feed("[3~");
    expect(events).toEqual([
      { input: "", pageUp: true },
      { input: "", pageDown: true },
      { input: "", delete: true },
    ]);
  });
});

describe("StdinReader — single-byte keys", () => {
  it("Enter / Tab / Backspace fire structured events", () => {
    const { reader, events } = setup();
    reader.feed("\r");
    reader.feed("\t");
    reader.feed("\x7f");
    reader.feed("\b");
    expect(events).toEqual([
      { input: "", return: true },
      { input: "", tab: true },
      { input: "", backspace: true },
      { input: "", backspace: true },
    ]);
  });

  it("Ctrl+C surfaces as `{input:'c', ctrl:true}`", () => {
    const { reader, events } = setup();
    reader.feed("\x03");
    expect(events).toEqual([{ input: "c", ctrl: true }]);
  });

  it("Ctrl+J (LF, 0x0A) surfaces distinctly from Enter so multiline can insert a newline", () => {
    const { reader, events } = setup();
    reader.feed("\r");
    reader.feed("\n");
    expect(events).toEqual([
      { input: "", return: true },
      { input: "j", ctrl: true },
    ]);
  });

  it("modifyOtherKeys / kitty Shift+Enter sequences surface as `{return:true, shift:true}`", () => {
    const { reader, events } = setup();
    reader.feed("\x1b[27;2;13~");
    reader.feed("\x1b[13;2u");
    expect(events).toEqual([
      { input: "", return: true, shift: true },
      { input: "", return: true, shift: true },
    ]);
  });

  it("Ctrl+letter codes 0x01–0x1A map to a..z with ctrl flag", () => {
    const { reader, events } = setup();
    reader.feed("\x01"); // Ctrl+A
    reader.feed("\x05"); // Ctrl+E
    reader.feed("\x15"); // Ctrl+U
    reader.feed("\x17"); // Ctrl+W
    expect(events.map((e) => ({ input: e.input, ctrl: e.ctrl }))).toEqual([
      { input: "a", ctrl: true },
      { input: "e", ctrl: true },
      { input: "u", ctrl: true },
      { input: "w", ctrl: true },
    ]);
  });

  it("printable runs are coalesced into one event", () => {
    const { reader, events } = setup();
    reader.feed("hello");
    expect(events).toEqual([{ input: "hello" }]);
  });

  it("CJK printable runs are coalesced", () => {
    const { reader, events } = setup();
    reader.feed("你好世界");
    expect(events).toEqual([{ input: "你好世界" }]);
  });

  it("printable run breaks at a CSI / control byte", () => {
    const { reader, events } = setup();
    reader.feed("ab\rcd");
    expect(events).toEqual([{ input: "ab" }, { input: "", return: true }, { input: "cd" }]);
  });
});

describe("StdinReader — bracketed paste", () => {
  it("emits a single paste event for content between `\\x1b[200~` and `\\x1b[201~`", () => {
    const { reader, events } = setup();
    reader.feed("\x1b[200~hello\nworld\x1b[201~");
    expect(events).toEqual([{ input: "hello\nworld", paste: true }]);
  });

  it("paste content is collected across multiple feed calls (chunked stdin)", () => {
    const { reader, events } = setup();
    reader.feed("\x1b[200~hello\n");
    reader.feed("middle\n");
    reader.feed("end\x1b[201~");
    expect(events).toEqual([{ input: "hello\nmiddle\nend", paste: true }]);
  });

  it("ESC-stripped paste markers (ConPTY) — bare `[200~`/`[201~` works too", () => {
    const { reader, events } = setup();
    reader.feed("[200~paste content[201~");
    expect(events).toEqual([{ input: "paste content", paste: true }]);
  });

  it("typing AFTER a paste is parsed as keystrokes again", () => {
    const { reader, events } = setup();
    reader.feed("\x1b[200~pasted\x1b[201~hello");
    expect(events).toEqual([{ input: "pasted", paste: true }, { input: "hello" }]);
  });

  it("printable runs do not eat a following paste-start prefix", () => {
    const { reader, events } = setup();
    // `ab` then bare paste-start then content then end.
    reader.feed("ab[200~stuff[201~");
    expect(events).toEqual([{ input: "ab" }, { input: "stuff", paste: true }]);
  });

  it("printable runs do not eat a following ESC-less arrow tail", () => {
    const { reader, events } = setup();
    reader.feed("ab[Ccd");
    expect(events).toEqual([{ input: "ab" }, { input: "", rightArrow: true }, { input: "cd" }]);
  });
});

describe("StdinReader — ESC ambiguity timer", () => {
  it("standalone Esc (no follow-up byte arrives) eventually fires escape:true", async () => {
    const { reader, events } = setup();
    reader.feed("\x1b");
    // The reader schedules a 250ms timer. Wait it out.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(events).toEqual([{ input: "", escape: true }]);
  });

  it("ESC followed by a CSI within the timer window resolves to the CSI event", async () => {
    const { reader, events } = setup();
    reader.feed("\x1b");
    // Some delay — but less than 250ms.
    await new Promise((resolve) => setTimeout(resolve, 50));
    reader.feed("[A");
    // No need to wait; the CSI completes the sequence immediately.
    expect(events).toEqual([{ input: "", upArrow: true }]);
  });
});

describe("StdinReader — ESC + char (Alt+key)", () => {
  it("ESC followed by a non-CSI char fires meta:true", () => {
    const { reader, events } = setup();
    reader.feed("\x1bx");
    expect(events).toEqual([{ input: "x", meta: true }]);
  });
});
