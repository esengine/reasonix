import { describe, expect, it } from "vitest";
import { markdownToFrame } from "../src/cli/ui/markdown-frame.js";
import { rowText } from "../src/frame/index.js";

const W = 80;

describe("markdownToFrame", () => {
  it("renders empty string as empty frame", () => {
    const f = markdownToFrame("", W);
    expect(f.rows.length).toBe(0);
  });

  it("renders a plain paragraph", () => {
    const f = markdownToFrame("hello world", W);
    expect(f.rows.length).toBeGreaterThan(0);
    expect(rowText(f.rows[0]!)).toContain("hello world");
  });

  it("preserves bold styling on inline markup", () => {
    const f = markdownToFrame("this is **bold** text", W);
    // Find a cell with bold=true that's part of the bold segment
    const allCells = f.rows.flatMap((r) => [...r]);
    const boldCells = allCells.filter((c) => c.bold && c.char !== " ");
    expect(boldCells.length).toBeGreaterThan(0);
    // The 'b' from 'bold' should be present and bold
    const boldChars = boldCells.map((c) => c.char).join("");
    expect(boldChars).toContain("b");
  });

  it("renders inline code with bg styling", () => {
    const f = markdownToFrame("see `console.log` for output", W);
    const codeCells = f.rows.flatMap((r) => [...r]).filter((c) => c.bg === "#0f172a");
    expect(codeCells.length).toBeGreaterThan(0);
  });

  it("renders headings in bold", () => {
    const f = markdownToFrame("# My Heading", W);
    const headingCells = f.rows[0]!.filter((c) => c.bold);
    expect(headingCells.length).toBeGreaterThan(0);
  });

  it("renders bullet lists with bullet glyphs", () => {
    const f = markdownToFrame("- first\n- second\n- third", W);
    expect(f.rows.length).toBeGreaterThanOrEqual(3);
    const allText = f.rows.map(rowText).join("\n");
    expect(allText).toContain("•");
    expect(allText).toContain("first");
    expect(allText).toContain("second");
    expect(allText).toContain("third");
  });

  it("renders task lists with [x] / [ ]", () => {
    const f = markdownToFrame("- [x] done\n- [ ] todo", W);
    const allText = f.rows.map(rowText).join("\n");
    expect(allText).toContain("[x]");
    expect(allText).toContain("[ ]");
  });

  it("renders numbered lists with N. prefix", () => {
    const f = markdownToFrame("1. first\n2. second", W);
    const allText = f.rows.map(rowText).join("\n");
    expect(allText).toContain("1.");
    expect(allText).toContain("2.");
  });

  it("renders fenced code blocks with bg tint per line", () => {
    const f = markdownToFrame("```js\nconst x = 1;\n```", W);
    // Code block lines should have the cyan-on-dark bg
    const tintedRow = f.rows.find((r) => r.some((c) => c.bg === "#0f172a" && c.char !== "`"));
    expect(tintedRow).toBeDefined();
  });

  it("renders blockquotes with left border", () => {
    const f = markdownToFrame("> a quote", W);
    // First cell of the quote row should be the border bar
    expect(f.rows[0]![0]!.char).toBe("│");
  });

  it("renders horizontal rule as a row of ─", () => {
    const f = markdownToFrame("---", W);
    expect(f.rows.length).toBe(1);
    const allDash = f.rows[0]!.every((c) => c.char === "─" || c.char === " ");
    expect(allDash).toBe(true);
  });

  it("wraps long paragraphs", () => {
    const f = markdownToFrame("word ".repeat(100), W);
    expect(f.rows.length).toBeGreaterThan(2);
    for (const r of f.rows) {
      let visual = 0;
      for (const c of r) if (!c.tail) visual += c.width;
      expect(visual).toBe(W);
    }
  });

  it("preserves the row-width invariant after composition", () => {
    const md =
      "# Heading\n\nsome **bold** text and `code`.\n\n- one\n- two\n\n```\nnope\n```\n\n> quote";
    const f = markdownToFrame(md, W);
    for (const r of f.rows) {
      let visual = 0;
      for (const c of r) if (!c.tail) visual += c.width;
      expect(visual).toBe(W);
    }
  });

  it("renders link with underline + accent color", () => {
    const f = markdownToFrame("see [here](https://example.com)", W);
    const linkCells = f.rows.flatMap((r) => [...r]).filter((c) => c.underline);
    expect(linkCells.length).toBeGreaterThan(0);
    expect(linkCells[0]!.href).toBe("https://example.com");
  });

  it("renders strike-through in dim", () => {
    const f = markdownToFrame("~~not anymore~~", W);
    const dimCells = f.rows.flatMap((r) => [...r]).filter((c) => c.dim && c.char !== " ");
    expect(dimCells.length).toBeGreaterThan(0);
  });

  // --- Tests for https://github.com/esengine/reasonix/issues/??? ---
  // Bug: segmentsToFrame strips the trailing content space from each segment
  // because it can't distinguish unstyled content spaces from padding spaces.
  // These tests assert that spaces before/after inline markup are PRESERVED;
  // they currently FAIL because the stripping is too aggressive.

  it("preserves spaces before inline code spans", () => {
    const f = markdownToFrame("use `foo()` for output", W);
    const text = f.rows.map(rowText).join("\n");
    expect(text).toContain("use foo()");
  });

  it("preserves spaces before bold spans", () => {
    const f = markdownToFrame("this is **bold** text", W);
    const text = f.rows.map(rowText).join("\n");
    expect(text).toContain("is bold");
  });

  it("preserves spaces before italic spans", () => {
    const f = markdownToFrame("this is *italic* text", W);
    const text = f.rows.map(rowText).join("\n");
    expect(text).toContain("is italic");
  });

  it("preserves spaces before link spans", () => {
    const f = markdownToFrame("see [here](https://example.com) for details", W);
    const text = f.rows.map(rowText).join("\n");
    expect(text).toContain("see here");
  });

  it("preserves spaces around inline code in a realistic sentence", () => {
    const f = markdownToFrame("Set it via `DEEPSEEK_API_KEY` env var.", W);
    const text = f.rows.map(rowText).join("\n");
    expect(text).toContain("via DEEPSEEK_API_KEY");
  });
});
