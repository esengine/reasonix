/** PromptInput viewport clipping — logical-line → single-visual-row math (CJK=2, ASCII=1, control=0). */

import { describe, expect, it } from "vitest";
import {
  type PasteEntry,
  encodePasteSentinel,
  makePasteEntry,
} from "../src/cli/ui/paste-sentinels.js";
import { buildViewport, charCells, stringCells } from "../src/cli/ui/prompt-viewport.js";

describe("charCells", () => {
  it("ASCII printable = 1 cell", () => {
    expect(charCells("a")).toBe(1);
    expect(charCells("Z")).toBe(1);
    expect(charCells(" ")).toBe(1);
  });

  it("control chars = 0 cells", () => {
    expect(charCells("\x00")).toBe(0);
    expect(charCells("\x1b")).toBe(0);
    expect(charCells("\x7f")).toBe(0);
  });

  it("CJK ideographs = 2 cells", () => {
    expect(charCells("你")).toBe(2);
    expect(charCells("漢")).toBe(2);
    expect(charCells("日")).toBe(2);
  });

  it("Hiragana / Katakana = 2 cells", () => {
    expect(charCells("あ")).toBe(2);
    expect(charCells("カ")).toBe(2);
  });

  it("Hangul Syllables = 2 cells", () => {
    expect(charCells("한")).toBe(2);
  });

  it("Fullwidth ASCII = 2 cells", () => {
    expect(charCells("ａ")).toBe(2);
    expect(charCells("１")).toBe(2);
  });
});

describe("stringCells", () => {
  it("sums cells for mixed ASCII/CJK strings", () => {
    expect(stringCells("ab你好")).toBe(2 + 2 + 2);
  });

  it("includes paste sentinel placeholder width", () => {
    const id = 0;
    const sentinel = encodePasteSentinel(id);
    const entry = makePasteEntry(id, "x".repeat(100));
    const map: ReadonlyMap<number, PasteEntry> = new Map([[id, entry]]);
    const totalWithoutPaste = stringCells("ab", map);
    const total = stringCells(`ab${sentinel}`, map);
    expect(total).toBeGreaterThan(totalWithoutPaste);
    expect(total - totalWithoutPaste).toBeGreaterThan(20);
  });
});

describe("buildViewport — fits-in-budget fast path", () => {
  it("returns the whole line when it fits", () => {
    const vp = buildViewport("hello", 0, 80);
    expect(vp.segments).toEqual([{ kind: "text", text: "hello" }]);
    expect(vp.cursorCell).toBe(0);
    expect(vp.hiddenLeft).toBe(false);
    expect(vp.hiddenRight).toBe(false);
  });

  it("places cursor at end-of-line correctly", () => {
    const vp = buildViewport("hello", 5, 80);
    expect(vp.cursorCell).toBe(5);
  });

  it("returns null cursorCell when cursorCol is null", () => {
    const vp = buildViewport("hello", null, 80);
    expect(vp.cursorCell).toBeNull();
  });

  it("CJK content cell-counts correctly", () => {
    // "你好" is 4 cells, fits in 80.
    const vp = buildViewport("你好", 1, 80);
    expect(vp.segments).toEqual([{ kind: "text", text: "你好" }]);
    expect(vp.cursorCell).toBe(2);
  });
});

describe("buildViewport — clipping (cursor-bearing line)", () => {
  it("cursor near start of long line: window starts at 0, right-edge marked hidden", () => {
    const longLine = "a".repeat(200);
    const vp = buildViewport(longLine, 5, 40);
    expect(vp.hiddenLeft).toBe(false);
    expect(vp.hiddenRight).toBe(true);
    // Cursor cell still computable.
    expect(vp.cursorCell).toBeGreaterThanOrEqual(0);
  });

  it("cursor at end of long line: window slides right, left-edge marked hidden", () => {
    const longLine = "a".repeat(200);
    const vp = buildViewport(longLine, 200, 40);
    expect(vp.hiddenLeft).toBe(true);
    expect(vp.hiddenRight).toBe(false);
  });

  it("cursor in middle of long line: both sides hidden, cursor in viewport", () => {
    const longLine = "a".repeat(200);
    const vp = buildViewport(longLine, 100, 40);
    expect(vp.hiddenLeft).toBe(true);
    expect(vp.hiddenRight).toBe(true);
    // Sum of segment cells should be <= visibleCells - 2 (markers).
    const visible = vp.segments.reduce(
      (sum, s) => sum + (s.kind === "text" ? s.text.length : s.label.length),
      0,
    );
    expect(visible).toBeLessThanOrEqual(40);
  });
});

describe("buildViewport — clipping (static line, no cursor)", () => {
  it("clips long static line at the right with hiddenRight=true", () => {
    const vp = buildViewport("a".repeat(100), null, 30);
    expect(vp.hiddenLeft).toBe(false);
    expect(vp.hiddenRight).toBe(true);
    expect(vp.cursorCell).toBeNull();
  });
});

describe("buildViewport — paste sentinels", () => {
  it("renders a paste sentinel as one paste segment with its label", () => {
    const id = 0;
    const sentinel = encodePasteSentinel(id);
    const entry = makePasteEntry(id, "hello\nworld");
    const map = new Map([[id, entry]]);
    const vp = buildViewport(`a${sentinel}b`, 1, 80, map);
    expect(vp.segments).toHaveLength(3);
    expect(vp.segments[0]).toEqual({ kind: "text", text: "a" });
    expect(vp.segments[1]).toMatchObject({ kind: "paste", id });
    expect(vp.segments[2]).toEqual({ kind: "text", text: "b" });
  });

  it("missing paste entry renders the `(missing)` placeholder", () => {
    const sentinel = encodePasteSentinel(7);
    const vp = buildViewport(sentinel, 0, 80);
    expect(vp.segments).toHaveLength(1);
    const seg = vp.segments[0]!;
    expect(seg.kind).toBe("paste");
    if (seg.kind !== "paste") return;
    expect(seg.id).toBe(7);
    expect(seg.label).toContain("paste #8");
    expect(seg.label).toContain("(missing)");
  });
});
