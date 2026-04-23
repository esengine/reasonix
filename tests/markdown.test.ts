import { describe, expect, it } from "vitest";
import { parseBlocks, stripInlineMarkup, stripMath, visibleWidth } from "../src/cli/ui/markdown.js";

describe("stripMath", () => {
  it("converts \\frac, \\dfrac, \\tfrac uniformly", () => {
    expect(stripMath("\\frac{a}{b}")).toBe("(a)/(b)");
    expect(stripMath("\\dfrac{a}{b}")).toBe("(a)/(b)");
    expect(stripMath("\\tfrac{a}{b}")).toBe("(a)/(b)");
  });

  it("converts a \\frac with Chinese content (the original user-reported case)", () => {
    const out = stripMath("v = \\frac{总路程}{总时间}");
    expect(out).toContain("(总路程)/(总时间)");
    expect(out).not.toContain("\\frac");
    expect(out).not.toContain("\\");
  });

  it("handles \\frac with a nested \\sqrt", () => {
    const out = stripMath("\\frac{\\sqrt{2}}{3}");
    expect(out).not.toContain("\\frac");
    expect(out).not.toContain("\\sqrt");
  });

  it("tolerates whitespace inside frac braces", () => {
    expect(stripMath("\\frac{ a }{ b }")).toContain("(a)/(b)");
  });

  it("strips \\implies, \\to arrows", () => {
    expect(stripMath("a \\implies b")).toContain("a ⇒ b");
    expect(stripMath("x \\to y")).toContain("x → y");
  });

  it("\\quad becomes spaces", () => {
    expect(stripMath("a\\quad b")).not.toContain("\\");
  });

  it("converts single-digit subscripts and superscripts to Unicode", () => {
    expect(stripMath("t_1 + t_2")).toBe("t₁ + t₂");
    expect(stripMath("x^2 + y^3")).toBe("x² + y³");
  });

  it("strips LaTeX math delimiters", () => {
    const out = stripMath("equation: \\(x^2 + 1\\)");
    expect(out).toBe("equation: x² + 1");
  });

  it("unknown commands are stripped too (catch-all fallback)", () => {
    const out = stripMath("\\weirdmacro{x}{y} + \\unknown{z} + \\alone");
    expect(out).not.toContain("\\");
  });

  it("\\boxed wraps in 【…】", () => {
    expect(stripMath("\\boxed{x = 5}")).toBe("【x = 5】");
  });

  it("\\sqrt becomes √(...)", () => {
    expect(stripMath("\\sqrt{49}")).toBe("√(49)");
  });

  it("the full user-reported line no longer leaks raw LaTeX", () => {
    const input =
      "总路程：2d km 总时间：t_1 + t_2 = \\dfrac{d}{30} + \\dfrac{d}{60} = \\dfrac{2d}{60} + \\dfrac{d}{60} = \\dfrac{3d}{60} = \\dfrac{d}{20} 小时 平均速度：v_{avg} = \\frac{总路程}{总时间} = 40 km/h";
    const out = stripMath(input);
    expect(out).not.toContain("\\");
    expect(out).toContain("(总路程)/(总时间)");
    expect(out).toContain("t₁");
    expect(out).toContain("(d)/(30)");
  });
});

describe("parseBlocks — SEARCH/REPLACE detection", () => {
  it("extracts a single SEARCH/REPLACE block into a first-class edit-block", () => {
    const text = [
      "Here is the fix:",
      "",
      "src/foo.ts",
      "<<<<<<< SEARCH",
      "const x = 1;",
      "=======",
      "const x = 2;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const blocks = parseBlocks(text);
    const edit = blocks.find((b) => b.kind === "edit-block");
    expect(edit).toBeDefined();
    if (edit?.kind !== "edit-block") throw new Error("unreachable");
    expect(edit.filename).toBe("src/foo.ts");
    expect(edit.search).toBe("const x = 1;");
    expect(edit.replace).toBe("const x = 2;");
  });

  it("preserves multi-line SEARCH and REPLACE verbatim (no markdown mangling)", () => {
    // The original user-reported shape: JSDoc comments inside SEARCH.
    // Before this fix, `/** ... */` got eaten by bold/italic regex and
    // `para.join(" ")` collapsed newlines.
    const text = [
      "src/code/edit-blocks.ts",
      "<<<<<<< SEARCH",
      "/** Edit landed on disk. */",
      "| 'applied'",
      "=======",
      "/** Edit landed on disk. */",
      "| 'applied-new'",
      ">>>>>>> REPLACE",
    ].join("\n");
    const [edit] = parseBlocks(text).filter((b) => b.kind === "edit-block");
    if (edit?.kind !== "edit-block") throw new Error("expected edit-block");
    // The `/** ... */` and `|` chars survive intact — no `*`-eating,
    // no newline-flattening.
    expect(edit.search).toContain("/** Edit landed on disk. */");
    expect(edit.search).toContain("\n");
    expect(edit.replace).toContain("'applied-new'");
  });

  it("recognizes new-file (empty SEARCH) blocks", () => {
    const text = [
      "src/new.ts",
      "<<<<<<< SEARCH",
      "=======",
      "export const x = 1;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const [edit] = parseBlocks(text).filter((b) => b.kind === "edit-block");
    if (edit?.kind !== "edit-block") throw new Error("expected edit-block");
    expect(edit.search).toBe("");
    expect(edit.replace).toBe("export const x = 1;");
  });

  it("ignores a stray <<<<<<< SEARCH without a filename or close marker", () => {
    const text = "just some prose with <<<<<<< SEARCH left over in the middle";
    const blocks = parseBlocks(text);
    expect(blocks.find((b) => b.kind === "edit-block")).toBeUndefined();
  });

  it("extracts multiple edit-blocks in one response, keeping the prose between them", () => {
    const text = [
      "First change:",
      "src/a.ts",
      "<<<<<<< SEARCH",
      "old_a",
      "=======",
      "new_a",
      ">>>>>>> REPLACE",
      "",
      "And second:",
      "src/b.ts",
      "<<<<<<< SEARCH",
      "old_b",
      "=======",
      "new_b",
      ">>>>>>> REPLACE",
    ].join("\n");
    const blocks = parseBlocks(text);
    const edits = blocks.filter((b) => b.kind === "edit-block");
    expect(edits).toHaveLength(2);
    const paragraphs = blocks.filter((b) => b.kind === "paragraph");
    expect(paragraphs.map((p) => (p.kind === "paragraph" ? p.text : ""))).toEqual(
      expect.arrayContaining(["First change:", "And second:"]),
    );
  });
});

describe("parseBlocks — GFM tables", () => {
  it("recognizes a simple table with header + separator + rows", () => {
    const md = [
      "Intro paragraph.",
      "",
      "| 声望点 | 加成效果 |",
      "|--------|----------|",
      "| 每2点 | +1 点击力 |",
      "| 每3点 | +10% CPS 乘数 |",
      "",
      "Trailing text.",
    ].join("\n");
    const blocks = parseBlocks(md);
    const table = blocks.find((b) => b.kind === "table");
    expect(table).toBeDefined();
    if (table && table.kind === "table") {
      expect(table.header).toEqual(["声望点", "加成效果"]);
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0]).toEqual(["每2点", "+1 点击力"]);
      expect(table.rows[1]).toEqual(["每3点", "+10% CPS 乘数"]);
    }
    // Surrounding paragraphs still parsed as separate blocks.
    expect(
      blocks.find((b) => b.kind === "paragraph" && b.text === "Intro paragraph."),
    ).toBeDefined();
    expect(blocks.find((b) => b.kind === "paragraph" && b.text === "Trailing text.")).toBeDefined();
  });

  it("accepts alignment colons in the separator without breaking", () => {
    const md = ["| col1 | col2 |", "|:-----|-----:|", "| a    | b    |"].join("\n");
    const [t] = parseBlocks(md).filter((b) => b.kind === "table");
    expect(t).toBeDefined();
    if (t && t.kind === "table") {
      expect(t.header).toEqual(["col1", "col2"]);
      expect(t.rows[0]).toEqual(["a", "b"]);
    }
  });

  it("accepts tables without leading/trailing pipes", () => {
    const md = ["col1 | col2", "-----|-----", "a    | b"].join("\n");
    const [t] = parseBlocks(md).filter((b) => b.kind === "table");
    expect(t).toBeDefined();
    if (t && t.kind === "table") {
      expect(t.header).toEqual(["col1", "col2"]);
      expect(t.rows[0]).toEqual(["a", "b"]);
    }
  });

  it("does NOT trigger on a bare '|' in prose when next line is not a separator", () => {
    const md = ["Use the pipe | operator to chain.", "Second paragraph."].join("\n");
    const blocks = parseBlocks(md);
    expect(blocks.find((b) => b.kind === "table")).toBeUndefined();
  });

  it("preserves escaped pipes inside cell content", () => {
    const md = ["| a | b |", "|---|---|", "| x \\| y | z |"].join("\n");
    const [t] = parseBlocks(md).filter((b) => b.kind === "table");
    expect(t).toBeDefined();
    if (t && t.kind === "table") {
      expect(t.rows[0]).toEqual(["x | y", "z"]);
    }
  });

  it("recognizes Unicode box-drawing tables (│ ─ ┼) as tables too", () => {
    // R1/V3 frequently emit this shape when asked for tabular data in
    // Chinese — the GFM-only path treated them as plain paragraphs and
    // Ink word-wrapped them into a tangle.
    const md = [
      "步骤             │ 说明",
      "─────────────────┼─────────────────────────────────────────",
      "**工具查找**     │ 按 `name` 查找已注册的工具",
      "**参数解析**     │ 支持 string (JSON) 或 object 格式",
      "",
      "Trailing prose.",
    ].join("\n");
    const blocks = parseBlocks(md);
    const table = blocks.find((b) => b.kind === "table");
    expect(table).toBeDefined();
    if (table && table.kind === "table") {
      expect(table.header).toEqual(["步骤", "说明"]);
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0]).toEqual(["**工具查找**", "按 `name` 查找已注册的工具"]);
      expect(table.rows[1]).toEqual(["**参数解析**", "支持 string (JSON) 或 object 格式"]);
    }
    expect(
      blocks.find((b) => b.kind === "paragraph" && b.text === "Trailing prose."),
    ).toBeDefined();
  });

  it("does NOT trigger on a bare '│' in prose without a separator below", () => {
    const md = ["The character │ is a vertical bar.", "Nothing tabular here."].join("\n");
    expect(parseBlocks(md).find((b) => b.kind === "table")).toBeUndefined();
  });

  it("folds a continuation row (no column separator) into the last cell of the previous row", () => {
    // Real-world LLM output: cell content too long, model wraps onto a
    // second line without re-emitting the separator. Used to leak as
    // a paragraph after the table; now stitched back into the cell so
    // inline backticks / bold parse correctly.
    const md = [
      "文件         │ 角色",
      "─────────────┼─────────────────────────────────────────",
      "`src/tools.ts` │ `dispatch()` 方法定义（约第 106 行起）。签名：",
      "                async dispatch(name: string, ...)。处理 plan-mode 拦截。",
    ].join("\n");
    const [t] = parseBlocks(md).filter((b) => b.kind === "table");
    expect(t).toBeDefined();
    if (t && t.kind === "table") {
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0]?.[1]).toContain("dispatch()");
      expect(t.rows[0]?.[1]).toContain("async dispatch(name");
    }
  });
});

describe("parseBlocks — box-drawing frames as code blocks", () => {
  it("recognizes a single-line ┌─┐ │ └─┘ frame", () => {
    // Models routinely wrap one line of code in a Unicode frame for
    // emphasis. The renderer treats the frame as a code block so the
    // inner content stays readable instead of being word-wrapped.
    const md = [
      "Here is the call site:",
      "",
      "┌──────────────────────────────────────────┐",
      "│ result = await this.tools.dispatch(...); │",
      "└──────────────────────────────────────────┘",
      "",
      "Trailing.",
    ].join("\n");
    const blocks = parseBlocks(md);
    const code = blocks.find((b) => b.kind === "code");
    expect(code).toBeDefined();
    if (code && code.kind === "code") {
      expect(code.text).toBe("result = await this.tools.dispatch(...);");
    }
    expect(blocks.find((b) => b.kind === "paragraph" && b.text === "Trailing.")).toBeDefined();
  });

  it("recognizes a multi-line ┌─┐ │…│ └─┘ frame (flow charts and diagrams)", () => {
    const md = [
      "┌──────────────┐",
      "│ step 1       │",
      "│  ↓           │",
      "│ step 2       │",
      "└──────────────┘",
    ].join("\n");
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code" });
    if (blocks[0]?.kind === "code") {
      expect(blocks[0].text).toContain("step 1");
      expect(blocks[0].text).toContain("step 2");
      expect(blocks[0].text).toContain("↓");
      // Outer │ characters got stripped — content reads cleanly.
      expect(blocks[0].text).not.toContain("│");
    }
  });

  it("falls back to paragraph when the closing └─┘ is missing", () => {
    const md = ["┌────┐", "│ a  │", "no closing edge here"].join("\n");
    const blocks = parseBlocks(md);
    // No code block emitted — the open-edge line stays as paragraph.
    expect(blocks.find((b) => b.kind === "code")).toBeUndefined();
  });
});

describe("stripInlineMarkup + visibleWidth", () => {
  it("strips bold markers", () => {
    expect(stripInlineMarkup("**hello**")).toBe("hello");
  });
  it("strips inline code backticks", () => {
    expect(stripInlineMarkup("call `dispatch()` now")).toBe("call dispatch() now");
  });
  it("strips italic markers but leaves single * inside words", () => {
    expect(stripInlineMarkup("*emphasis*")).toBe("emphasis");
    expect(stripInlineMarkup("a*b*c")).toBe("a*b*c");
  });
  it("strips triple-backtick spans + their language tag", () => {
    expect(stripInlineMarkup("```bash echo hi```")).toBe("echo hi");
  });
  it("visibleWidth excludes markup chars", () => {
    // raw is 19 chars, visible is "定义 dispatch" = 4 (CJK ×2) + 1 (space) + 8 = 13
    expect(visibleWidth("**定义** `dispatch`")).toBe(13);
  });
  it("table cells with inline markup get sized by visible width, not raw", () => {
    // Header is plain, rows have inline code. The column sized by raw
    // length would be too wide; visibleWidth keeps things aligned to
    // what the user actually sees.
    const md = ["| 位置 | 角色 |", "|------|------|", "| `src/tools.ts` | 定义 dispatch |"].join(
      "\n",
    );
    const [t] = parseBlocks(md).filter((b) => b.kind === "table");
    expect(t).toBeDefined();
    if (t && t.kind === "table") {
      expect(t.rows[0]).toEqual(["`src/tools.ts`", "定义 dispatch"]);
    }
  });
});

describe("parseBlocks — fenced code blocks", () => {
  it("recognizes a plain multi-line fence", () => {
    const blocks = parseBlocks("```bash\necho hi\necho bye\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "code", lang: "bash", text: "echo hi\necho bye" });
  });

  it("allows up to 3 leading spaces on the fence line (GFM)", () => {
    const blocks = parseBlocks("   ```bash\n   echo indented\n   ```");
    const code = blocks.find((b) => b.kind === "code");
    expect(code).toBeDefined();
    expect(code && code.kind === "code" && code.lang).toBe("bash");
  });

  it("handles a one-line fenced code block (model puts everything on one line)", () => {
    const blocks = parseBlocks("```bash svn commit -m hi```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "code", lang: "bash", text: "svn commit -m hi" });
  });

  it("handles a one-line fenced block surrounded by prose paragraphs", () => {
    const blocks = parseBlocks("Run this:\n\n```bash svn status```\n\nOr:\n\n```bash svn log```");
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
    expect(blocks[1]).toMatchObject({ kind: "code", text: "svn status" });
    expect(blocks[2]).toMatchObject({ kind: "paragraph" });
    expect(blocks[3]).toMatchObject({ kind: "code", text: "svn log" });
  });

  it("closing fence must be at least as long as the opening fence", () => {
    // Opened with 4 backticks so body can contain 3 without closing.
    const blocks = parseBlocks("````\nsome ``` code\n````");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "code", lang: "", text: "some ``` code" });
  });

  it("an unclosed fence still emits a code block at EOF", () => {
    const blocks = parseBlocks("```python\nprint('hi')");
    const code = blocks.find((b) => b.kind === "code");
    expect(code && code.kind === "code" && code.text).toBe("print('hi')");
  });
});
