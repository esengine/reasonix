import { aggregateUsage, bucketCacheHitRatio, readUsageLog } from "../../telemetry/usage.js";
import type { DashboardContext, DashboardStats } from "../context.js";

export interface CockpitKpi {
  total: number;
  deltaPct: number | null;
}

export interface CockpitCacheKpi {
  ratio: number;
  deltaPp: number | null;
}

export interface CockpitDailyCost {
  date: string;
  usd: number;
}

export interface CockpitCurrentSession {
  id: string;
  turns: number;
  totalCostUsd: number;
  lastPromptTokens: number;
  completionTokens: number;
}

export interface CockpitData {
  balance: { currency: string; total: string } | null;
  tokens7d: CockpitKpi | null;
  cacheHit7d: CockpitCacheKpi | null;
  costTrend14d: ReadonlyArray<CockpitDailyCost> | null;
  currentSession: CockpitCurrentSession | null;
}

const TTL_MS = 30_000;

interface CacheEntry {
  ts: number;
  data: Pick<CockpitData, "tokens7d" | "cacheHit7d" | "costTrend14d">;
}

const cache = new Map<string, CacheEntry>();

export function _resetCockpitCacheForTests(): void {
  cache.clear();
}

export function computeCockpit(ctx: DashboardContext, now: number = Date.now()): CockpitData {
  return {
    balance: extractBalance(ctx.getStats?.() ?? null),
    currentSession: extractCurrentSession(ctx),
    ...readWarmCached(ctx.usageLogPath, now),
  };
}

function extractBalance(stats: DashboardStats | null): CockpitData["balance"] {
  const first = stats?.balance?.[0];
  if (!first) return null;
  return { currency: first.currency, total: first.total_balance };
}

function extractCurrentSession(ctx: DashboardContext): CockpitData["currentSession"] {
  const id = ctx.getSessionName?.() ?? null;
  const stats = ctx.getStats?.() ?? null;
  const loop = ctx.loop;
  if (!id || !stats || !loop) return null;
  let completion = 0;
  for (const t of loop.stats.turns) completion += t.usage.completionTokens;
  return {
    id,
    turns: stats.turns,
    totalCostUsd: stats.totalCostUsd,
    lastPromptTokens: stats.lastPromptTokens,
    completionTokens: completion,
  };
}

function readWarmCached(
  usageLogPath: string,
  now: number,
): Pick<CockpitData, "tokens7d" | "cacheHit7d" | "costTrend14d"> {
  const hit = cache.get(usageLogPath);
  if (hit && now - hit.ts < TTL_MS) return hit.data;
  const data = computeWarm(usageLogPath, now);
  cache.set(usageLogPath, { ts: now, data });
  return data;
}

export function computeWarm(
  usageLogPath: string,
  now: number,
): Pick<CockpitData, "tokens7d" | "cacheHit7d" | "costTrend14d"> {
  const records = readUsageLog(usageLogPath);
  if (records.length === 0) {
    return { tokens7d: null, cacheHit7d: null, costTrend14d: null };
  }
  const week = aggregateUsage(records, { now }).buckets[1]!;
  const priorWeekRecords = records.filter(
    (r) => r.ts < week.since && r.ts >= week.since - 7 * 86_400_000,
  );
  const priorWeek = aggregateUsage(priorWeekRecords, { now: week.since }).buckets[1]!;

  const tokens7dTotal = week.promptTokens + week.completionTokens;
  const tokens7dPrior = priorWeek.promptTokens + priorWeek.completionTokens;
  const tokens7d: CockpitKpi = {
    total: tokens7dTotal,
    deltaPct: tokens7dPrior > 0 ? ((tokens7dTotal - tokens7dPrior) / tokens7dPrior) * 100 : null,
  };

  const cacheHitRatio = bucketCacheHitRatio(week);
  const cacheHit7d: CockpitCacheKpi = {
    ratio: cacheHitRatio,
    deltaPp:
      priorWeek.cacheHitTokens + priorWeek.cacheMissTokens > 0
        ? (cacheHitRatio - bucketCacheHitRatio(priorWeek)) * 100
        : null,
  };

  return { tokens7d, cacheHit7d, costTrend14d: rollupDailyCost(records, now, 14) };
}

function rollupDailyCost(
  records: ReadonlyArray<{ ts: number; costUsd: number }>,
  now: number,
  days: number,
): CockpitDailyCost[] {
  const since = now - days * 86_400_000;
  const buckets = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    buckets.set(localDateKey(now - i * 86_400_000), 0);
  }
  for (const r of records) {
    if (r.ts < since) continue;
    const key = localDateKey(r.ts);
    if (!buckets.has(key)) continue;
    buckets.set(key, (buckets.get(key) ?? 0) + r.costUsd);
  }
  return Array.from(buckets.entries())
    .map(([date, usd]) => ({ date, usd }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
