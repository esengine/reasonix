import { describe, expect, it } from "vitest";
import { stripMath } from "../src/cli/ui/markdown.js";

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
