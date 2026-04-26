import { describe, expect, it } from "vitest";
import {
  formatPendingPreview,
  parseEditIndices,
  partitionEdits,
} from "../src/cli/ui/edit-history.js";
import type { EditBlock } from "../src/code/edit-blocks.js";

function block(path: string, search: string, replace: string): EditBlock {
  return { path, search, replace, offset: 0 };
}

describe("parseEditIndices", () => {
  it("returns empty list for empty / whitespace input", () => {
    expect(parseEditIndices("", 5)).toEqual({ ok: [] });
    expect(parseEditIndices("   ", 5)).toEqual({ ok: [] });
  });

  it("parses a single value", () => {
    expect(parseEditIndices("3", 5)).toEqual({ ok: [3] });
  });

  it("parses a comma list", () => {
    expect(parseEditIndices("1,3,5", 5)).toEqual({ ok: [1, 3, 5] });
  });

  it("parses a range expression", () => {
    expect(parseEditIndices("2-4", 5)).toEqual({ ok: [2, 3, 4] });
  });

  it("flips reversed ranges into ascending order", () => {
    expect(parseEditIndices("4-2", 5)).toEqual({ ok: [2, 3, 4] });
  });

  it("merges mixed singles + ranges, deduplicating overlaps", () => {
    expect(parseEditIndices("1,3-5,4,7", 8)).toEqual({ ok: [1, 3, 4, 5, 7] });
  });

  it("tolerates surrounding whitespace and stray commas", () => {
    expect(parseEditIndices(" 1, 3 , 5 ", 5)).toEqual({ ok: [1, 3, 5] });
    expect(parseEditIndices(",1,,3,", 5)).toEqual({ ok: [1, 3] });
  });

  it("rejects out-of-range singletons", () => {
    expect(parseEditIndices("9", 5)).toEqual({ error: "index 9 out of range (max 5)" });
  });

  it("rejects out-of-range ranges", () => {
    expect(parseEditIndices("3-9", 5)).toEqual({ error: "index 9 out of range (max 5)" });
  });

  it("rejects 0 and negatives", () => {
    expect(parseEditIndices("0", 5)).toEqual({ error: 'invalid index: "0"' });
    expect(parseEditIndices("-1", 5)).toEqual({ error: 'invalid index: "-1"' });
  });

  it("rejects non-numeric tokens", () => {
    expect(parseEditIndices("foo", 5)).toEqual({ error: 'invalid index: "foo"' });
    expect(parseEditIndices("1,foo,3", 5)).toEqual({ error: 'invalid index: "foo"' });
  });

  it("rejects malformed ranges", () => {
    expect(parseEditIndices("1-", 5)).toEqual({ error: 'invalid index: "1-"' });
    expect(parseEditIndices("-3", 5)).toEqual({ error: 'invalid index: "-3"' });
  });

  it("rejects when nothing is pending (max=0)", () => {
    expect(parseEditIndices("1", 0)).toEqual({ error: "no pending edits to address" });
  });
});

describe("partitionEdits", () => {
  it("splits selected vs remaining preserving original order", () => {
    const blocks = [
      block("a.ts", "x", "y"),
      block("b.ts", "x", "y"),
      block("c.ts", "x", "y"),
      block("d.ts", "x", "y"),
    ];
    const { selected, remaining } = partitionEdits(blocks, [2, 4]);
    expect(selected.map((b) => b.path)).toEqual(["b.ts", "d.ts"]);
    expect(remaining.map((b) => b.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("empty indices means nothing selected", () => {
    const blocks = [block("a.ts", "x", "y"), block("b.ts", "x", "y")];
    const { selected, remaining } = partitionEdits(blocks, []);
    expect(selected).toEqual([]);
    expect(remaining).toEqual(blocks);
  });

  it("indices outside range are ignored (caller already validated bounds)", () => {
    const blocks = [block("a.ts", "x", "y")];
    const { selected, remaining } = partitionEdits(blocks, [99]);
    expect(selected).toEqual([]);
    expect(remaining).toEqual(blocks);
  });
});

describe("formatPendingPreview", () => {
  it("numbers blocks when there are 2+ pending edits", () => {
    const blocks = [block("a.ts", "x", "y"), block("b.ts", "x", "y")];
    const out = formatPendingPreview(blocks);
    expect(out).toContain("[1]");
    expect(out).toContain("[2]");
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
  });

  it("hints at partial-apply syntax in the header when there are 2+ blocks", () => {
    const blocks = [block("a.ts", "x", "y"), block("b.ts", "x", "y")];
    const out = formatPendingPreview(blocks);
    expect(out.split("\n", 1)[0]).toContain("/apply N");
  });

  it("does NOT number a single block (no partial choice to make)", () => {
    const blocks = [block("a.ts", "x", "y")];
    const out = formatPendingPreview(blocks);
    expect(out).not.toContain("[1]");
    expect(out).not.toContain("/apply N");
  });
});
