/**
 * R1 thinking-mode contract: when a reasoner turn returns both
 * `reasoning_content` and `tool_calls`, the assistant message we
 * persist + send on the NEXT request (the tool-loop continuation)
 * must carry `reasoning_content` back. Otherwise DeepSeek 400s with
 * "The reasoning_content in the thinking mode must be passed back to
 * the API." Reproduces the bug that surfaced in 0.5.14 live usage.
 */

import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";

interface FakeResponseShape {
  content?: string;
  reasoning_content?: string;
  tool_calls?: any[];
  usage?: Record<string, number>;
}

function capturingFetch(responses: FakeResponseShape[]): {
  fetch: typeof fetch;
  bodies: Array<{ messages: ChatMessage[] }>;
} {
  const bodies: Array<{ messages: ChatMessage[] }> = [];
  let i = 0;
  const fn = vi.fn(async (_url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    bodies.push({ messages: body.messages });
    const resp = responses[i++] ?? responses[responses.length - 1]!;
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: resp.content ?? "",
              reasoning_content: resp.reasoning_content ?? null,
              tool_calls: resp.tool_calls ?? undefined,
            },
            finish_reason: resp.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: resp.usage ?? {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 100,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fn, bodies };
}

describe("R1 reasoning_content round-trip", () => {
  it("preserves reasoning_content on the assistant message when the turn has tool_calls", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "noop",
      readOnly: true,
      fn: () => "ok",
    });

    const { fetch: fakeFetch, bodies } = capturingFetch([
      {
        // Turn 1: model emits reasoning + tool call.
        content: "",
        reasoning_content: "I should call noop to check something.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "noop", arguments: "{}" },
          },
        ],
      },
      {
        // Turn 2: plain text wrap-up after the tool result comes back.
        content: "done",
      },
    ]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      model: "deepseek-reasoner",
      stream: false,
    });

    for await (const _ev of loop.step("please noop")) {
      /* drain */
    }

    expect(bodies.length).toBe(2);
    // Turn 2's request messages include the turn-1 assistant message;
    // find it and verify reasoning_content landed.
    const turn2Messages = bodies[1]!.messages;
    const assistantWithCalls = turn2Messages.find(
      (m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0,
    );
    expect(assistantWithCalls).toBeDefined();
    expect(assistantWithCalls?.reasoning_content).toBe("I should call noop to check something.");
  });

  it("does NOT emit reasoning_content on plain-text assistant turns (no tool_calls)", async () => {
    const { fetch: fakeFetch, bodies } = capturingFetch([
      {
        content: "a plain answer",
        reasoning_content: "some reasoning that shouldn't be round-tripped",
      },
      { content: "follow-up" },
    ]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-reasoner",
      stream: false,
    });

    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    // Second user turn to send turn-1's assistant back.
    for await (const _ev of loop.step("next")) {
      /* drain */
    }

    const turn2Messages = bodies[1]!.messages;
    const assistant = turn2Messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    // Plain-text turn has no tool_calls, so we save prompt tokens by
    // NOT echoing the reasoning back. DeepSeek only requires it when
    // the turn had tool_calls.
    expect(assistant?.reasoning_content).toBeUndefined();
  });
});
