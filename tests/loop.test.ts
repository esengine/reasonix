/**
 * Integration tests for CacheFirstLoop.
 *
 * We inject a fake fetch into DeepSeekClient so the loop exercises its real
 * request/response wiring without hitting the network. The non-streaming
 * path is covered here; streaming is exercised by the TUI in practice.
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

function fakeFetch(responses: FakeResponseShape[]): typeof fetch {
  let i = 0;
  return vi.fn(async (_url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const resp = responses[i++] ?? responses[responses.length - 1]!;
    return new Response(
      JSON.stringify({
        _echo_messages: body.messages as ChatMessage[],
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
}

function makeClient(responses: FakeResponseShape[]) {
  return new DeepSeekClient({
    apiKey: "sk-test",
    fetch: fakeFetch(responses),
  });
}

describe("CacheFirstLoop (non-streaming)", () => {
  it("completes a single-turn plain chat", async () => {
    const client = makeClient([{ content: "hi there" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
    });

    const events: string[] = [];
    for await (const ev of loop.step("hello")) {
      events.push(ev.role);
    }

    expect(events).toContain("assistant_final");
    expect(events[events.length - 1]).toBe("done");
    expect(loop.stats.turns.length).toBe(1);
    expect(loop.log.length).toBe(2); // user + assistant
  });

  it("records cache hit telemetry from API usage", async () => {
    const client = makeClient([
      {
        content: "ok",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 10,
          total_tokens: 1010,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 200,
        },
      },
    ]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    await loop.run("q");
    expect(loop.stats.aggregateCacheHitRatio).toBeCloseTo(0.8);
    expect(loop.stats.totalCost).toBeGreaterThan(0);
    expect(loop.stats.savingsVsClaude).toBeGreaterThan(0.9);
  });

  it("dispatches a tool call and loops until the model stops", async () => {
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "add", arguments: '{"a":2,"b":3}' },
          },
        ],
      },
      { content: "The answer is 5." },
    ]);

    const tools = new ToolRegistry();
    tools.register<{ a: number; b: number }, number>({
      name: "add",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
      fn: ({ a, b }) => a + b,
    });

    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({
        system: "use add tool",
        toolSpecs: tools.specs(),
      }),
      tools,
      stream: false,
    });

    const roles: string[] = [];
    let toolContent = "";
    let finalContent = "";
    for await (const ev of loop.step("2 + 3 = ?")) {
      roles.push(ev.role);
      if (ev.role === "tool") toolContent = ev.content;
      if (ev.role === "assistant_final") finalContent = ev.content;
    }

    expect(roles).toContain("tool");
    expect(toolContent).toBe("5");
    expect(finalContent).toBe("The answer is 5.");
    expect(loop.stats.turns.length).toBe(2); // two model round-trips
  });

  it("immutable prefix is preserved across turns (cache-stability invariant)", async () => {
    const sharedFetch = fakeFetch([{ content: "a" }, { content: "b" }]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: sharedFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "pinned system" }),
      stream: false,
    });

    await loop.run("q1");
    await loop.run("q2");

    const calls = (sharedFetch as any).mock.calls;
    expect(calls.length).toBe(2);
    const msgs1 = JSON.parse(calls[0][1].body).messages as ChatMessage[];
    const msgs2 = JSON.parse(calls[1][1].body).messages as ChatMessage[];

    // Both requests start with the exact same system prefix (byte-identical).
    expect(msgs1[0]).toEqual({ role: "system", content: "pinned system" });
    expect(msgs2[0]).toEqual({ role: "system", content: "pinned system" });

    // Second request should begin with msgs1 as its prefix
    // (append-only log invariant: history is never rewritten).
    for (let i = 0; i < msgs1.length; i++) {
      expect(msgs2[i]).toEqual(msgs1[i]);
    }
    // And msgs2 is strictly longer (new user turn + assistant reply from turn 1).
    expect(msgs2.length).toBeGreaterThan(msgs1.length);
  });

  it("surfaces an error event when the HTTP call fails", async () => {
    const errFetch = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: errFetch as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    const roles: string[] = [];
    for await (const ev of loop.step("q")) {
      roles.push(ev.role);
    }
    expect(roles).toContain("error");
  });
});
