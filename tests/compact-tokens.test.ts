import { describe, expect, it } from "vitest";
import {
  shrinkOversizedToolCallArgsByTokens,
  shrinkOversizedToolResultsByTokens,
} from "../src/loop.js";
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

describe("shrinkOversizedToolCallArgsByTokens", () => {
  it("leaves small tool-call args alone", () => {
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"src/foo.ts"}' },
          },
        ],
      },
    ];
    const r = shrinkOversizedToolCallArgsByTokens(msgs, 1000);
    expect(r.healedCount).toBe(0);
    expect(r.messages).toEqual(msgs);
  });

  it("shrinks long edit_file search/replace payloads into markers", () => {
    const longSearch = "old code line\n".repeat(200);
    const longReplace = "new code line\n".repeat(300);
    const argsJson = JSON.stringify({
      path: "src/foo.ts",
      search: longSearch,
      replace: longReplace,
    });
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "edit_file", arguments: argsJson } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "applied" },
    ];
    const r = shrinkOversizedToolCallArgsByTokens(msgs, 500);
    expect(r.healedCount).toBe(1);
    expect(r.tokensSaved).toBeGreaterThan(0);
    expect(r.charsSaved).toBeGreaterThan(0);
    const a = r.messages[0];
    if (a?.role !== "assistant" || !a.tool_calls) throw new Error("assistant missing");
    const shrunkArgs = a.tool_calls[0]!.function.arguments;
    const parsed = JSON.parse(shrunkArgs) as { path: string; search: string; replace: string };
    expect(parsed.path).toBe("src/foo.ts");
    expect(parsed.search).toMatch(/shrunk/);
    expect(parsed.replace).toMatch(/shrunk/);
  });

  it("leaves tool results intact (only targets assistant.tool_calls args)", () => {
    const hugeResult = "log line ".repeat(2000);
    const msgs: ChatMessage[] = [
      { role: "tool", tool_call_id: "c1", content: hugeResult },
    ];
    const r = shrinkOversizedToolCallArgsByTokens(msgs, 100);
    expect(r.healedCount).toBe(0);
    expect(r.messages[0]!.content).toBe(hugeResult);
  });

  it("preserves short string fields next to long ones", () => {
    const longBody = "x".repeat(4000);
    const argsJson = JSON.stringify({
      path: "src/foo.ts",
      content: longBody,
      mode: "append",
    });
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "write_file", arguments: argsJson } },
        ],
      },
    ];
    const r = shrinkOversizedToolCallArgsByTokens(msgs, 500);
    expect(r.healedCount).toBe(1);
    const a = r.messages[0];
    if (a?.role !== "assistant" || !a.tool_calls) throw new Error("assistant missing");
    const parsed = JSON.parse(a.tool_calls[0]!.function.arguments) as Record<string, unknown>;
    expect(parsed.path).toBe("src/foo.ts");
    expect(parsed.mode).toBe("append");
    expect(String(parsed.content)).toMatch(/shrunk/);
  });

  it("never mutates the input array or its tool_calls", () => {
    const bigArgs = JSON.stringify({ path: "a", search: "x".repeat(4000) });
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "edit_file", arguments: bigArgs } },
        ],
      },
    ];
    const originalArgs = (msgs[0] as any).tool_calls[0].function.arguments;
    shrinkOversizedToolCallArgsByTokens(msgs, 100);
    expect((msgs[0] as any).tool_calls[0].function.arguments).toBe(originalArgs);
  });
});
