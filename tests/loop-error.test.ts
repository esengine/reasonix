/** Loop error decorator — context-overflow gets a user hint; everything else passes through. */

import { describe, expect, it } from "vitest";
import { formatLoopError, healLoadedMessages, stripHallucinatedToolMarkup } from "../src/loop.js";
import type { ChatMessage } from "../src/types.js";

describe("formatLoopError", () => {
  it("annotates a DeepSeek 400 'maximum context length' error", () => {
    const raw = new Error(
      'DeepSeek 400: {"error":{"message":"This model\'s maximum context length is 131072 tokens. ' +
        "However, you requested 929452 tokens (929452 in the messages, 0 in the completion). " +
        'Please reduce the length of the messages or completion."}}',
    );
    const out = formatLoopError(raw);
    expect(out).toMatch(/Context overflow/);
    expect(out).toMatch(/\/forget/);
    expect(out).toMatch(/929,452 tokens/); // pretty-printed from the raw JSON
  });

  it("401 → authentication hint with setup/env var fix", () => {
    const raw = new Error(
      'DeepSeek 401: {"error":{"message":"Authentication Fails, Your api key is invalid"}}',
    );
    const out = formatLoopError(raw);
    expect(out).toMatch(/Authentication failed/);
    expect(out).toMatch(/reasonix setup/);
    expect(out).toMatch(/DEEPSEEK_API_KEY/);
    // Inner error.message survives the unwrap
    expect(out).toContain("Your api key is invalid");
  });

  it("402 → balance hint with top-up URL", () => {
    const raw = new Error('DeepSeek 402: {"error":{"message":"Insufficient Balance"}}');
    const out = formatLoopError(raw);
    expect(out).toMatch(/Out of balance/);
    expect(out).toMatch(/top_up/);
    expect(out).toContain("Insufficient Balance");
  });

  it("422 → invalid parameter with the server's reason", () => {
    const raw = new Error(
      'DeepSeek 422: {"error":{"message":"Invalid value for `temperature`: must be between 0 and 2"}}',
    );
    const out = formatLoopError(raw);
    expect(out).toMatch(/Invalid parameter/);
    expect(out).toContain("temperature");
  });

  it("400 (non-overflow) → extracts the inner error message, drops the JSON wrapping", () => {
    const raw = new Error(
      'DeepSeek 400: {"error":{"message":"request body malformed at messages[3].role"}}',
    );
    const out = formatLoopError(raw);
    expect(out).toMatch(/Bad request/);
    expect(out).toContain("messages[3].role");
    expect(out).not.toContain("{"); // JSON wrapping is gone
  });

  it("leaves non-DeepSeek-shaped errors untouched", () => {
    const raw = new Error("socket hang up");
    expect(formatLoopError(raw)).toBe("socket hang up");
  });

  it("tolerates an overflow error without a requested-tokens figure", () => {
    const raw = new Error("DeepSeek 400: This model's maximum context length is 131072 tokens.");
    const out = formatLoopError(raw);
    expect(out).toMatch(/Context overflow/);
    expect(out).toMatch(/too many tokens/);
  });

  it("context-overflow message mentions both the 1M V4 limit and the legacy 131k", () => {
    const raw = new Error(
      'DeepSeek 400: {"error":{"message":"This model\'s maximum context length is 131072 tokens. However, you requested 200000 tokens."}}',
    );
    const out = formatLoopError(raw);
    expect(out).toMatch(/1M/);
    expect(out).toMatch(/131k/);
  });

  it("tolerates an empty or malformed JSON body on the error payload", () => {
    const raw = new Error("DeepSeek 500: ");
    const out = formatLoopError(raw);
    // 500 isn't in the remapped set, so it passes through as-is
    expect(out).toBe("DeepSeek 500: ");
  });
});

describe("healLoadedMessages", () => {
  it("truncates a giant tool result, leaves user/assistant messages alone", () => {
    const big = "X".repeat(80_000);
    // Needs a proper assistant.tool_calls + matching tool response so
    // the 0.4.12+ validator doesn't prune the tool as stray.
    const messages: ChatMessage[] = [
      { role: "user", content: "read the big file" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "t1", content: big },
      { role: "assistant", content: "here's what I found" },
    ];
    const { messages: healed, healedCount, healedFrom } = healLoadedMessages(messages, 32_000);
    expect(healedCount).toBe(1);
    expect(healedFrom).toBe(80_000);
    expect(healed[0]).toEqual(messages[0]); // user untouched
    expect(healed[1]).toEqual(messages[1]); // assistant untouched
    expect(typeof healed[2]!.content).toBe("string");
    expect((healed[2]!.content as string).length).toBeLessThan(33_000);
    expect(healed[2]!.content).toContain("truncated");
    expect(healed[3]).toEqual(messages[3]); // trailing assistant untouched
  });

  it("is a no-op when every message fits AND pairing is valid", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hi back" },
    ];
    const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
    expect(healedCount).toBe(0);
    expect(healed).toEqual(messages);
  });

  it("heals multiple oversized tool messages in one pass (all properly paired)", () => {
    // Each oversized tool MUST be the response to a preceding
    // assistant.tool_calls, otherwise the 0.4.12 validator prunes it.
    const messages: ChatMessage[] = [
      { role: "user", content: "do three things" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "x", arguments: "{}" } },
          { id: "t2", type: "function", function: { name: "x", arguments: "{}" } },
          { id: "t3", type: "function", function: { name: "x", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "A".repeat(40_000) },
      { role: "tool", tool_call_id: "t2", content: "B".repeat(50_000) },
      { role: "tool", tool_call_id: "t3", content: "small" },
    ];
    const { healedCount, healedFrom } = healLoadedMessages(messages, 32_000);
    expect(healedCount).toBe(2);
    expect(healedFrom).toBe(90_000);
  });

  it("drops stray tool messages that have no preceding assistant.tool_calls", () => {
    // This is the shape that triggered the "tool must be a response
    // to a preceding tool_calls" 400 — a tool entry with no opener.
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "stray", content: "orphan result" },
      { role: "assistant", content: "sure" },
    ];
    const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
    expect(healedCount).toBe(1);
    expect(healed.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("drops an assistant.tool_calls whose response set is incomplete", () => {
    // tool_calls declares [a, b], but only tool[a] follows. The
    // validator can't deliver this to DeepSeek — drops the pair.
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", type: "function", function: { name: "x", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "x", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "partial" },
      { role: "assistant", content: "trailing note" },
    ];
    const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
    expect(healedCount).toBeGreaterThan(0);
    // Assistant.tool_calls and its partial tool response both dropped;
    // the trailing plain assistant note survives.
    expect(healed.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(healed[1]!.content).toBe("trailing note");
  });

  it("strips a dangling assistant-with-tool_calls tail (pre-0.4.12 session files)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "analyze" },
      { role: "assistant", content: "sure" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "t1", type: "function", function: { name: "probe", arguments: "{}" } }],
      },
      // NO tool response follows — this is the corrupted shape that
      // DeepSeek 400s on the next user message. Heal must drop it.
    ];
    const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
    expect(healedCount).toBe(1);
    expect(healed).toHaveLength(2);
    expect(healed[healed.length - 1]!.role).toBe("assistant");
    expect(healed[healed.length - 1]!.content).toBe("sure");
  });

  it("strips MULTIPLE trailing assistant-with-tool_calls entries (stacked corruption)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "a", type: "function", function: { name: "x", arguments: "{}" } }],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "b", type: "function", function: { name: "x", arguments: "{}" } }],
      },
    ];
    const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
    // Both dangling assistant entries trimmed; user message survives.
    expect(healedCount).toBe(2);
    expect(healed).toHaveLength(1);
    expect(healed[0]!.role).toBe("user");
  });

  it("keeps a PAIRED assistant.tool_calls + tool response intact", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "t1", content: "ok" },
    ];
    const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
    expect(healedCount).toBe(0);
    expect(healed).toEqual(messages);
  });
});

describe("stripHallucinatedToolMarkup", () => {
  it("removes a full DSML function_calls block (the R1 hallucination we saw live)", () => {
    const input = [
      "Let me look at the file structure.",
      "",
      '<｜DSML｜function_calls> <｜DSML｜invoke name="filesystem_edit_file">',
      '  <｜DSML｜parameter name="path" string="true">F:.html</｜DSML｜parameter>',
      '  <｜DSML｜parameter name="edits" string="false">[...]</｜DSML｜parameter>',
      "</｜DSML｜invoke> </｜DSML｜function_calls>",
      "",
      "Saved.",
    ].join("\n");
    const out = stripHallucinatedToolMarkup(input);
    expect(out).toContain("Let me look at the file structure.");
    expect(out).toContain("Saved.");
    expect(out).not.toContain("DSML");
    expect(out).not.toContain("filesystem_edit_file");
  });

  it("removes an Anthropic-style <function_calls> block", () => {
    const input = "Here is the plan.\n<function_calls>\n<tool>...</tool>\n</function_calls>\nDone.";
    const out = stripHallucinatedToolMarkup(input);
    expect(out).toContain("Here is the plan.");
    expect(out).toContain("Done.");
    expect(out).not.toContain("function_calls");
  });

  it("strips a truncated DSML opener that never gets closed", () => {
    const input = 'Before the junk.\n<｜DSML｜function_calls> <｜DSML｜invoke name="x"> ...';
    const out = stripHallucinatedToolMarkup(input);
    expect(out).toBe("Before the junk.");
  });

  it("leaves plain prose completely alone", () => {
    const input = "Just a normal summary with no markup anywhere.";
    expect(stripHallucinatedToolMarkup(input)).toBe(input);
  });

  it("returns empty string when ALL content was hallucinated markup", () => {
    const input = "<｜DSML｜function_calls>garbage</｜DSML｜function_calls>";
    expect(stripHallucinatedToolMarkup(input)).toBe("");
  });
});
