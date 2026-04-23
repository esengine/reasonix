/**
 * Subagent tool — registration, child-loop isolation, fork-registry
 * exclusion rules, error path, abort propagation, plan-mode inheritance.
 *
 * The DeepSeek client is faked so we never hit the network. Same shape
 * as `tests/loop.test.ts` so the wire-level expectations stay aligned
 * with the loop's real behavior.
 */

import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { ToolRegistry } from "../src/tools.js";
import {
  type SubagentEvent,
  type SubagentSink,
  forkRegistryExcluding,
  registerSubagentTool,
} from "../src/tools/subagent.js";

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
        _echo_messages: body.messages,
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

function makeSink(): { sink: SubagentSink; events: SubagentEvent[] } {
  const events: SubagentEvent[] = [];
  const sink: SubagentSink = {
    current: (ev) => {
      events.push(ev);
    },
  };
  return { sink, events };
}

describe("registerSubagentTool", () => {
  it("registers spawn_subagent into the parent registry", () => {
    const parent = new ToolRegistry();
    const client = makeClient([{ content: "ok" }]);
    registerSubagentTool(parent, { client });
    expect(parent.has("spawn_subagent")).toBe(true);
  });

  it("returns a structured success payload with the subagent's final answer", async () => {
    const parent = new ToolRegistry();
    const client = makeClient([{ content: "the answer is 42" }]);
    registerSubagentTool(parent, { client });
    const out = await parent.dispatch(
      "spawn_subagent",
      JSON.stringify({ task: "what is the answer?" }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toBe("the answer is 42");
    expect(parsed.turns).toBe(1);
    expect(parsed.tool_iters).toBe(0);
    expect(typeof parsed.elapsed_ms).toBe("number");
  });

  it("rejects an empty task with a structured error", async () => {
    const parent = new ToolRegistry();
    const client = makeClient([{ content: "won't be called" }]);
    registerSubagentTool(parent, { client });
    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "   \n  " }));
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/non-empty 'task'/);
  });

  it("emits start → end events through the sink", async () => {
    const parent = new ToolRegistry();
    const client = makeClient([{ content: "done" }]);
    const { sink, events } = makeSink();
    registerSubagentTool(parent, { client, sink });
    await parent.dispatch(
      "spawn_subagent",
      JSON.stringify({ task: "this task is over thirty characters long" }),
    );
    expect(events[0]?.kind).toBe("start");
    expect(events[events.length - 1]?.kind).toBe("end");
    // task preview truncated to 30 chars + ellipsis
    expect(events[0]?.task).toMatch(/…$/);
    expect(events[0]?.task.length).toBeLessThanOrEqual(31);
    // end event carries the summary + turn count
    const end = events[events.length - 1]!;
    expect(end.summary).toBe("done");
    expect(end.turns).toBe(1);
    expect(end.error).toBeUndefined();
  });

  it("emits a progress event for each tool result inside the child loop", async () => {
    const parent = new ToolRegistry();
    parent.register({
      name: "noop",
      readOnly: true,
      fn: () => "noop-result",
    });
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "noop", arguments: "{}" },
          },
        ],
      },
      { content: "all done" },
    ]);
    const { sink, events } = makeSink();
    registerSubagentTool(parent, { client, sink });
    await parent.dispatch("spawn_subagent", JSON.stringify({ task: "use noop" }));
    const progress = events.filter((e) => e.kind === "progress");
    expect(progress.length).toBe(1);
    expect(progress[0]?.iter).toBe(1);
  });

  it("surfaces a child-loop error in the structured result + end event", async () => {
    const parent = new ToolRegistry();
    // 401 from the fake fetch → DeepSeekClient throws inside the child step()
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => new Response("unauthorized", { status: 401 })) as any,
      retry: { maxAttempts: 1 },
    });
    const { sink, events } = makeSink();
    registerSubagentTool(parent, { client, sink });
    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "fail please" }));
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeTruthy();
    const end = events[events.length - 1]!;
    expect(end.kind).toBe("end");
    expect(end.error).toBeTruthy();
    expect(end.summary).toBeUndefined();
  });

  it("truncates oversized output and signals the truncation", async () => {
    const parent = new ToolRegistry();
    const huge = "x".repeat(20_000);
    const client = makeClient([{ content: huge }]);
    registerSubagentTool(parent, { client, maxResultChars: 100 });
    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "spew" }));
    const parsed = JSON.parse(out);
    expect(parsed.output.length).toBeLessThan(huge.length);
    expect(parsed.output).toMatch(/truncated/);
  });

  it("never registers spawn_subagent itself into the child registry (no recursion)", async () => {
    // We can't easily peek at the child registry from outside the tool,
    // but we CAN observe the child loop's prefix.toolSpecs via the
    // request body the fake fetch sees. Tools advertised in the request
    // are exactly the child registry's specs.
    const parent = new ToolRegistry();
    parent.register({ name: "harmless", readOnly: true, fn: () => "ok" });
    parent.register({ name: "submit_plan", readOnly: true, fn: () => "ok" });
    const seenToolNames: string[][] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        const tools = (body.tools ?? []) as Array<{ function: { name: string } }>;
        seenToolNames.push(tools.map((t) => t.function.name));
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "fine" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
    });
    registerSubagentTool(parent, { client });
    await parent.dispatch("spawn_subagent", JSON.stringify({ task: "go" }));
    expect(seenToolNames.length).toBe(1);
    const childTools = seenToolNames[0]!;
    // Inherited the harmless tool, but NOT spawn_subagent or submit_plan.
    expect(childTools).toContain("harmless");
    expect(childTools).not.toContain("spawn_subagent");
    expect(childTools).not.toContain("submit_plan");
  });

  it("respects a custom system prompt passed in the tool args", async () => {
    const seenSystems: string[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        const sys = (body.messages ?? []).find((m: any) => m.role === "system");
        if (sys) seenSystems.push(sys.content);
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
    });
    const parent = new ToolRegistry();
    registerSubagentTool(parent, { client });
    await parent.dispatch(
      "spawn_subagent",
      JSON.stringify({ task: "go", system: "You are a custom subagent." }),
    );
    expect(seenSystems[0]).toBe("You are a custom subagent.");
  });

  it("falls back to the default model when the model arg is invalid", async () => {
    const seenModels: string[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        seenModels.push(body.model);
        return new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
    });
    const parent = new ToolRegistry();
    registerSubagentTool(parent, { client });
    // "gpt-4" is not a deepseek-* model — should be ignored.
    await parent.dispatch("spawn_subagent", JSON.stringify({ task: "go", model: "gpt-4" }));
    expect(seenModels[0]).toBe("deepseek-chat");
  });

  it("aborts the child when the parent's tool ctx signal fires", async () => {
    const parent = new ToolRegistry();
    // Slow client — sleeps 200ms before responding so the abort beats it.
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const signal: AbortSignal | undefined = init?.signal;
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 200);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        return new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: "assistant", content: "late" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
      retry: { maxAttempts: 1 },
    });
    registerSubagentTool(parent, { client });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "slow" }), {
      signal: ctrl.signal,
    });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
  });
});

describe("forkRegistryExcluding", () => {
  it("copies all tools except the excluded names", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "a", fn: () => "a" });
    parent.register({ name: "b", fn: () => "b" });
    parent.register({ name: "c", fn: () => "c" });
    const child = forkRegistryExcluding(parent, new Set(["b"]));
    expect(child.has("a")).toBe(true);
    expect(child.has("b")).toBe(false);
    expect(child.has("c")).toBe(true);
    expect(child.size).toBe(2);
  });

  it("propagates plan-mode state from the parent", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "x", readOnly: true, fn: () => "x" });
    parent.setPlanMode(true);
    const child = forkRegistryExcluding(parent, new Set());
    expect(child.planMode).toBe(true);
  });

  it("child registry's plan mode defaults off when parent's is off", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "x", fn: () => "x" });
    const child = forkRegistryExcluding(parent, new Set());
    expect(child.planMode).toBe(false);
  });

  it("dispatching a copied tool still runs its fn", async () => {
    const parent = new ToolRegistry();
    let calls = 0;
    parent.register({
      name: "counter",
      fn: () => {
        calls++;
        return `n=${calls}`;
      },
    });
    const child = forkRegistryExcluding(parent, new Set());
    const out = await child.dispatch("counter", "{}");
    expect(out).toBe("n=1");
  });
});
