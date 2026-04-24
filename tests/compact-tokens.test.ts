import { describe, expect, it } from "vitest";
import { shrinkOversizedToolResultsByTokens } from "../src/loop.js";
import { countTokens } from "../src/tokenizer.js";
import type { ChatMessage } from "../src/types.js";

describe("shrinkOversizedToolResultsByTokens", () => {
  it("leaves small tool messages alone", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "t1", content: "short" },
    ];
    const r = shrinkOversizedToolResultsByTokens(msgs, 1000);
    expect(r.healedCount).toBe(0);
    expect(r.tokensSaved).toBe(0);
    expect(r.messages).toEqual(msgs);
  });

  it("shrinks tool messages that exceed the token budget", () => {
    const huge = "some event detail line with words\n".repeat(1000);
    const msgs: ChatMessage[] = [
      { role: "user", content: "do stuff" },
      { role: "tool", tool_call_id: "t1", content: huge },
    ];
    const r = shrinkOversizedToolResultsByTokens(msgs, 500);
    expect(r.healedCount).toBe(1);
    expect(r.tokensSaved).toBeGreaterThan(0);
    expect(r.charsSaved).toBeGreaterThan(0);
    const toolMsg = r.messages.find((m) => m.role === "tool");
    const shrunk = typeof toolMsg?.content === "string" ? toolMsg.content : "";
    // Final token count stays reasonably near the cap (plus marker
    // overhead from truncateForModelByTokens).
    expect(countTokens(shrunk)).toBeLessThanOrEqual(600);
  });

  it("never mutates the input array", () => {
    const big = "line of text with content\n".repeat(800);
    const msgs: ChatMessage[] = [{ role: "tool", tool_call_id: "t1", content: big }];
    const original = msgs[0]!.content;
    shrinkOversizedToolResultsByTokens(msgs, 200);
    expect(msgs[0]!.content).toBe(original);
  });

  it("does not touch user or assistant messages even when long", () => {
    const bigUser = "user-intent prose ".repeat(2000);
    const msgs: ChatMessage[] = [
      { role: "user", content: bigUser },
      { role: "assistant", content: "ok" },
    ];
    const r = shrinkOversizedToolResultsByTokens(msgs, 100);
    expect(r.healedCount).toBe(0);
    expect(r.messages[0]!.content).toBe(bigUser);
  });

  it("caps CJK tool results at the same token budget as English", () => {
    // Under the old char cap, CJK text slipped through at ~2× the
    // intended token cost. With a token cap, both must converge.
    const cjk = "错误：步骤执行失败需要复查\n".repeat(1000);
    const msgs: ChatMessage[] = [{ role: "tool", tool_call_id: "t1", content: cjk }];
    const r = shrinkOversizedToolResultsByTokens(msgs, 500);
    expect(r.healedCount).toBe(1);
    const shrunk = typeof r.messages[0]!.content === "string" ? r.messages[0]!.content : "";
    expect(countTokens(shrunk)).toBeLessThanOrEqual(600);
  });

  it("fast-pathes tool messages whose content length is already below the budget", () => {
    // Every token is ≥1 char, so length <= maxTokens implies tokens
    // <= maxTokens — no tokenize call needed, message untouched.
    const content = "x".repeat(50);
    const msgs: ChatMessage[] = [{ role: "tool", tool_call_id: "t1", content }];
    const r = shrinkOversizedToolResultsByTokens(msgs, 100);
    expect(r.healedCount).toBe(0);
    expect(r.messages[0]!.content).toBe(content);
  });
});
