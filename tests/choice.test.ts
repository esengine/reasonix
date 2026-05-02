/** ask_choice — schema, sanitization, ChoiceRequestedError → tool_result protocol. */

import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { ChoiceRequestedError, registerChoiceTool } from "../src/tools/choice.js";

describe("ChoiceRequestedError", () => {
  it("carries the question / options / allowCustom on the instance and in toToolResult()", () => {
    const err = new ChoiceRequestedError(
      "Which framework?",
      [
        { id: "A", title: "Vitest" },
        { id: "B", title: "Jest", summary: "familiar to most" },
      ],
      true,
    );
    expect(err.name).toBe("ChoiceRequestedError");
    expect(err.question).toBe("Which framework?");
    expect(err.options).toHaveLength(2);
    expect(err.allowCustom).toBe(true);
    const payload = err.toToolResult();
    expect(payload.question).toBe("Which framework?");
    expect(payload.options).toEqual([
      { id: "A", title: "Vitest" },
      { id: "B", title: "Jest", summary: "familiar to most" },
    ]);
    expect(payload.allowCustom).toBe(true);
    expect(payload.error).toMatch(/^ChoiceRequestedError:/);
    // STOP instruction — same pattern as PlanProposedError so flash
    // doesn't race past the picker with more tool calls.
    expect(payload.error).toMatch(/STOP/);
  });
});

describe("registerChoiceTool + ask_choice", () => {
  it("registers ask_choice as readOnly (safe during plan mode too)", () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    expect(reg.has("ask_choice")).toBe(true);
    expect(reg.get("ask_choice")?.readOnly).toBe(true);
  });

  it("throws ChoiceRequestedError and surfaces the full payload via toToolResult", async () => {
    const reg = new ToolRegistry();
    const seen: Array<{ question: string; options: unknown }> = [];
    registerChoiceTool(reg, {
      onChoiceRequested: (q, o) => seen.push({ question: q, options: o }),
    });
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Pick a route.",
        options: [
          { id: "A", title: "Deepen demo" },
          { id: "B", title: "Start UE5", summary: "fresh engine" },
        ],
        allowCustom: true,
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.question).toBe("Pick a route.");
    expect(parsed.options).toEqual([
      { id: "A", title: "Deepen demo" },
      { id: "B", title: "Start UE5", summary: "fresh engine" },
    ]);
    expect(parsed.allowCustom).toBe(true);
    expect(parsed.error).toMatch(/^ChoiceRequestedError:/);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.question).toBe("Pick a route.");
  });

  it("defaults allowCustom to false when not provided", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Which one?",
        options: [
          { id: "A", title: "one" },
          { id: "B", title: "two" },
        ],
      }),
    );
    expect(JSON.parse(out).allowCustom).toBe(false);
  });

  it("drops malformed option entries (DeepSeek sometimes misses fields)", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Pick.",
        options: [
          { id: "A", title: "good" },
          { id: "", title: "no id" },
          { id: "B", title: "" },
          "not-an-object",
          null,
          { id: "C", title: "also good" },
        ],
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.options).toEqual([
      { id: "A", title: "good" },
      { id: "C", title: "also good" },
    ]);
  });

  it("deduplicates options with the same id (first one wins)", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Pick.",
        options: [
          { id: "A", title: "first" },
          { id: "A", title: "dup" },
          { id: "B", title: "second" },
        ],
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.options).toEqual([
      { id: "A", title: "first" },
      { id: "B", title: "second" },
    ]);
  });

  it("rejects an empty question", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "  ",
        options: [
          { id: "A", title: "one" },
          { id: "B", title: "two" },
        ],
      }),
    );
    expect(JSON.parse(out).error).toMatch(/question is required/);
  });

  it("rejects when fewer than 2 well-formed options remain", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Pick.",
        options: [{ id: "A", title: "only one" }],
      }),
    );
    expect(JSON.parse(out).error).toMatch(/at least 2 well-formed options/);
  });

  it("rejects runaway option lists (>6 entries)", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    const options = Array.from({ length: 7 }, (_, i) => ({
      id: `opt-${i}`,
      title: `option ${i}`,
    }));
    const out = await reg.dispatch("ask_choice", JSON.stringify({ question: "too many", options }));
    expect(JSON.parse(out).error).toMatch(/too many options/);
  });

  it("keeps the tool passable in plan mode (branching questions can fire mid-plan)", async () => {
    const reg = new ToolRegistry();
    registerChoiceTool(reg);
    reg.setPlanMode(true);
    const out = await reg.dispatch(
      "ask_choice",
      JSON.stringify({
        question: "Which branch?",
        options: [
          { id: "A", title: "a" },
          { id: "B", title: "b" },
        ],
      }),
    );
    const parsed = JSON.parse(out);
    // Plan mode doesn't block ask_choice — it's readOnly.
    expect(parsed.error).toMatch(/^ChoiceRequestedError:/);
    expect(parsed.options).toHaveLength(2);
  });
});
