import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient, Usage } from "../src/client.js";
import {
  type BranchSample,
  aggregateBranchUsage,
  defaultSelector,
  runBranches,
} from "../src/consistency.js";
import { emptyPlanState } from "../src/harvest.js";

interface MainCallScript {
  content: string;
  reasoning: string;
}

/**
 * Fake fetch that returns different main-call responses per branch (keyed by
 * temperature) and a canned plan-state JSON for every harvest call.
 */
function makeFakeFetch(
  mainByTemp: Record<string, MainCallScript>,
  harvestJson: string | ((reasoning: string) => string),
) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse((init.body as string) ?? "{}");
    const isHarvest = body.response_format?.type === "json_object";
    if (isHarvest) {
      const reasoningMsg = body.messages?.[1]?.content ?? "";
      const payload = typeof harvestJson === "function" ? harvestJson(reasoningMsg) : harvestJson;
      return new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: payload } }],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const key = String(body.temperature ?? 0);
    const script = mainByTemp[key] ?? Object.values(mainByTemp)[0]!;
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: script.content,
              reasoning_content: script.reasoning.length > 0 ? script.reasoning : null,
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("aggregateBranchUsage", () => {
  it("sums token counts across all samples", () => {
    const mk = (pt: number, ct: number, hit: number, miss: number): BranchSample => ({
      index: 0,
      temperature: 0,
      response: {
        content: "",
        reasoningContent: null,
        toolCalls: [],
        usage: new Usage(pt, ct, pt + ct, hit, miss),
        raw: null,
      },
      planState: emptyPlanState(),
    });
    const agg = aggregateBranchUsage([
      mk(100, 50, 80, 20),
      mk(200, 70, 150, 50),
      mk(120, 40, 100, 20),
    ]);
    expect(agg.promptTokens).toBe(420);
    expect(agg.completionTokens).toBe(160);
    expect(agg.promptCacheHitTokens).toBe(330);
    expect(agg.promptCacheMissTokens).toBe(90);
  });
});

describe("defaultSelector", () => {
  it("picks the sample with fewest uncertainties", () => {
    const mk = (i: number, u: number, content = "x"): BranchSample => ({
      index: i,
      temperature: 0,
      response: {
        content,
        reasoningContent: null,
        toolCalls: [],
        usage: {} as any,
        raw: null,
      },
      planState: { ...emptyPlanState(), uncertainties: new Array(u).fill("u") },
    });
    const chosen = defaultSelector([mk(0, 3), mk(1, 0), mk(2, 2)]);
    expect(chosen.index).toBe(1);
  });

  it("tie-breaks ties on shorter content", () => {
    const mk = (i: number, len: number): BranchSample => ({
      index: i,
      temperature: 0,
      response: {
        content: "x".repeat(len),
        reasoningContent: null,
        toolCalls: [],
        usage: {} as any,
        raw: null,
      },
      planState: emptyPlanState(),
    });
    const chosen = defaultSelector([mk(0, 500), mk(1, 100), mk(2, 1000)]);
    expect(chosen.index).toBe(1);
  });
});

describe("runBranches", () => {
  it("runs 1 sample when budget=1 (no branching)", async () => {
    const fakeFetch = makeFakeFetch(
      { "0": { content: "answer", reasoning: "a long enough reasoning trace to pass threshold." } },
      JSON.stringify({
        subgoals: [],
        hypotheses: [],
        uncertainties: [],
        rejectedPaths: [],
      }),
    );
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const r = await runBranches(
      client,
      { model: "deepseek-reasoner", messages: [{ role: "user", content: "hi" }] },
      { budget: 1 },
    );
    expect(r.samples.length).toBe(1);
    expect(r.chosen.response.content).toBe("answer");
  });

  it("runs N samples in parallel with varied temperatures", async () => {
    const fakeFetch = makeFakeFetch(
      {
        "0": { content: "ans-0", reasoning: "reasoning trace for sample 0 that is long enough." },
        "0.5": {
          content: "ans-05",
          reasoning: "reasoning trace for sample 1 that is long enough.",
        },
        "1": { content: "ans-1", reasoning: "reasoning trace for sample 2 that is long enough." },
      },
      JSON.stringify({
        subgoals: [],
        hypotheses: [],
        uncertainties: [],
        rejectedPaths: [],
      }),
    );
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const r = await runBranches(
      client,
      { model: "deepseek-reasoner", messages: [{ role: "user", content: "hi" }] },
      { budget: 3 },
    );
    expect(r.samples.length).toBe(3);
    const temps = r.samples.map((s) => s.temperature);
    expect(temps).toEqual([0, 0.5, 1]);
  });

  it("selects the sample with fewest uncertainties", async () => {
    const fakeFetch = makeFakeFetch(
      {
        "0": { content: "ans-0", reasoning: "reasoning trace for sample 0 that is long enough." },
        "1": { content: "ans-1", reasoning: "reasoning trace for sample 1 that is long enough." },
      },
      (reasoning) => {
        const count = /sample 0/.test(reasoning) ? 3 : 0;
        return JSON.stringify({
          subgoals: [],
          hypotheses: [],
          uncertainties: new Array(count).fill("unclear thing"),
          rejectedPaths: [],
        });
      },
    );
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const r = await runBranches(
      client,
      { model: "deepseek-reasoner", messages: [{ role: "user", content: "hi" }] },
      { budget: 2 },
    );
    expect(r.chosen.response.content).toBe("ans-1");
    expect(r.chosen.planState.uncertainties.length).toBe(0);
  });

  it("fires onSampleDone exactly once per sample", async () => {
    const fakeFetch = makeFakeFetch(
      {
        "0": { content: "ans", reasoning: "reasoning trace for sample 0, long enough." },
        "0.5": { content: "ans", reasoning: "reasoning trace for sample 1, long enough." },
        "1": { content: "ans", reasoning: "reasoning trace for sample 2, long enough." },
      },
      JSON.stringify({ subgoals: [], hypotheses: [], uncertainties: [], rejectedPaths: [] }),
    );
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const onSampleDone = vi.fn();
    await runBranches(
      client,
      { model: "deepseek-reasoner", messages: [{ role: "user", content: "hi" }] },
      { budget: 3, onSampleDone },
    );
    expect(onSampleDone).toHaveBeenCalledTimes(3);
  });

  it("accepts custom temperatures override", async () => {
    const fakeFetch = makeFakeFetch(
      {
        "0.2": { content: "ans", reasoning: "reasoning trace for this sample, long enough." },
        "0.9": { content: "ans", reasoning: "reasoning trace for this sample, long enough." },
      },
      JSON.stringify({ subgoals: [], hypotheses: [], uncertainties: [], rejectedPaths: [] }),
    );
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const r = await runBranches(
      client,
      { model: "deepseek-reasoner", messages: [{ role: "user", content: "hi" }] },
      { budget: 2, temperatures: [0.2, 0.9] },
    );
    expect(r.samples.map((s) => s.temperature)).toEqual([0.2, 0.9]);
  });
});
