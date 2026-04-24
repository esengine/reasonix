import { describe, expect, it } from "vitest";
import { formatAllBlockDiffs, formatEditBlockDiff } from "../src/code/diff-preview.js";
import type { EditBlock } from "../src/code/edit-blocks.js";

function block(path: string, search: string, replace: string): EditBlock {
  return { path, search, replace, offset: 0 };
}

describe("formatEditBlockDiff", () => {
  it("shows `+` lines only for a new-file edit (empty search)", () => {
    const b = block("src/new.ts", "", "export const x = 1;\nexport const y = 2;");
    const out = formatEditBlockDiff(b);
    expect(out.every((l) => /^\s+\+/.test(l))).toBe(true);
    expect(out.join("\n")).toContain("+ export const x = 1;");
    expect(out.join("\n")).toContain("+ export const y = 2;");
  });

  it("collapses shared leading + trailing lines into context", () => {
    const b = block(
      "src/foo.ts",
      "function foo() {\n  const x = 1;\n  return x;\n}",
      "function foo() {\n  const x = 2;\n  return x;\n}",
    );
    const out = formatEditBlockDiff(b);
    const joined = out.join("\n");
    // Context lines (prefixed with two spaces) for unchanged parts.
    expect(joined).toContain("  function foo() {");
    expect(joined).toContain("  return x;");
    expect(joined).toContain("  }");
    // The diverging middle shows as `-`/`+`.
    expect(joined).toContain("-   const x = 1;");
    expect(joined).toContain("+   const x = 2;");
  });

  it("truncates diff to maxLines with a footer note", () => {
    // 30 different lines — no shared prefix/suffix so they all show.
    const search = Array.from({ length: 30 }, (_, i) => `old ${i}`).join("\n");
    const replace = Array.from({ length: 30 }, (_, i) => `new ${i}`).join("\n");
    const b = block("src/big.ts", search, replace);
    const out = formatEditBlockDiff(b, { maxLines: 10 });
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out[out.length - 1]).toMatch(/more diff lines/);
  });

  it("notes hidden leading context lines when prefix > contextLines", () => {
    const pre = Array.from({ length: 10 }, (_, i) => `pre ${i}`).join("\n");
    const b = block("src/a.ts", `${pre}\nOLD`, `${pre}\nNEW`);
    const out = formatEditBlockDiff(b, { contextLines: 2 });
    const joined = out.join("\n");
    // Leading context should be collapsed — we keep 2 visible and
    // note the rest as hidden.
    expect(joined).toMatch(/8 unchanged lines? above/);
  });

  it("notes hidden trailing context lines when suffix > contextLines", () => {
    const post = Array.from({ length: 10 }, (_, i) => `post ${i}`).join("\n");
    const b = block("src/a.ts", `OLD\n${post}`, `NEW\n${post}`);
    const out = formatEditBlockDiff(b, { contextLines: 2 });
    const joined = out.join("\n");
    expect(joined).toMatch(/8 unchanged lines? below/);
  });

  it("handles single-line edits cleanly", () => {
    const b = block("one.ts", "old", "new");
    const out = formatEditBlockDiff(b);
    expect(out).toContain("        - old");
    expect(out).toContain("        + new");
  });

  it("respects custom indent", () => {
    const b = block("x.ts", "a", "b");
    const out = formatEditBlockDiff(b, { indent: ">> " });
    expect(out.some((l) => l.startsWith(">> - a"))).toBe(true);
    expect(out.some((l) => l.startsWith(">> + b"))).toBe(true);
  });
});

describe("formatAllBlockDiffs", () => {
  it("emits a path+count header before each block's diff", () => {
    const blocks = [block("a.ts", "x", "y"), block("b.ts", "", "new content")];
    const out = formatAllBlockDiffs(blocks);
    const joined = out.join("\n");
    expect(joined).toMatch(/ {4}a\.ts {2}\(-1 \+1 lines\)/);
    expect(joined).toMatch(/NEW b\.ts {2}\(-0 \+1 lines\)/);
  });

  it("separates blocks with a blank line", () => {
    const blocks = [block("a.ts", "x", "y"), block("b.ts", "p", "q")];
    const out = formatAllBlockDiffs(blocks);
    // Blank line between first block's diff and second block's header.
    const blankIdx = out.indexOf("");
    expect(blankIdx).toBeGreaterThan(0);
  });

  it("returns an empty array for zero blocks", () => {
    expect(formatAllBlockDiffs([])).toEqual([]);
  });
});
