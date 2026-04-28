/**
 * Tests for the usage log + aggregator.
 *
 * Covered:
 *   - appendUsage round-trips (record → file → readUsageLog)
 *   - readUsageLog tolerates malformed tail lines + missing file
 *   - aggregateUsage rolls records into today / week / month / all
 *     using rolling windows against an injected `now`
 *   - bucketCacheHitRatio / bucketSavingsFraction handle zero-denominator
 *   - stats dashboard render contains the expected rows
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderDashboard } from "../src/cli/commands/stats.js";
import { Usage } from "../src/client.js";
import {
  type UsageRecord,
  aggregateUsage,
  appendUsage,
  bucketCacheHitRatio,
  bucketSavingsFraction,
  readUsageLog,
} from "../src/usage.js";

function usage(overrides: Partial<Usage> = {}): Usage {
  return new Usage(
    overrides.promptTokens ?? 100,
    overrides.completionTokens ?? 20,
    overrides.totalTokens ?? 120,
    overrides.promptCacheHitTokens ?? 80,
    overrides.promptCacheMissTokens ?? 20,
  );
}

describe("appendUsage + readUsageLog", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-usage-"));
    path = join(dir, "usage.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a single record", () => {
    const record = appendUsage({
      session: "default",
      model: "deepseek-reasoner",
      usage: usage(),
      now: 1_700_000_000_000,
      path,
    });
    expect(record.session).toBe("default");
    expect(record.costUsd).toBeGreaterThan(0);
    expect(record.claudeEquivUsd).toBeGreaterThan(record.costUsd);

    const loaded = readUsageLog(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.ts).toBe(1_700_000_000_000);
    expect(loaded[0]?.session).toBe("default");
  });

  it("returns [] when the log does not exist", () => {
    expect(readUsageLog(path)).toEqual([]);
  });

  it("tolerates a malformed trailing line (skips it)", () => {
    appendUsage({ session: null, model: "deepseek-chat", usage: usage(), path });
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "{ not valid json\n", "utf8");
    const loaded = readUsageLog(path);
    expect(loaded).toHaveLength(1);
  });

  it("creates the parent directory if missing", () => {
    const deep = join(dir, "a", "b", "usage.jsonl");
    appendUsage({ session: null, model: "deepseek-chat", usage: usage(), path: deep });
    expect(readUsageLog(deep)).toHaveLength(1);
  });

  it("compacts the log when it crosses the size threshold, dropping records older than the retention window", () => {
    // Synthesize an oversized log: 60K records is plenty to cross the
    // 5MB compaction threshold (record size ~ 250B). Half are 2 years
    // old (must be dropped), half are recent (must be kept). The
    // bucketing matters because compaction triggers on the NEXT
    // append after the file grows past the threshold.
    const TWO_YEARS_AGO = Date.now() - 730 * 24 * 60 * 60 * 1000;
    const RECENT = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const lines: string[] = [];
    for (let i = 0; i < 30_000; i++) {
      lines.push(
        JSON.stringify({
          ts: TWO_YEARS_AGO + i,
          session: "old",
          model: "deepseek-v4-flash",
          promptTokens: 100,
          completionTokens: 20,
          cacheHitTokens: 80,
          cacheMissTokens: 20,
          costUsd: 0.0001,
          claudeEquivUsd: 0.001,
        }),
      );
      lines.push(
        JSON.stringify({
          ts: RECENT + i,
          session: "new",
          model: "deepseek-v4-flash",
          promptTokens: 100,
          completionTokens: 20,
          cacheHitTokens: 80,
          cacheMissTokens: 20,
          costUsd: 0.0001,
          claudeEquivUsd: 0.001,
        }),
      );
    }
    appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
    // Trigger compaction by appending one fresh record — appendUsage
    // checks size after writing.
    appendUsage({ session: "trigger", model: "deepseek-v4-flash", usage: usage(), path });
    const records = readUsageLog(path);
    // Old records must be gone, recent records preserved, plus the
    // fresh trigger record.
    expect(records.every((r) => r.ts >= TWO_YEARS_AGO + 30_000)).toBe(true);
    expect(records.some((r) => r.session === "new")).toBe(true);
    expect(records.some((r) => r.session === "trigger")).toBe(true);
    expect(records.some((r) => r.session === "old")).toBe(false);
  });

  it("swallows write failure silently (best-effort contract)", () => {
    // Point at a path under a FILE, not a directory — mkdirSync will
    // blow up and appendUsage should absorb it without throwing.
    const blocker = join(dir, "blocker");
    appendFileSync(blocker, "not a dir");
    expect(() =>
      appendUsage({
        session: null,
        model: "deepseek-chat",
        usage: usage(),
        path: join(blocker, "usage.jsonl"),
      }),
    ).not.toThrow();
  });
});

describe("aggregateUsage", () => {
  const NOW = 1_700_000_000_000; // fixed epoch for all windows below
  const DAY = 24 * 60 * 60 * 1000;

  function rec(partial: Partial<UsageRecord> & { ts: number }): UsageRecord {
    return {
      session: null,
      model: "deepseek-reasoner",
      promptTokens: 100,
      completionTokens: 20,
      cacheHitTokens: 80,
      cacheMissTokens: 20,
      costUsd: 0.001,
      claudeEquivUsd: 0.01,
      ...partial,
    };
  }

  it("empty input → empty buckets, null firstSeen/lastSeen", () => {
    const agg = aggregateUsage([], { now: NOW });
    expect(agg.buckets.map((b) => b.turns)).toEqual([0, 0, 0, 0]);
    expect(agg.firstSeen).toBeNull();
    expect(agg.lastSeen).toBeNull();
  });

  it("rolls records into today / week / month / all by age", () => {
    const records = [
      rec({ ts: NOW - 60_000 }), // 1 min ago → today
      rec({ ts: NOW - 2 * DAY }), // 2 days ago → week + month + all
      rec({ ts: NOW - 10 * DAY }), // 10 days → month + all
      rec({ ts: NOW - 90 * DAY }), // 90 days → only all-time
    ];
    const agg = aggregateUsage(records, { now: NOW });
    const [today, week, month, all] = agg.buckets;
    expect(today?.turns).toBe(1);
    expect(week?.turns).toBe(2);
    expect(month?.turns).toBe(3);
    expect(all?.turns).toBe(4);
  });

  it("sums token + cost fields across records in each window", () => {
    const records = [
      rec({
        ts: NOW - 60_000,
        costUsd: 0.5,
        claudeEquivUsd: 5,
        cacheHitTokens: 1,
        cacheMissTokens: 0,
      }),
      rec({
        ts: NOW - 60_001,
        costUsd: 0.25,
        claudeEquivUsd: 2,
        cacheHitTokens: 1,
        cacheMissTokens: 1,
      }),
    ];
    const agg = aggregateUsage(records, { now: NOW });
    const today = agg.buckets[0];
    expect(today?.costUsd).toBeCloseTo(0.75);
    expect(today?.claudeEquivUsd).toBeCloseTo(7);
    expect(today?.cacheHitTokens).toBe(2);
    expect(today?.cacheMissTokens).toBe(1);
  });

  it("byModel + bySession sort descending and group nulls under (ephemeral)", () => {
    const records = [
      rec({ ts: NOW - 60_000, model: "deepseek-chat", session: "a" }),
      rec({ ts: NOW - 60_000, model: "deepseek-reasoner", session: "a" }),
      rec({ ts: NOW - 60_000, model: "deepseek-reasoner", session: "b" }),
      rec({ ts: NOW - 60_000, model: "deepseek-reasoner", session: null }),
    ];
    const agg = aggregateUsage(records, { now: NOW });
    expect(agg.byModel[0]?.model).toBe("deepseek-reasoner");
    expect(agg.byModel[0]?.turns).toBe(3);
    expect(agg.bySession[0]?.session).toBe("a");
    expect(agg.bySession.find((s) => s.session === "(ephemeral)")?.turns).toBe(1);
  });
});

describe("bucket helpers", () => {
  it("cache hit ratio — zero denominator → 0", () => {
    const b = aggregateUsage([], { now: 1 }).buckets[0]!;
    expect(bucketCacheHitRatio(b)).toBe(0);
  });

  it("cache hit ratio — 80 hit / 20 miss → 0.8", () => {
    const agg = aggregateUsage(
      [
        {
          ts: 1_700_000_000_000,
          session: null,
          model: "deepseek-chat",
          promptTokens: 100,
          completionTokens: 0,
          cacheHitTokens: 80,
          cacheMissTokens: 20,
          costUsd: 0,
          claudeEquivUsd: 0,
        },
      ],
      { now: 1_700_000_000_000 },
    );
    const today = agg.buckets[0]!;
    expect(bucketCacheHitRatio(today)).toBeCloseTo(0.8);
  });

  it("savings fraction — zero Claude cost → 0 (no division)", () => {
    const b = aggregateUsage([], { now: 1 }).buckets[0]!;
    expect(bucketSavingsFraction(b)).toBe(0);
  });

  it("savings fraction — cost $1 vs Claude $10 → 0.9", () => {
    const agg = aggregateUsage(
      [
        {
          ts: 1_700_000_000_000,
          session: null,
          model: "deepseek-chat",
          promptTokens: 0,
          completionTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          costUsd: 1,
          claudeEquivUsd: 10,
        },
      ],
      { now: 1_700_000_000_000 },
    );
    expect(bucketSavingsFraction(agg.buckets[0]!)).toBeCloseTo(0.9);
  });

  it("cacheSavingsUsd accumulates per-record from current pricing", () => {
    // 1000 hit tokens on chat → savings = 1000 * (miss - hit) / 1e6.
    // We don't bake the constant; we trust the helper covered in
    // telemetry.test.ts and just assert the bucket sums two records.
    const agg = aggregateUsage(
      [
        {
          ts: 1_700_000_000_000,
          session: null,
          model: "deepseek-chat",
          promptTokens: 1000,
          completionTokens: 0,
          cacheHitTokens: 1000,
          cacheMissTokens: 0,
          costUsd: 0,
          claudeEquivUsd: 0,
        },
        {
          ts: 1_700_000_000_000 - 60_000,
          session: null,
          model: "deepseek-chat",
          promptTokens: 500,
          completionTokens: 0,
          cacheHitTokens: 500,
          cacheMissTokens: 0,
          costUsd: 0,
          claudeEquivUsd: 0,
        },
      ],
      { now: 1_700_000_000_000 },
    );
    const today = agg.buckets[0]!;
    // Two records, same model, 1500 hit tokens total.
    expect(today.cacheSavingsUsd).toBeGreaterThan(0);
    // Adding the savings for 1500 hit tokens of one record at the same
    // model should match the sum.
    const single = aggregateUsage(
      [
        {
          ts: 1_700_000_000_000,
          session: null,
          model: "deepseek-chat",
          promptTokens: 1500,
          completionTokens: 0,
          cacheHitTokens: 1500,
          cacheMissTokens: 0,
          costUsd: 0,
          claudeEquivUsd: 0,
        },
      ],
      { now: 1_700_000_000_000 },
    );
    expect(today.cacheSavingsUsd).toBeCloseTo(single.buckets[0]!.cacheSavingsUsd, 12);
  });

  it("cacheSavingsUsd is zero when nothing hit the cache", () => {
    const agg = aggregateUsage(
      [
        {
          ts: 1_700_000_000_000,
          session: null,
          model: "deepseek-chat",
          promptTokens: 100,
          completionTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 100,
          costUsd: 0,
          claudeEquivUsd: 0,
        },
      ],
      { now: 1_700_000_000_000 },
    );
    expect(agg.buckets[0]!.cacheSavingsUsd).toBe(0);
  });
});

describe("renderDashboard", () => {
  it("includes the four window labels + header", () => {
    const agg = aggregateUsage(
      [
        {
          ts: 1_700_000_000_000,
          session: "s",
          model: "deepseek-reasoner",
          promptTokens: 1,
          completionTokens: 1,
          cacheHitTokens: 1,
          cacheMissTokens: 0,
          costUsd: 0.001,
          claudeEquivUsd: 0.1,
        },
      ],
      { now: 1_700_000_000_000 },
    );
    const out = renderDashboard(agg, "/tmp/fake.jsonl");
    expect(out).toContain("today");
    expect(out).toContain("week");
    expect(out).toContain("month");
    expect(out).toContain("all-time");
    expect(out).toContain("cache hit");
    expect(out).toContain("cache saved");
    expect(out).toContain("vs Claude");
    expect(out).toContain("most used model:");
    expect(out).toContain("top session:");
    expect(out).toContain("tracked since:");
  });

  it("surfaces a subagent activity section when subagent records are present", () => {
    const agg = aggregateUsage(
      [
        {
          ts: 1_700_000_000_000,
          session: "s",
          model: "deepseek-chat",
          promptTokens: 500,
          completionTokens: 60,
          cacheHitTokens: 400,
          cacheMissTokens: 100,
          costUsd: 0.002,
          claudeEquivUsd: 0.02,
          kind: "subagent",
          subagent: {
            skillName: "explore",
            taskPreview: "find foo",
            toolIters: 3,
            durationMs: 2_500,
          },
        },
        {
          ts: 1_700_000_000_000,
          session: "s",
          model: "deepseek-chat",
          promptTokens: 200,
          completionTokens: 30,
          cacheHitTokens: 100,
          cacheMissTokens: 100,
          costUsd: 0.0015,
          claudeEquivUsd: 0.015,
          kind: "subagent",
          subagent: {
            skillName: "explore",
            taskPreview: "find bar",
            toolIters: 2,
            durationMs: 1_500,
          },
        },
      ],
      { now: 1_700_000_000_000 },
    );
    expect(agg.subagents?.total).toBe(2);
    expect(agg.subagents?.bySkill[0]?.skillName).toBe("explore");
    expect(agg.subagents?.bySkill[0]?.count).toBe(2);
    const out = renderDashboard(agg, "/tmp/fake.jsonl");
    expect(out).toContain("subagent activity:");
    expect(out).toContain("explore");
    expect(out).toContain("2 run");
  });

  it("groups subagent records without a skillName under (adhoc)", () => {
    const agg = aggregateUsage(
      [
        {
          ts: 1_700_000_000_000,
          session: null,
          model: "deepseek-chat",
          promptTokens: 10,
          completionTokens: 2,
          cacheHitTokens: 0,
          cacheMissTokens: 10,
          costUsd: 0.001,
          claudeEquivUsd: 0.01,
          kind: "subagent",
          subagent: { taskPreview: "raw call", toolIters: 1, durationMs: 500 },
        },
      ],
      { now: 1_700_000_000_000 },
    );
    expect(agg.subagents?.bySkill[0]?.skillName).toBe("(adhoc)");
  });

  it("includes subagent cost in the main buckets (it's real spend)", () => {
    const agg = aggregateUsage(
      [
        {
          ts: 1_700_000_000_000 - 60_000,
          session: "s",
          model: "deepseek-chat",
          promptTokens: 0,
          completionTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          costUsd: 0.5,
          claudeEquivUsd: 5,
          kind: "subagent",
          subagent: { skillName: "explore", taskPreview: "x", toolIters: 1, durationMs: 100 },
        },
      ],
      { now: 1_700_000_000_000 },
    );
    expect(agg.buckets[0]?.costUsd).toBeCloseTo(0.5);
    expect(agg.buckets[0]?.turns).toBe(1);
  });

  it("renders em-dashes for empty buckets rather than $0.000000", () => {
    const agg = aggregateUsage(
      [
        {
          ts: 1_700_000_000_000 - 365 * 24 * 60 * 60 * 1000,
          session: null,
          model: "deepseek-chat",
          promptTokens: 1,
          completionTokens: 1,
          cacheHitTokens: 1,
          cacheMissTokens: 0,
          costUsd: 0.001,
          claudeEquivUsd: 0.01,
        },
      ],
      { now: 1_700_000_000_000 },
    );
    const out = renderDashboard(agg, "/tmp/fake.jsonl");
    // today / week / month should all be empty because the only record
    // is a year old. The all-time row still has a cost.
    // Each em-dash represents an empty cell.
    const emDashCount = (out.match(/—/g) ?? []).length;
    expect(emDashCount).toBeGreaterThan(0);
  });
});
