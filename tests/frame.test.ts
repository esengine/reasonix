import { describe, expect, it } from "vitest";
import {
  blank,
  borderLeft,
  bottom,
  empty,
  fitWidth,
  frameToAnsi,
  graphemeWidth,
  graphemes,
  hstack,
  overlay,
  pad,
  rowText,
  slice,
  stringWidth,
  text,
  viewport,
  vstack,
} from "../src/frame/index.js";
import type { Frame } from "../src/frame/index.js";

/** Width invariant — every primitive must preserve `Frame.width`; miscount → slicer drift. */
function assertWidthInvariant(f: Frame): void {
  for (let i = 0; i < f.rows.length; i++) {
    const row = f.rows[i]!;
    let visualWidth = 0;
    for (const c of row) {
      if (c.tail) continue;
      visualWidth += c.width;
    }
    expect(visualWidth, `row ${i}: visualWidth=${visualWidth}, expected ${f.width}`).toBe(f.width);
    // Also: tail cells must immediately follow a 2-wide head.
    for (let j = 0; j < row.length; j++) {
      if (row[j]!.tail) {
        expect(j > 0, `row ${i}: tail at index 0`).toBe(true);
        const head = row[j - 1]!;
        expect(head.width, `row ${i}: tail at ${j} not preceded by 2-wide head`).toBe(2);
      }
    }
  }
}

describe("graphemeWidth", () => {
  it("returns 1 for ASCII", () => {
    for (const ch of "abcXYZ0123!@#") {
      expect(graphemeWidth(ch)).toBe(1);
    }
  });
  it("returns 2 for CJK", () => {
    for (const ch of "你好世界中文漢字") {
      expect(graphemeWidth(ch)).toBe(2);
    }
  });
  it("returns 2 for Hiragana / Katakana / Hangul", () => {
    expect(graphemeWidth("あ")).toBe(2);
    expect(graphemeWidth("ア")).toBe(2);
    expect(graphemeWidth("한")).toBe(2);
  });
  it("returns 2 for common emoji", () => {
    expect(graphemeWidth("😀")).toBe(2);
    expect(graphemeWidth("🎉")).toBe(2);
  });
  it("returns 0 for combining marks / ZWJ / variation selectors", () => {
    expect(graphemeWidth("\u0301")).toBe(0); // combining acute
    expect(graphemeWidth("\u200D")).toBe(0); // ZWJ
    expect(graphemeWidth("\uFE0F")).toBe(0); // VS-16
  });
  it("returns 0 for control chars", () => {
    expect(graphemeWidth("\x00")).toBe(0);
    expect(graphemeWidth("\x1B")).toBe(0);
  });
});

describe("graphemes / stringWidth", () => {
  it("clusters ZWJ emoji as one grapheme", () => {
    const family = "👨‍👩‍👧";
    expect(graphemes(family).length).toBe(1);
    // Family emoji renders as ONE wide cell visually.
    expect(stringWidth(family)).toBe(2);
  });
  it("sums widths for mixed scripts", () => {
    expect(stringWidth("hello 你好")).toBe(5 + 1 + 4); // "hello" 5 + space 1 + 你好 (2+2)
  });
  it("handles combining diacriticals", () => {
    // "é" written as e + combining acute should be width 1
    expect(stringWidth("e\u0301")).toBe(1);
  });
});

describe("empty / blank", () => {
  it("empty frame has no rows", () => {
    const f = empty(80);
    expect(f.width).toBe(80);
    expect(f.rows.length).toBe(0);
  });
  it("blank fills a rectangle of spaces", () => {
    const f = blank(5, 3);
    expect(f.width).toBe(5);
    expect(f.rows.length).toBe(3);
    expect(rowText(f.rows[0]!)).toBe("     ");
    assertWidthInvariant(f);
  });
  it("blank with non-positive dim returns empty", () => {
    expect(blank(0, 5).rows.length).toBe(0);
    expect(blank(5, 0).rows.length).toBe(0);
    expect(blank(-1, 5).rows.length).toBe(0);
  });
});

describe("text", () => {
  it("renders a short single-line string", () => {
    const f = text("hello", { width: 10 });
    expect(f.rows.length).toBe(1);
    expect(rowText(f.rows[0]!)).toBe("hello     ");
    assertWidthInvariant(f);
  });
  it("wraps at width boundary on graphemes", () => {
    const f = text("hello world this is a longer string", { width: 12 });
    expect(f.rows.length).toBeGreaterThanOrEqual(3);
    for (const r of f.rows) expect(rowText(r).length).toBeLessThanOrEqual(12);
    assertWidthInvariant(f);
  });
  it("respects newlines as hard breaks", () => {
    const f = text("ab\ncd\nef", { width: 5 });
    expect(f.rows.length).toBe(3);
    expect(rowText(f.rows[0]!)).toBe("ab   ");
    expect(rowText(f.rows[1]!)).toBe("cd   ");
    expect(rowText(f.rows[2]!)).toBe("ef   ");
    assertWidthInvariant(f);
  });
  it("emits one blank row for empty line", () => {
    const f = text("\n", { width: 5 });
    expect(f.rows.length).toBe(2);
    expect(rowText(f.rows[0]!)).toBe("     ");
    assertWidthInvariant(f);
  });
  it("CJK chars take 2 cells with tail", () => {
    const f = text("你好", { width: 5 });
    expect(f.rows.length).toBe(1);
    const row = f.rows[0]!;
    expect(row[0]!.char).toBe("你");
    expect(row[0]!.width).toBe(2);
    expect(row[1]!.tail).toBe(true);
    expect(row[2]!.char).toBe("好");
    expect(row[3]!.tail).toBe(true);
    expect(row[4]!.char).toBe(" ");
    assertWidthInvariant(f);
  });
  it("attaches style to every cell", () => {
    const f = text("abc", { width: 5, fg: "#ff0000", bold: true });
    expect(f.rows[0]![0]!.fg).toBe("#ff0000");
    expect(f.rows[0]![0]!.bold).toBe(true);
    // padding cells stay unstyled
    expect(f.rows[0]![3]!.fg).toBeUndefined();
  });
  it("CJK that won't fit wraps to next row", () => {
    const f = text("你好世界", { width: 5 });
    // "你好" = 4 cells, "世" = 2 cells → 6 > 5, "世" wraps; "界" follows
    expect(f.rows.length).toBe(2);
    expect(rowText(f.rows[0]!)).toBe("你好 ");
    expect(rowText(f.rows[1]!)).toBe("世界 ");
    assertWidthInvariant(f);
  });
});

describe("vstack", () => {
  it("concatenates rows", () => {
    const a = text("aa", { width: 3 });
    const b = text("bb", { width: 3 });
    const c = vstack(a, b);
    expect(c.rows.length).toBe(2);
    expect(c.width).toBe(3);
    assertWidthInvariant(c);
  });
  it("right-pads narrower frames to widest", () => {
    const narrow = text("a", { width: 1 });
    const wide = text("hello", { width: 5 });
    const stacked = vstack(narrow, wide);
    expect(stacked.width).toBe(5);
    expect(rowText(stacked.rows[0]!)).toBe("a    ");
    expect(rowText(stacked.rows[1]!)).toBe("hello");
    assertWidthInvariant(stacked);
  });
  it("is empty for empty input", () => {
    expect(vstack().rows.length).toBe(0);
  });
});

describe("hstack", () => {
  it("concatenates each row across frames", () => {
    const a = text("aa", { width: 2 });
    const b = text("bb", { width: 2 });
    const c = hstack(a, b);
    expect(c.width).toBe(4);
    expect(c.rows.length).toBe(1);
    expect(rowText(c.rows[0]!)).toBe("aabb");
    assertWidthInvariant(c);
  });
  it("bottom-pads shorter frames with blank rows", () => {
    const tall = text("a\nb\nc", { width: 1 });
    const short = text("X", { width: 1 });
    const c = hstack(tall, short);
    expect(c.rows.length).toBe(3);
    expect(rowText(c.rows[0]!)).toBe("aX");
    expect(rowText(c.rows[1]!)).toBe("b ");
    expect(rowText(c.rows[2]!)).toBe("c ");
    assertWidthInvariant(c);
  });
});

describe("pad", () => {
  it("adds blank rows top + bottom", () => {
    const f = pad(text("x", { width: 1 }), 2, 0, 1, 0);
    expect(f.rows.length).toBe(4);
    expect(f.width).toBe(1);
    expect(rowText(f.rows[0]!)).toBe(" ");
    expect(rowText(f.rows[2]!)).toBe("x");
    expect(rowText(f.rows[3]!)).toBe(" ");
    assertWidthInvariant(f);
  });
  it("adds blank cells left + right", () => {
    const f = pad(text("x", { width: 1 }), 0, 2, 0, 3);
    expect(f.rows.length).toBe(1);
    expect(f.width).toBe(6);
    expect(rowText(f.rows[0]!)).toBe("   x  ");
    assertWidthInvariant(f);
  });
});

describe("borderLeft", () => {
  it("prepends one cell with the bar char per row", () => {
    const f = borderLeft(text("hello\nworld", { width: 5 }), "#ff0000");
    expect(f.width).toBe(6);
    expect(f.rows.length).toBe(2);
    expect(f.rows[0]![0]!.char).toBe("│");
    expect(f.rows[0]![0]!.fg).toBe("#ff0000");
    expect(rowText(f.rows[0]!)).toBe("│hello");
    assertWidthInvariant(f);
  });
});

describe("slice", () => {
  it("picks consecutive rows", () => {
    const f = vstack(text("a", { width: 1 }), text("b", { width: 1 }), text("c", { width: 1 }));
    expect(rowText(slice(f, 0, 2).rows[0]!)).toBe("a");
    expect(rowText(slice(f, 1, 1).rows[0]!)).toBe("b");
  });
  it("clamps out-of-range bounds", () => {
    const f = vstack(text("a", { width: 1 }), text("b", { width: 1 }));
    expect(slice(f, -10, 100).rows.length).toBe(2);
    expect(slice(f, 5, 10).rows.length).toBe(0);
  });
  it("preserves width even on empty result", () => {
    const f = vstack(text("a", { width: 5 }));
    expect(slice(f, 10, 5).width).toBe(5);
  });
});

describe("bottom + viewport", () => {
  const stack = vstack(...Array.from({ length: 10 }, (_, i) => text(`row${i}`, { width: 5 })));
  it("bottom takes most-recent N rows", () => {
    const v = bottom(stack, 3);
    expect(v.rows.length).toBe(3);
    expect(rowText(v.rows[0]!)).toBe("row7 ");
    expect(rowText(v.rows[2]!)).toBe("row9 ");
  });
  it("viewport with offset=0 equals bottom", () => {
    const v = viewport(stack, 0, 3);
    expect(rowText(v.rows[0]!)).toBe("row7 ");
    expect(rowText(v.rows[2]!)).toBe("row9 ");
  });
  it("viewport with offset>0 reveals older rows", () => {
    const v = viewport(stack, 2, 3);
    expect(rowText(v.rows[0]!)).toBe("row5 ");
    expect(rowText(v.rows[2]!)).toBe("row7 ");
  });
  it("viewport caps offset so top row stays visible", () => {
    // Total = 10 rows, viewport = 3, max offset = 7.
    const v = viewport(stack, 999, 3);
    expect(rowText(v.rows[0]!)).toBe("row0 ");
  });
  it("viewport never returns more rows than requested", () => {
    expect(viewport(stack, 0, 100).rows.length).toBeLessThanOrEqual(10);
  });
});

describe("overlay", () => {
  it("paints a small frame onto a larger base", () => {
    const base = blank(10, 5);
    const top = text("X", { width: 1 });
    const result = overlay(base, top, 3, 1);
    expect(result.width).toBe(10);
    expect(result.rows.length).toBe(5);
    expect(rowText(result.rows[1]!)).toBe("   X      ");
    expect(rowText(result.rows[0]!)).toBe("          "); // unchanged
    assertWidthInvariant(result);
  });
  it("clips overlays that extend past base bounds", () => {
    const base = blank(5, 3);
    const top = text("HELLOO", { width: 6 }); // wider than base
    const result = overlay(base, top, 2, 0);
    expect(rowText(result.rows[0]!)).toBe("  HEL");
    assertWidthInvariant(result);
  });
});

describe("fitWidth", () => {
  it("right-pads narrower rows", () => {
    const f = text("hi", { width: 2 });
    const fit = fitWidth(f, 6);
    expect(fit.width).toBe(6);
    expect(rowText(fit.rows[0]!)).toBe("hi    ");
    assertWidthInvariant(fit);
  });
  it("truncates wider rows", () => {
    const f = text("hello world", { width: 11 });
    const fit = fitWidth(f, 5);
    expect(fit.width).toBe(5);
    expect(rowText(fit.rows[0]!)).toBe("hello");
    assertWidthInvariant(fit);
  });
  it("replaces split 2-wide chars with spaces at the cut", () => {
    const f = text("a你b", { width: 4 }); // a=1, 你=2, b=1 → 4 cells
    const fit = fitWidth(f, 2);
    expect(fit.width).toBe(2);
    // cut lands on 你's tail — head replaced with space
    expect(rowText(fit.rows[0]!)).toBe("a ");
    assertWidthInvariant(fit);
  });
});

describe("frameToAnsi", () => {
  it("plain mode strips all styling", () => {
    const f = text("hi", { width: 5, fg: "#ff0000", bold: true });
    expect(frameToAnsi(f, { plain: true })).toBe("hi   ");
  });
  it("emits style runs and resets", () => {
    const f = text("hi", { width: 2, fg: "#ff0000" });
    const s = frameToAnsi(f);
    expect(s).toContain("\u001b[");
    expect(s).toContain("hi");
    expect(s).toContain("\u001b[0m");
  });
  it("joins multiple rows with newlines", () => {
    const f = vstack(text("a", { width: 3 }), text("b", { width: 3 }));
    expect(frameToAnsi(f, { plain: true })).toBe("a  \nb  ");
  });
  it("emits OSC-8 hyperlinks around linked cells", () => {
    const f = text("link", { width: 4, href: "https://example.com" });
    const s = frameToAnsi(f);
    expect(s).toContain("\u001b]8;;https://example.com\u001b\\");
    expect(s).toContain("\u001b]8;;\u001b\\");
  });
  it("groups consecutive same-style cells into one SGR run", () => {
    const f = text("hello", { width: 5, fg: "#00ff00" });
    const s = frameToAnsi(f);
    // We should see ONE color escape, not five — a poor implementation
    // would emit 5×SGR for the 5 letters. Count by leading
    // ESC[<digits>;38;2;0;255;0m occurrences.
    const matches = s.match(/38;2;0;255;0/g);
    expect(matches?.length).toBe(1);
  });
});

describe("invariants under composition (smoke)", () => {
  it("vstack of mixed widths preserves width invariant", () => {
    const a = text("hi 你", { width: 4 });
    const b = text("ab", { width: 2 });
    const c = text("emoji 😀!", { width: 9 });
    assertWidthInvariant(vstack(a, b, c));
  });
  it("hstack of mixed heights preserves width invariant", () => {
    const a = text("a\nb\nc", { width: 1 });
    const b = text("X", { width: 1 });
    assertWidthInvariant(hstack(a, b));
  });
  it("borderLeft + pad + slice composes cleanly", () => {
    const inner = text("body line\nsecond", { width: 12 });
    const accent = borderLeft(inner, "#67e8f9");
    const padded = pad(accent, 1, 1, 1, 1);
    const sliced = slice(padded, 0, 3);
    assertWidthInvariant(sliced);
  });
});
