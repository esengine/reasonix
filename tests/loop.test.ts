/** CacheFirstLoop integration — fake-fetch DeepSeekClient, non-streaming path. */

import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
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
    // Savings vs Claude depends on which DeepSeek model is the loop's
    // default. v4-pro lands around 0.85; v4-flash around 0.97. Test the
    // lower bound so a future default swap doesn't churn this assertion.
    expect(loop.stats.savingsVsClaude).toBeGreaterThan(0.8);
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

  it("yields tool_start before each tool dispatch so the TUI can show 'running…'", async () => {
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "add", arguments: '{"a":1,"b":2}' },
          },
        ],
      },
      { content: "done" },
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
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      stream: false,
    });

    const roleOrder: { role: string; toolName?: string }[] = [];
    for await (const ev of loop.step("go")) {
      if (ev.role === "tool_start" || ev.role === "tool") {
        roleOrder.push({ role: ev.role, toolName: ev.toolName });
      }
    }
    // tool_start must precede the matching tool result.
    expect(roleOrder[0]).toEqual({ role: "tool_start", toolName: "add" });
    expect(roleOrder[1]).toEqual({ role: "tool", toolName: "add" });
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

  it("yields a warning event once when tool-call count crosses 70% of budget", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const callAgain = {
      content: "",
      tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
    };
    const summary = { content: "all done" };
    const responses: FakeResponseShape[] = [callAgain, callAgain, callAgain, callAgain, summary];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 4, // 70% → warn starting at iter >= 2
    });

    const warnings: string[] = [];
    for await (const ev of loop.step("go")) {
      if (ev.role === "warning") warnings.push(ev.content);
    }
    // Identical fixture calls also trip the storm breaker in 0.4.19+,
    // which emits its own warning. Filter for the iter-budget warning
    // specifically — that's what this test guards (once-per-turn flag).
    const iterBudgetWarnings = warnings.filter((w) => /tool calls used/.test(w));
    expect(iterBudgetWarnings).toHaveLength(1);
    expect(iterBudgetWarnings[0]).toMatch(/\d+\/4 tool calls used/);
    expect(iterBudgetWarnings[0]).toMatch(/Esc/);
  });

  it("abort() mid-step stops immediately without a follow-up API call", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const chainingToolCall = {
      content: "",
      tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
    };
    // Only one chaining response needed — abort should stop the loop
    // before any follow-up model call. A second response in the array
    // would indicate the loop made an unwanted extra API call.
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    const responses: FakeResponseShape[] = [chainingToolCall];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch(responses) as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 16,
    });

    // Call abort AFTER the first tool event fires — simulates the user
    // hitting Esc while the loop is exploring.
    const events: { role: string; content?: string; forcedSummary?: boolean }[] = [];
    let aborted = false;
    for await (const ev of loop.step("go")) {
      events.push({ role: ev.role, content: ev.content, forcedSummary: ev.forcedSummary });
      if (!aborted && ev.role === "tool") {
        aborted = true;
        loop.abort();
      }
    }

    // Warning fires with the abort notice.
    const warnings = events.filter((e) => e.role === "warning");
    expect(warnings.some((w) => /aborted at iter/.test(w.content ?? ""))).toBe(true);

    // Synthetic assistant_final is tagged forcedSummary and carries
    // the stopped-message text. It should NOT contain any model
    // output because no second API call was made.
    const finals = events.filter((e) => e.role === "assistant_final");
    const stopped = finals[finals.length - 1]!;
    expect(stopped.forcedSummary).toBe(true);
    expect(stopped.content).toMatch(/aborted by user \(Esc\)/);
    expect(stopped.content).toMatch(/no summary produced/);

    // Suite ends with `done`.
    expect(events[events.length - 1]!.role).toBe("done");
    // Silence unused-var warning.
    void fetchSpy;
  });

  it("does not bleed the prior turn's abort into the next step", async () => {
    // Regression: a user pressing Esc once would put _turnAbort into
    // an aborted state; the iter-0 abort branch handled it but didn't
    // reset the controller. Every subsequent step() then carried the
    // stale aborted state forward and bailed out with another
    // "stopped without producing a summary" before any model call ran.
    // The session was effectively dead until restart.
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const chainingToolCall = {
      content: "",
      tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
    };
    const finalAnswer = { content: "second turn ran cleanly", tool_calls: [] };
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fakeFetch([chainingToolCall, finalAnswer]) as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 16,
    });

    // Turn 1 — abort mid-flight.
    let aborted = false;
    for await (const ev of loop.step("first")) {
      if (!aborted && ev.role === "tool") {
        aborted = true;
        loop.abort();
      }
    }

    // Turn 2 — fresh user input; should reach the second model call
    // and yield its output. If the bug is back, we see iter-0 abort
    // again and never see "second turn ran cleanly".
    const turn2Events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("second")) {
      turn2Events.push({ role: ev.role, content: ev.content });
    }

    const finals = turn2Events.filter((e) => e.role === "assistant_final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.content).toBe("second turn ran cleanly");
    // No "aborted at iter 0" warning on turn 2.
    expect(
      turn2Events.some((e) => e.role === "warning" && /aborted at iter/.test(e.content ?? "")),
    ).toBe(false);
  });

  it("forces a summary when maxToolIters is exhausted, instead of stopping silently", async () => {
    // Give a registered tool so the repair layer doesn't strip the fake
    // tool_calls for referring to an unknown name.
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    // Every tool-iter response says "call probe again" — infinite loop
    // absent the iter cap. The (N+1)th response is the forced-summary
    // call (no tools, returns text).
    const chainingToolCall = {
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "probe", arguments: "{}" },
        },
      ],
    };
    const responses: FakeResponseShape[] = [
      chainingToolCall,
      chainingToolCall,
      { content: "done — here's what I found." }, // summary call
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 2, // deliberately tight so we hit the cap fast
    });

    const events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("go")) {
      events.push({ role: ev.role, content: ev.content });
    }

    // Multiple assistant_final events are yielded (one per iter) — the
    // summary is the LAST one, carrying the "tool-call budget" prefix.
    const finals = events.filter((e) => e.role === "assistant_final");
    const summary = finals[finals.length - 1];
    expect(summary).toBeDefined();
    expect(summary!.content).toMatch(/tool-call budget/);
    expect(summary!.content).toContain("done — here's what I found.");
    // Last event is still `done`, preserving the contract used by run().
    expect(events[events.length - 1]!.role).toBe("done");
  });

  it("storm-broken-all-suppressed forces a summary instead of stopping silently", async () => {
    // Repro of the user-reported "怎么就直接停了" — model loops on the
    // same broken tool call (e.g. read_file with empty path), the
    // storm-breaker suppresses every call after the threshold, and
    // pre-fix the loop would yield `done` with no prose. Fix routes
    // through forceSummaryAfterIterLimit so the model gets one
    // no-tools call to explain what was tried + what's blocking.
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    // Same (name, args) signature each iter — storm-breaker fires on
    // the third identical call. Threshold = 3, window = 6 (defaults).
    const dupCall = {
      id: "c1",
      type: "function",
      function: { name: "probe", arguments: "{}" },
    };
    const responses: FakeResponseShape[] = [
      { content: "", tool_calls: [dupCall] },
      { content: "", tool_calls: [{ ...dupCall, id: "c2" }] },
      { content: "", tool_calls: [{ ...dupCall, id: "c3" }] },
      // Forced-summary call — no tools advertised, model just narrates.
      {
        content:
          "I tried probe(no args) three times — same result each call. Need a different approach.",
      },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 8,
    });

    const events: { role: string; forcedSummary?: boolean; content?: string }[] = [];
    for await (const ev of loop.step("explore")) {
      events.push({ role: ev.role, forcedSummary: ev.forcedSummary, content: ev.content });
    }

    // Storm warning fires.
    expect(events.some((e) => e.role === "warning" && /storm/i.test(e.content ?? ""))).toBe(true);

    // Final assistant_final must be tagged forcedSummary with the
    // "stuck" prefix — proves we didn't just yield `done`.
    const finals = events.filter((e) => e.role === "assistant_final");
    const summary = finals[finals.length - 1];
    expect(summary?.forcedSummary).toBe(true);
    expect(summary?.content).toMatch(/stuck on a repeated tool call/);
  });

  it("context-guard diverts to summary when promptTokens > 80% of the window, tagging forcedSummary", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    // First response: chaining tool call with a prompt-token count
    // deliberately over 80% of DeepSeek V4's 1M window (1M * 0.8 =
    // 800k). 900k trips the guard.
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }],
        usage: {
          prompt_tokens: 900_000,
          completion_tokens: 50,
          total_tokens: 900_050,
          prompt_cache_hit_tokens: 700_000,
          prompt_cache_miss_tokens: 200_000,
        },
      },
      // Forced-summary response (no tools)
      { content: "based on what I saw, X." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 64,
    });

    const events: { role: string; forcedSummary?: boolean; content?: string }[] = [];
    for await (const ev of loop.step("analyze the repo")) {
      events.push({ role: ev.role, forcedSummary: ev.forcedSummary, content: ev.content });
    }

    // A warning must fire about the context guard. Accept both the
    // auto-compact-saved-us variant and the nothing-to-compact variant
    // — the message format shifted in 0.4.11 when we added the
    // auto-compact attempt before forcing summary.
    const warn = events.find((e) => e.role === "warning");
    expect(warn).toBeDefined();
    expect(warn!.content).toMatch(/context [\d,]+\/[\d,]+/);

    // The final assistant_final must be tagged forcedSummary and carry the context-guard prefix.
    const finals = events.filter((e) => e.role === "assistant_final");
    const summary = finals[finals.length - 1];
    expect(summary!.forcedSummary).toBe(true);
    expect(summary!.content).toMatch(/context budget running low/);
  });

  it("context-guard auto-compacts oversized tool results and continues instead of jumping to summary", async () => {
    // Pre-seed the log with an oversized tool result so compact has
    // something to shrink. Then the model requests another tool call;
    // the returned prompt_tokens trips the 80% guard. We expect compact
    // to run, the warning to mention shrinking, and the loop to
    // continue with the tool dispatch — no forced summary.
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const responses: FakeResponseShape[] = [
      // Iter 0: chains a tool call, usage trips the 80% guard against
      // V4's 1M window.
      {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "probe", arguments: "{}" } }],
        usage: {
          prompt_tokens: 900_000,
          completion_tokens: 10,
          total_tokens: 900_010,
          prompt_cache_hit_tokens: 750_000,
          prompt_cache_miss_tokens: 150_000,
        },
      },
      // Iter 1: model wraps up normally after the tool result.
      { content: "done analyzing." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 64,
    });
    // Put a big tool message into the log so compact has work to do.
    // Realistic log-line content (not "Z".repeat(N)) to avoid the
    // tokenizer's BPE O(n²) pathological path on pure-repeat inputs.
    loop.log.append({ role: "user", content: "do stuff" });
    loop.log.append({
      role: "tool",
      tool_call_id: "prior",
      content: "ERROR: something went wrong in module X at step Y\n".repeat(2000),
    });

    const events: { role: string; forcedSummary?: boolean; content?: string }[] = [];
    for await (const ev of loop.step("continue")) {
      events.push({ role: ev.role, forcedSummary: ev.forcedSummary, content: ev.content });
    }

    const warn = events.find((e) => e.role === "warning");
    expect(warn).toBeDefined();
    expect(warn!.content).toMatch(/auto-compacted \d+ oversized tool result/);
    // Tool was actually dispatched (we didn't force-summary).
    expect(events.find((e) => e.role === "tool")).toBeDefined();
    // Final assistant_final should NOT be tagged forcedSummary — we
    // took the happy path through the tool and a normal wrap-up.
    const finals = events.filter((e) => e.role === "assistant_final");
    const last = finals[finals.length - 1];
    expect(last!.forcedSummary).toBeFalsy();
  });

  it("proactively compacts oversized tool results between 60%-80% of the context window", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const responses: FakeResponseShape[] = [
      // V4's 1M window × 0.72 ≈ 720k tokens — squarely in the 60–80%
      // proactive band without tripping the reactive 80% guard.
      {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "probe", arguments: "{}" } }],
        usage: {
          prompt_tokens: 720_000,
          completion_tokens: 10,
          total_tokens: 720_010,
          prompt_cache_hit_tokens: 550_000,
          prompt_cache_miss_tokens: 170_000,
        },
      },
      { content: "done." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
      maxToolIters: 64,
    });
    // Seed an oversized tool result (>4k tokens, the proactive cap)
    // so proactive compact has work to do. Using realistic log-line
    // content to avoid the tokenizer's BPE O(n²) pathological path.
    loop.log.append({ role: "user", content: "prior" });
    loop.log.append({
      role: "tool",
      tool_call_id: "prior",
      content: "INFO: step completed with some trailing detail\n".repeat(1500),
    });

    const events: { role: string; content?: string; forcedSummary?: boolean }[] = [];
    for await (const ev of loop.step("continue")) {
      events.push({ role: ev.role, content: ev.content, forcedSummary: ev.forcedSummary });
    }

    const proactive = events.find(
      (e) => e.role === "warning" && /proactively compacted/.test(e.content ?? ""),
    );
    expect(proactive).toBeDefined();
    expect(proactive!.content).toMatch(/4k tokens/);
    // 60%-80% band must NOT force a summary (that's the 80% reactive path).
    const finals = events.filter((e) => e.role === "assistant_final");
    expect(finals[finals.length - 1]!.forcedSummary).toBeFalsy();
  });

  it("pre-clips new tool results at dispatch so they never enter the log oversized", async () => {
    const reg = new ToolRegistry();
    // Tool returns ~50k chars of realistic-shape log text; the default
    // token budget (8k) bounds the resulting log entry to a small
    // fraction of the raw size. (Using "A".repeat(N) would hit the
    // tokenizer's BPE O(n²) path for repeated single-char inputs —
    // pathological enough to slow the suite by tens of seconds, and
    // not representative of real tool output.)
    const huge = "ERROR: repeated failure with some detail\n".repeat(1250);
    reg.register({
      name: "big",
      description: "returns a lot",
      parameters: { type: "object", properties: {} },
      fn: async () => huge,
    });
    const responses: FakeResponseShape[] = [
      {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "big", arguments: "{}" } }],
      },
      { content: "summarized." },
    ];
    const client = makeClient(responses);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
      tools: reg,
      stream: false,
    });
    for await (const _ev of loop.step("go")) {
      /* drain */
    }
    const toolEntry = loop.log.toMessages().find((m) => m.role === "tool");
    expect(toolEntry).toBeDefined();
    const content = typeof toolEntry!.content === "string" ? toolEntry!.content : "";
    // Well under the raw 50k — pre-clip fired before append.
    expect(content.length).toBeLessThan(40_000);
    expect(content).toMatch(/truncated/);
  });

  it("buildMessages strips a dangling assistant-with-tool_calls tail — defensive against 'insufficient tool messages' 400", async () => {
    // Craft a log where the last entry is an assistant message with
    // tool_calls but no matching tool responses. This is the shape
    // that used to crash the forced-summary call with DeepSeek's
    // 'insufficient tool messages following tool_calls' error.
    const client = makeClient([{ content: "summary text" }]);
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.log.append({ role: "user", content: "hi" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "x", type: "function", function: { name: "noop", arguments: "{}" } }],
    });
    // A chat turn from here should succeed, not 400, because
    // buildMessages strips the unpaired tail.
    const events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("continue")) {
      events.push({ role: ev.role, content: ev.content });
    }
    expect(events.find((e) => e.role === "error")).toBeUndefined();
    // The fake fetch echoes the messages it received — no unpaired
    // assistant+tool_calls should be in there.
    expect(events.find((e) => e.role === "assistant_final")?.content).toContain("summary text");
  });

  it("surfaces an error event when the HTTP call fails with a non-retryable status", async () => {
    // 401 is non-retryable (bad key). Using this avoids multi-retry waits.
    const errFetch = vi.fn(async () => new Response("boom", { status: 401 }));
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: errFetch as unknown as typeof fetch,
      retry: { initialBackoffMs: 1, maxAttempts: 1 },
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

describe("CacheFirstLoop — self-reported escalation via <<<NEEDS_PRO>>>", () => {
  function modelCapturingFetch(responses: FakeResponseShape[]): {
    fetch: typeof fetch;
    seenModels: string[];
  } {
    const seenModels: string[] = [];
    let i = 0;
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      seenModels.push(body.model);
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
    return { fetch: fetchFn, seenModels };
  }

  it("retries on v4-pro when flash outputs the NEEDS_PRO marker as lead-in", async () => {
    const { fetch, seenModels } = modelCapturingFetch([
      { content: "<<<NEEDS_PRO>>>" }, // first call on flash → escalation request
      { content: "OK, here's the answer on pro." }, // retry on pro → real response
    ]);
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch }),
      prefix: new ImmutablePrefix({ system: "be brief" }),
      model: "deepseek-v4-flash",
      stream: false,
    });

    const events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("hard question")) {
      events.push({ role: ev.role, content: ev.content });
    }

    // Two model calls total: first flash, second pro
    expect(seenModels).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    // A warning surfaced about the retry
    expect(events.some((e) => e.role === "warning" && /escalat/i.test(e.content ?? ""))).toBe(true);
    // The final assistant message is the pro-generated content, not the marker
    const finalEv = events.find((e) => e.role === "assistant_final");
    expect(finalEv?.content).toBe("OK, here's the answer on pro.");
  });

  it("does not retry when the response merely mentions the marker mid-text", async () => {
    const { fetch, seenModels } = modelCapturingFetch([
      { content: "See the docs: <<<NEEDS_PRO>>> is a reserved marker." },
    ]);
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch }),
      prefix: new ImmutablePrefix({ system: "be brief" }),
      model: "deepseek-v4-flash",
      stream: false,
    });

    for await (const _ev of loop.step("explain the marker")) {
      /* drain */
    }

    expect(seenModels).toEqual(["deepseek-v4-flash"]);
  });

  it("does not escalate again when the model is already on pro", async () => {
    // Even if pro happens to echo the marker, no infinite-retry loop.
    const { fetch, seenModels } = modelCapturingFetch([
      { content: "<<<NEEDS_PRO>>>" }, // on pro — should NOT trigger retry
    ]);
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch }),
      prefix: new ImmutablePrefix({ system: "be brief" }),
      model: "deepseek-v4-pro",
      stream: false,
    });

    for await (const _ev of loop.step("hi")) {
      /* drain */
    }

    // Exactly one call; no retry.
    expect(seenModels).toEqual(["deepseek-v4-pro"]);
  });

  it("surfaces the model's reason in the warning when marker carries one", async () => {
    const { fetch } = modelCapturingFetch([
      { content: "<<<NEEDS_PRO: cross-file refactor with circular imports>>>" },
      { content: "Done on pro." },
    ]);
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch }),
      prefix: new ImmutablePrefix({ system: "be brief" }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    const events: { role: string; content?: string }[] = [];
    for await (const ev of loop.step("refactor this")) {
      events.push({ role: ev.role, content: ev.content });
    }
    const warning = events.find((e) => e.role === "warning" && /escalat/i.test(e.content ?? ""));
    expect(warning).toBeDefined();
    expect(warning?.content).toContain("cross-file refactor with circular imports");
  });

  it("treats an empty reason payload the same as the bare marker", async () => {
    const { fetch, seenModels } = modelCapturingFetch([
      { content: "<<<NEEDS_PRO: >>>" }, // empty reason
      { content: "Done on pro." },
    ]);
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch }),
      prefix: new ImmutablePrefix({ system: "be brief" }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    for await (const _ev of loop.step("x")) {
      /* drain */
    }
    expect(seenModels).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("does not match a malformed marker (no closing >>>)", async () => {
    const { fetch, seenModels } = modelCapturingFetch([
      { content: "<<<NEEDS_PRO: this looks like a marker but never closes" },
    ]);
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch }),
      prefix: new ImmutablePrefix({ system: "be brief" }),
      model: "deepseek-v4-flash",
      stream: false,
    });
    for await (const _ev of loop.step("x")) {
      /* drain */
    }
    // No retry — the marker never closed, so the content streams as-is.
    expect(seenModels).toEqual(["deepseek-v4-flash"]);
  });
});

describe("CacheFirstLoop (streaming) — tool_call_delta emission", () => {
  it("yields tool_call_delta events carrying growing arg-char count", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      // Fake fetch that streams an SSE body with a multi-chunk tool call.
      fetch: (async (_url: any, _init: any) => {
        const frames = [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: {} }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "edit_file", arguments: '{"path":"a.txt","search":"' } }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'old","replace":"new"}' } }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls", delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 } })}\n\n`,
          "data: [DONE]\n\n",
        ];
        const body = new ReadableStream({
          start(ctrl) {
            for (const f of frames) ctrl.enqueue(new TextEncoder().encode(f));
            ctrl.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as unknown as typeof fetch,
    });

    const tools = new ToolRegistry();
    tools.register({
      name: "edit_file",
      parameters: { type: "object", properties: {}, required: [] },
      fn: () => "ok",
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      stream: true,
      maxToolIters: 1,
    });

    const deltas: Array<{ name?: string; chars?: number }> = [];
    for await (const ev of loop.step("do it")) {
      if (ev.role === "tool_call_delta") {
        deltas.push({ name: ev.toolName, chars: ev.toolCallArgsChars });
      }
      if (ev.role === "tool_start") break;
    }

    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas[0]!.name).toBe("edit_file");
    expect(deltas[deltas.length - 1]!.chars).toBeGreaterThan(deltas[0]!.chars!);
  });

  it("does not emit a red error event when the API call is aborted mid-flight", async () => {
    // Reproduces the reported "error This operation was aborted" UX
    // bug: when App.tsx calls loop.abort() to switch to a queued
    // synthetic input (e.g. ShellConfirm "always allow"), the in-flight
    // fetch throws AbortError. We treat that as a clean early-exit
    // (yield `done`) instead of bubbling it up as a red error row.
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      // Slow fake fetch — never resolves on its own; only the abort
      // signal terminates it.
      fetch: vi.fn(async (_url: any, init: any) => {
        const signal: AbortSignal | undefined = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        });
      }) as any,
      retry: { maxAttempts: 1 },
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });

    const events: Array<{ role: string; error?: string }> = [];
    const stepPromise = (async () => {
      for await (const ev of loop.step("hi")) {
        events.push({ role: ev.role, error: ev.error });
      }
    })();
    // Race: fire abort before the fake fetch can resolve.
    setTimeout(() => loop.abort(), 10);
    await stepPromise;

    // No "error" event leaked through.
    expect(events.find((e) => e.role === "error")).toBeUndefined();
    // Loop terminated cleanly so the TUI's busy state unsticks.
    expect(events[events.length - 1]?.role).toBe("done");
  });

  describe("session USD budget", () => {
    // The gate runs purely against `loop.stats.totalCost`, which sums
    // the public `turns` array. Tests inject synthetic turns directly
    // instead of pumping fake API responses sized to land in the
    // narrow 80%-100% window — keeps each case focused on the
    // gate's behavior without coupling to v4-flash token pricing.
    function injectCost(loop: CacheFirstLoop, costUsd: number): void {
      // SessionStats.turns is `readonly` at the type level (you can't
      // reassign the field), but the array itself is mutable — the
      // public API normally appends via recordTurn(). For tests we
      // bypass that path; the only fields the gate reads are summed
      // via `t.cost`, so the rest is filler.
      (loop.stats.turns as unknown as Array<{ cost: number; model: string; usage: unknown }>).push({
        cost: costUsd,
        model: loop.model,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 0,
          cacheHitRatio: 0,
        },
      });
    }

    it("default behavior: budgetUsd undefined → no checks, no events", async () => {
      const client = makeClient([{ content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        // no budgetUsd
      });
      expect(loop.budgetUsd).toBeNull();
      injectCost(loop, 9999); // even huge fake spend doesn't matter
      const roles: string[] = [];
      for await (const ev of loop.step("q")) roles.push(ev.role);
      expect(roles).not.toContain("error");
      expect(roles.filter((r) => r === "warning")).toHaveLength(0);
    });

    it("warns once when cumulative cost crosses 80% of the cap", async () => {
      const client = makeClient([{ content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        budgetUsd: 1.0,
      });
      injectCost(loop, 0.85); // 85% of cap

      const roles: string[] = [];
      const warnings: string[] = [];
      for await (const ev of loop.step("a")) {
        roles.push(ev.role);
        if (ev.role === "warning") warnings.push(ev.content);
      }
      expect(warnings.filter((w) => /budget 80% used/.test(w))).toHaveLength(1);
      expect(roles).toContain("assistant_final");
    });

    it("does not repeat the 80% warning on subsequent turns", async () => {
      const client = makeClient([{ content: "ok" }, { content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        budgetUsd: 1.0,
      });
      injectCost(loop, 0.85);
      // Turn 1 fires warn.
      let turn1Warns = 0;
      for await (const ev of loop.step("a")) {
        if (ev.role === "warning" && /budget/.test(ev.content)) turn1Warns++;
      }
      // Turn 2 starts at the same 0.85 spent (real turn cost is tiny
      // with our fake fetch's default 100/20 token usage) — gate still
      // sees >80% but `_budgetWarned` is sticky, so no repeat.
      let turn2Warns = 0;
      for await (const ev of loop.step("b")) {
        if (ev.role === "warning" && /budget/.test(ev.content)) turn2Warns++;
      }
      expect(turn1Warns).toBe(1);
      expect(turn2Warns).toBe(0);
    });

    it("refuses the next turn once cumulative cost ≥ cap", async () => {
      const client = makeClient([{ content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        budgetUsd: 1.0,
      });
      injectCost(loop, 1.5);

      const events: { role: string; error?: string }[] = [];
      for await (const ev of loop.step("a")) {
        events.push({ role: ev.role, error: ev.error });
      }
      expect(events).toHaveLength(1);
      expect(events[0]?.role).toBe("error");
      expect(events[0]?.error).toMatch(/budget exhausted/);
      // Gate runs before any state mutation: only the injected fake
      // turn remains, no real model call recorded.
      expect(loop.stats.turns).toHaveLength(1);
    });

    it("setBudget(null) clears the cap and unblocks subsequent turns", async () => {
      const client = makeClient([{ content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        budgetUsd: 1.0,
      });
      injectCost(loop, 1.5);
      // Sanity check: the cap is currently exhausted.
      let firstAttempt: string | null = null;
      for await (const ev of loop.step("a")) {
        if (ev.role === "error") firstAttempt = ev.error ?? "";
        break;
      }
      expect(firstAttempt).toMatch(/budget exhausted/);
      // Clear the cap and try again.
      loop.setBudget(null);
      const roles: string[] = [];
      for await (const ev of loop.step("a")) roles.push(ev.role);
      expect(roles).not.toContain("error");
      expect(roles).toContain("assistant_final");
    });

    it("setBudget re-arms the 80% warning when the cap moves", async () => {
      const client = makeClient([{ content: "ok" }, { content: "ok" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        budgetUsd: 1.0,
      });
      injectCost(loop, 0.85); // 85% of $1
      // Turn 1: warn fires (sticky after this).
      let turn1Warns = 0;
      for await (const ev of loop.step("a")) {
        if (ev.role === "warning" && /budget/.test(ev.content)) turn1Warns++;
      }
      expect(turn1Warns).toBe(1);
      // Lower the cap further so spent (0.85) is even further past
      // the new 80% mark. setBudget must reset the sticky flag so
      // the user sees a fresh warning at the new threshold.
      loop.setBudget(0.95);
      let turn2Warns = 0;
      for await (const ev of loop.step("b")) {
        if (ev.role === "warning" && /budget/.test(ev.content)) turn2Warns++;
      }
      expect(turn2Warns).toBe(1);
    });
  });
});
