/** CacheFirstLoop hook wiring — confirms the loop honors `hooks` and exposes a swappable list for `/hooks reload`. */

import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import type { ResolvedHook } from "../src/hooks.js";
import { CacheFirstLoop, type LoopEvent } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";

interface FakeResponseShape {
  content?: string;
  tool_calls?: unknown[];
}

function fakeFetch(responses: FakeResponseShape[]): typeof fetch {
  let i = 0;
  return vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
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
              tool_calls: resp.tool_calls ?? undefined,
            },
            finish_reason: resp.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: {
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
  return new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch(responses) });
}

describe("CacheFirstLoop hook wiring", () => {
  it("default hooks list is empty (zero overhead when no settings.json)", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
    });
    expect(loop.hooks).toEqual([]);
  });

  it("accepts a hooks list via options", () => {
    const hooks: ResolvedHook[] = [
      { event: "Stop", scope: "global", source: "/x", command: "echo done" },
    ];
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
      hooks,
    });
    expect(loop.hooks).toEqual(hooks);
  });

  it("hooks field is mutable so /hooks reload can swap without rebuild", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
    });
    const fresh: ResolvedHook[] = [
      { event: "PreToolUse", scope: "project", source: "/x", command: "true" },
    ];
    loop.hooks = fresh;
    expect(loop.hooks).toEqual(fresh);
  });

  it("hookCwd defaults to process.cwd() when not provided", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
    });
    expect(loop.hookCwd).toBe(process.cwd());
  });

  it("hookCwd takes the explicit override when set", () => {
    const loop = new CacheFirstLoop({
      client: makeClient([{ content: "x" }]),
      prefix: new ImmutablePrefix({ system: "s" }),
      hookCwd: "/some/sandbox/root",
    });
    expect(loop.hookCwd).toBe("/some/sandbox/root");
  });

  it("a no-tool-call turn never dispatches hooks (PreToolUse only fires around tools)", async () => {
    // Sanity check: a plain text response means no PreToolUse hook
    // would be invoked even if one were configured. We assert only
    // through observable events here — no hook = no warning rows.
    const client = makeClient([{ content: "just chatting" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      hooks: [{ event: "PreToolUse", scope: "global", source: "/x", command: "noop" }],
    });
    const events: LoopEvent[] = [];
    for await (const ev of loop.step("hi")) events.push(ev);
    expect(events.find((e) => e.role === "warning")).toBeUndefined();
    expect(events.find((e) => e.role === "assistant_final")?.content).toBe("just chatting");
  });
});
