/**
 * Preflight context-size check tests.
 *
 * Reactive auto-compact keys off the PREVIOUS turn's prompt_tokens —
 * too late to save a fresh request whose buildMessages already exceeds
 * the model's context window. The preflight estimates locally before
 * sending and compacts first.
 *
 * We set a tiny context budget on a synthetic model id so modestly-
 * sized test content can trip the 95% threshold without churning
 * through ~120k tokens of fake text.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry.js";
import type { ChatMessage } from "../src/types.js";

interface FakeResponseShape {
  content?: string;
  usage?: Record<string, number>;
}

function fakeFetch(responses: FakeResponseShape[]): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const resp = responses[i++] ?? responses[responses.length - 1]!;
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: resp.content ?? "", tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: resp.usage ?? {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
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

describe("preflight context-size check", () => {
  const TEST_MODEL = "test-tiny-ctx";
  afterEach(() => {
    delete DEEPSEEK_CONTEXT_TOKENS[TEST_MODEL];
  });

  it("auto-compacts when the estimated request exceeds 95% of the context window", async () => {
    // Tiny 1000-token budget so modest content can overflow.
    DEEPSEEK_CONTEXT_TOKENS[TEST_MODEL] = 1000;

    const client = makeClient([{ content: "ack" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
      model: TEST_MODEL,
    });

    // Seed the log with a PROPERLY paired (assistant.tool_calls ↔
    // tool) turn so buildMessages doesn't strip the tool result as
    // an orphan. The tool result is oversized enough to push the
    // preflight estimate past 95% of the 1000-token budget. Realistic
    // log-line content to avoid the tokenizer's BPE O(n²) pathological
    // path on pure-repeat inputs.
    loop.log.append({ role: "user", content: "prior request" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "prior", type: "function", function: { name: "probe", arguments: "{}" } }],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: "prior",
      content: "ERROR: step failed with trailing detail\n".repeat(500),
    });

    const events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("follow-up")) {
      events.push({ role: ev.role, content: ev.content });
    }

    // Preflight fires BEFORE the request — expect a warning that names
    // the preflight path and reports tokens saved from compaction.
    const warn = events.find((e) => e.role === "warning" && /^preflight:/.test(e.content ?? ""));
    expect(warn).toBeDefined();
    expect(warn!.content).toMatch(/pre-compacted \d+ tool result/);
    expect(warn!.content).toMatch(/saved [\d,]+ tokens/);

    // Loop still completed normally (no forced summary, no error).
    expect(events.find((e) => e.role === "error")).toBeUndefined();
    const finals = events.filter((e) => e.role === "assistant_final");
    expect(finals.length).toBe(1);
  });

  it("does NOT fire when the estimate is comfortably under 95%", async () => {
    // Keep the real 131k budget — a normal conversation won't trip.
    const client = makeClient([{ content: "ok" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be brief" }),
      stream: false,
    });

    const events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("hi")) {
      events.push({ role: ev.role, content: ev.content });
    }

    const anyPreflight = events.find(
      (e) => e.role === "warning" && /^preflight:/.test(e.content ?? ""),
    );
    expect(anyPreflight).toBeUndefined();
  });

  it("warns (but does not block) when over 95% with nothing to compact", async () => {
    // Tiny budget AND a system prompt that alone overwhelms it. No
    // tool messages exist, so compact has nothing to shrink — the
    // preflight should still surface a warning so the failure isn't
    // mysterious; the request goes out regardless and DeepSeek decides.
    DEEPSEEK_CONTEXT_TOKENS[TEST_MODEL] = 500;
    const bulkyPrompt = "You are a careful assistant. ".repeat(300);

    const client = makeClient([{ content: "ack" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: bulkyPrompt }),
      stream: false,
      model: TEST_MODEL,
    });

    const events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("hi")) {
      events.push({ role: ev.role, content: ev.content });
    }

    const warn = events.find((e) => e.role === "warning" && /^preflight:/.test(e.content ?? ""));
    expect(warn).toBeDefined();
    expect(warn!.content).toMatch(/nothing to auto-compact/);
    // Run still reaches the final step — the user sees the warning
    // and can react, but we don't short-circuit on our own.
    const finals = events.filter((e) => e.role === "assistant_final");
    expect(finals.length).toBe(1);
  });
});
