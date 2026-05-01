import { existsSync } from "node:fs";
import { readEventLogFile, recentEventFiles } from "../../adapters/event-source-jsonl.js";
import type { Event } from "../../core/events.js";
import { sessionsDir as defaultSessionsDir } from "../../memory/session.js";

export interface CockpitToolCallsKpi {
  total: number;
  delta: number | null;
}

export interface CockpitRecentPlan {
  id: string;
  title: string;
  totalSteps: number;
  completedSteps: number;
  status: "active" | "done";
  whenMs: number;
}

export interface CockpitToolFeedRow {
  name: string;
  args: string;
  level: "ok" | "warn" | "err";
  whenMs: number;
}

export interface EventsCockpit {
  toolCalls24h: CockpitToolCallsKpi | null;
  recentPlans: ReadonlyArray<CockpitRecentPlan> | null;
  toolActivity: ReadonlyArray<CockpitToolFeedRow> | null;
}

const DAY_MS = 86_400_000;
const RECENT_FILES_CAP = 8;
const PLAN_FEED_CAP = 4;
const TOOL_FEED_CAP = 6;

export function computeEventsCockpit(
  now: number = Date.now(),
  sessionsDirOverride?: string,
): EventsCockpit {
  const dir = sessionsDirOverride ?? defaultSessionsDir();
  if (!existsSync(dir)) {
    return { toolCalls24h: null, recentPlans: null, toolActivity: null };
  }
  const files = recentEventFiles(dir, now, RECENT_FILES_CAP);
  if (files.length === 0) {
    return { toolCalls24h: null, recentPlans: null, toolActivity: null };
  }

  let calls24h = 0;
  let callsPrior24h = 0;
  const cutoff24h = now - DAY_MS;
  const cutoff48h = now - 2 * DAY_MS;
  const allTools: CockpitToolFeedRow[] = [];
  const allPlans: CockpitRecentPlan[] = [];

  for (const file of files) {
    const events = readEventLogFile(file);
    if (events.length === 0) continue;
    countToolCalls(events, cutoff24h, cutoff48h, (in24h) => {
      if (in24h) calls24h++;
      else callsPrior24h++;
    });
    collectToolActivity(events, allTools);
    collectPlans(events, allPlans);
  }

  allTools.sort((a, b) => b.whenMs - a.whenMs);
  allPlans.sort((a, b) => b.whenMs - a.whenMs);

  return {
    toolCalls24h: { total: calls24h, delta: calls24h - callsPrior24h },
    recentPlans: allPlans.slice(0, PLAN_FEED_CAP),
    toolActivity: allTools.slice(0, TOOL_FEED_CAP),
  };
}

function countToolCalls(
  events: ReadonlyArray<Event>,
  cutoff24h: number,
  cutoff48h: number,
  onCall: (in24h: boolean) => void,
): void {
  for (const ev of events) {
    if (ev.type !== "tool.intent") continue;
    const ts = parseTs(ev.ts);
    if (ts === null) continue;
    if (ts >= cutoff24h) onCall(true);
    else if (ts >= cutoff48h) onCall(false);
  }
}

function collectToolActivity(events: ReadonlyArray<Event>, into: CockpitToolFeedRow[]): void {
  const intentByCallId = new Map<string, { name: string; args: string; ts: number }>();
  for (const ev of events) {
    if (ev.type === "tool.intent") {
      const ts = parseTs(ev.ts);
      if (ts !== null) intentByCallId.set(ev.callId, { name: ev.name, args: ev.args, ts });
    } else if (ev.type === "tool.result") {
      const intent = intentByCallId.get(ev.callId);
      if (!intent) continue;
      into.push({
        name: intent.name,
        args: summarizeArgs(intent.args),
        level: ev.ok ? "ok" : "err",
        whenMs: intent.ts,
      });
    } else if (ev.type === "tool.denied") {
      const intent = intentByCallId.get(ev.callId);
      if (!intent) continue;
      into.push({
        name: intent.name,
        args: summarizeArgs(intent.args),
        level: "warn",
        whenMs: intent.ts,
      });
    }
  }
}

function collectPlans(events: ReadonlyArray<Event>, into: CockpitRecentPlan[]): void {
  let current: { id: string; title: string; totalSteps: number; whenMs: number } | null = null;
  let completed = new Set<string>();
  for (const ev of events) {
    if (ev.type === "plan.submitted") {
      if (current) {
        into.push(buildPlan(current, completed));
      }
      const ts = parseTs(ev.ts);
      if (ts === null) {
        current = null;
        continue;
      }
      current = {
        id: `${ev.id}`,
        title: planTitle(ev.body, ev.steps),
        totalSteps: ev.steps.length,
        whenMs: ts,
      };
      completed = new Set();
    } else if (ev.type === "plan.step.completed") {
      if (!current) continue;
      completed.add(ev.stepId);
    }
  }
  if (current) into.push(buildPlan(current, completed));
}

function buildPlan(
  current: { id: string; title: string; totalSteps: number; whenMs: number },
  completed: Set<string>,
): CockpitRecentPlan {
  return {
    id: current.id,
    title: current.title,
    totalSteps: current.totalSteps,
    completedSteps: completed.size,
    status: completed.size >= current.totalSteps && current.totalSteps > 0 ? "done" : "active",
    whenMs: current.whenMs,
  };
}

function planTitle(body: string, steps: ReadonlyArray<{ title: string }>): string {
  const firstBodyLine = body.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (firstBodyLine)
    return firstBodyLine
      .replace(/^#+\s*/, "")
      .trim()
      .slice(0, 80);
  if (steps.length > 0 && steps[0]) return steps[0].title.slice(0, 80);
  return "(plan)";
}

function summarizeArgs(args: string): string {
  if (!args) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args.slice(0, 60);
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const path = obj.path ?? obj.file_path ?? obj.filename;
    const command = obj.command;
    if (typeof command === "string")
      return command.length > 60 ? `${command.slice(0, 60)}…` : command;
    if (typeof path === "string") return path;
  }
  return args.slice(0, 60);
}

function parseTs(ts: string): number | null {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}
