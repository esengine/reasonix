import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetCockpitCacheForTests,
  computeCockpit,
  computeWarm,
} from "../src/server/api/cockpit.js";
import type { DashboardContext } from "../src/server/context.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);

function ctxOnly(usageLogPath: string): DashboardContext {
  return { configPath: "", usageLogPath, mode: "attached" };
}

function record(opts: {
  ts: number;
  prompt?: number;
  completion?: number;
  hit?: number;
  miss?: number;
  cost?: number;
  model?: string;
}): string {
  return JSON.stringify({
    ts: opts.ts,
    session: null,
    model: opts.model ?? "deepseek-v4-flash",
    promptTokens: opts.prompt ?? 1000,
    completionTokens: opts.completion ?? 200,
    cacheHitTokens: opts.hit ?? 800,
    cacheMissTokens: opts.miss ?? 200,
    costUsd: opts.cost ?? 0.001,
    claudeEquivUsd: 0.01,
  });
}

describe("computeWarm", () => {
  let dir: string;
  let usagePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rx-cockpit-"));
    usagePath = join(dir, "usage.jsonl");
    _resetCockpitCacheForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nulls when the usage log is empty", () => {
    const out = computeWarm(usagePath, NOW);
    expect(out.tokens7d).toBeNull();
    expect(out.cacheHit7d).toBeNull();
    expect(out.costTrend14d).toBeNull();
  });

  it("rolls up tokens7d as prompt + completion across the trailing week", () => {
    const lines = [
      record({ ts: NOW - 1 * DAY, prompt: 10_000, completion: 2_000 }),
      record({ ts: NOW - 5 * DAY, prompt: 30_000, completion: 8_000 }),
      record({ ts: NOW - 8 * DAY, prompt: 99_999, completion: 99_999 }),
    ].join("\n");
    writeFileSync(usagePath, `${lines}\n`);
    const out = computeWarm(usagePath, NOW);
    expect(out.tokens7d?.total).toBe(50_000);
  });

  it("computes tokens7d deltaPct vs the prior 7-day window", () => {
    const inWeek = record({ ts: NOW - 1 * DAY, prompt: 10_000, completion: 0 });
    const priorWeek = record({ ts: NOW - 9 * DAY, prompt: 5_000, completion: 0 });
    writeFileSync(usagePath, `${inWeek}\n${priorWeek}\n`);
    const out = computeWarm(usagePath, NOW);
    expect(out.tokens7d?.deltaPct).toBeCloseTo(100, 5);
  });

  it("returns null deltaPct when the prior week has no records", () => {
    writeFileSync(usagePath, `${record({ ts: NOW - 1 * DAY })}\n`);
    const out = computeWarm(usagePath, NOW);
    expect(out.tokens7d?.deltaPct).toBeNull();
  });

  it("derives cacheHit7d ratio from the trailing-week bucket", () => {
    writeFileSync(
      usagePath,
      `${record({ ts: NOW - 1 * DAY, hit: 900, miss: 100 })}\n${record({ ts: NOW - 2 * DAY, hit: 100, miss: 900 })}\n`,
    );
    const out = computeWarm(usagePath, NOW);
    expect(out.cacheHit7d?.ratio).toBeCloseTo(0.5, 5);
  });

  it("sparkline has exactly `days` entries even when most days are empty", () => {
    writeFileSync(usagePath, `${record({ ts: NOW - 2 * DAY, cost: 0.05 })}\n`);
    const out = computeWarm(usagePath, NOW);
    expect(out.costTrend14d).toHaveLength(14);
    const total = (out.costTrend14d ?? []).reduce((s, d) => s + d.usd, 0);
    expect(total).toBeCloseTo(0.05, 5);
  });

  it("sparkline drops records older than the window", () => {
    writeFileSync(usagePath, `${record({ ts: NOW - 30 * DAY, cost: 99 })}\n`);
    const out = computeWarm(usagePath, NOW);
    const total = (out.costTrend14d ?? []).reduce((s, d) => s + d.usd, 0);
    expect(total).toBe(0);
  });
});

describe("computeCockpit", () => {
  let dir: string;
  let usagePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rx-cockpit-"));
    usagePath = join(dir, "usage.jsonl");
    _resetCockpitCacheForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null cockpit fields when ctx has no loop, no stats, no log", () => {
    const out = computeCockpit(ctxOnly(usagePath), NOW);
    expect(out.balance).toBeNull();
    expect(out.currentSession).toBeNull();
    expect(out.tokens7d).toBeNull();
  });

  it("surfaces balance from getStats", () => {
    const ctx: DashboardContext = {
      ...ctxOnly(usagePath),
      getStats: () => ({
        turns: 0,
        totalCostUsd: 0,
        lastTurnCostUsd: 0,
        totalInputCostUsd: 0,
        totalOutputCostUsd: 0,
        cacheHitRatio: 0,
        lastPromptTokens: 0,
        contextCapTokens: 1_000_000,
        balance: [{ currency: "CNY", total_balance: "48.20" }],
      }),
    };
    const out = computeCockpit(ctx, NOW);
    expect(out.balance).toEqual({ currency: "CNY", total: "48.20" });
  });

  it("warm fields are reused from cache within the TTL window", () => {
    writeFileSync(usagePath, `${record({ ts: NOW - 1 * DAY, prompt: 10_000 })}\n`);
    const first = computeCockpit(ctxOnly(usagePath), NOW);
    writeFileSync(usagePath, `${record({ ts: NOW - 1 * DAY, prompt: 999_999 })}\n`);
    const second = computeCockpit(ctxOnly(usagePath), NOW + 5_000);
    expect(second.tokens7d?.total).toBe(first.tokens7d?.total);
  });

  it("warm fields refresh once the TTL has elapsed", () => {
    writeFileSync(usagePath, `${record({ ts: NOW - 1 * DAY, prompt: 10_000 })}\n`);
    const first = computeCockpit(ctxOnly(usagePath), NOW);
    writeFileSync(usagePath, `${record({ ts: NOW - 1 * DAY, prompt: 999_999 })}\n`);
    const second = computeCockpit(ctxOnly(usagePath), NOW + 60_000);
    expect(second.tokens7d?.total).not.toBe(first.tokens7d?.total);
    expect(second.tokens7d?.total).toBeGreaterThan(first.tokens7d?.total ?? 0);
  });
});
