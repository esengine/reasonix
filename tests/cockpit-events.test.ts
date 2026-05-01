import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeEventsCockpit } from "../src/server/api/cockpit-events.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

interface MakeEventsArgs {
  toolIntents?: Array<{ ts: number; callId: string; name: string; args?: string }>;
  toolResults?: Array<{ ts: number; callId: string; ok: boolean }>;
  toolDenies?: Array<{ ts: number; callId: string }>;
  planSubmissions?: Array<{
    ts: number;
    id: number;
    body: string;
    steps: Array<{ id: string; title: string }>;
  }>;
  stepCompletions?: Array<{ ts: number; stepId: string }>;
}

function eventLines(args: MakeEventsArgs): string {
  const lines: string[] = [];
  let id = 1;
  for (const i of args.toolIntents ?? []) {
    lines.push(
      JSON.stringify({
        id: id++,
        ts: isoAt(i.ts),
        turn: 1,
        type: "tool.intent",
        callId: i.callId,
        name: i.name,
        args: i.args ?? "{}",
      }),
    );
  }
  for (const r of args.toolResults ?? []) {
    lines.push(
      JSON.stringify({
        id: id++,
        ts: isoAt(r.ts),
        turn: 1,
        type: "tool.result",
        callId: r.callId,
        ok: r.ok,
        output: "",
        durationMs: 100,
      }),
    );
  }
  for (const d of args.toolDenies ?? []) {
    lines.push(
      JSON.stringify({
        id: id++,
        ts: isoAt(d.ts),
        turn: 1,
        type: "tool.denied",
        callId: d.callId,
        reason: "permission",
      }),
    );
  }
  for (const p of args.planSubmissions ?? []) {
    lines.push(
      JSON.stringify({
        id: p.id,
        ts: isoAt(p.ts),
        turn: 1,
        type: "plan.submitted",
        body: p.body,
        steps: p.steps.map((s) => ({ id: s.id, title: s.title, action: "" })),
      }),
    );
  }
  for (const c of args.stepCompletions ?? []) {
    lines.push(
      JSON.stringify({
        id: id++,
        ts: isoAt(c.ts),
        turn: 1,
        type: "plan.step.completed",
        stepId: c.stepId,
        completion: { kind: "ok" },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

describe("computeEventsCockpit", () => {
  let dir: string;
  let sessionsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rx-cockpit-events-"));
    sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSession(name: string, body: string): void {
    const path = join(sessionsDir, `${name}.events.jsonl`);
    writeFileSync(path, body);
  }

  it("returns nulls when sessionsDir doesn't exist", () => {
    const out = computeEventsCockpit(NOW, join(dir, "no-such-dir"));
    expect(out.toolCalls24h).toBeNull();
    expect(out.recentPlans).toBeNull();
    expect(out.toolActivity).toBeNull();
  });

  it("returns null fields when no event files are present", () => {
    const out = computeEventsCockpit(NOW, sessionsDir);
    expect(out.toolCalls24h).toBeNull();
  });

  it("counts tool.intent events in the trailing 24h", () => {
    writeSession(
      "s1",
      eventLines({
        toolIntents: [
          { ts: NOW - 1_000, callId: "c1", name: "run_command" },
          { ts: NOW - 12 * 60 * 60 * 1000, callId: "c2", name: "edit_file" },
          { ts: NOW - 26 * 60 * 60 * 1000, callId: "c3", name: "read_file" },
        ],
      }),
    );
    const out = computeEventsCockpit(NOW, sessionsDir);
    expect(out.toolCalls24h?.total).toBe(2);
  });

  it("computes delta vs the prior 24h window", () => {
    writeSession(
      "s1",
      eventLines({
        toolIntents: [
          { ts: NOW - 1_000, callId: "c1", name: "x" },
          { ts: NOW - 12 * 3_600_000, callId: "c2", name: "x" },
          { ts: NOW - 30 * 3_600_000, callId: "c3", name: "x" },
        ],
      }),
    );
    const out = computeEventsCockpit(NOW, sessionsDir);
    expect(out.toolCalls24h?.total).toBe(2);
    expect(out.toolCalls24h?.delta).toBe(1);
  });

  it("surfaces recent tool activity newest-first with ok / err / warn levels", () => {
    writeSession(
      "s1",
      eventLines({
        toolIntents: [
          {
            ts: NOW - 5_000,
            callId: "c1",
            name: "run_command",
            args: '{"command":"npm run build"}',
          },
          { ts: NOW - 4_000, callId: "c2", name: "edit_file", args: '{"path":"src/index.ts"}' },
          { ts: NOW - 3_000, callId: "c3", name: "shell", args: '{"command":"rm -rf"}' },
        ],
        toolResults: [
          { ts: NOW - 4_900, callId: "c1", ok: true },
          { ts: NOW - 3_900, callId: "c2", ok: false },
        ],
        toolDenies: [{ ts: NOW - 2_900, callId: "c3" }],
      }),
    );
    const out = computeEventsCockpit(NOW, sessionsDir);
    expect(out.toolActivity).toHaveLength(3);
    expect(out.toolActivity![0]!.name).toBe("shell");
    expect(out.toolActivity![0]!.level).toBe("warn");
    expect(out.toolActivity![1]!.level).toBe("err");
    expect(out.toolActivity![2]!.level).toBe("ok");
  });

  it("rolls up plans with completion ratio + done/active status", () => {
    writeSession(
      "s1",
      eventLines({
        planSubmissions: [
          {
            ts: NOW - 60_000,
            id: 100,
            body: "release 0.18.1",
            steps: [
              { id: "a", title: "tag" },
              { id: "b", title: "publish" },
            ],
          },
        ],
        stepCompletions: [
          { ts: NOW - 50_000, stepId: "a" },
          { ts: NOW - 40_000, stepId: "b" },
        ],
      }),
    );
    const out = computeEventsCockpit(NOW, sessionsDir);
    expect(out.recentPlans).toHaveLength(1);
    expect(out.recentPlans![0]!.title).toBe("release 0.18.1");
    expect(out.recentPlans![0]!.totalSteps).toBe(2);
    expect(out.recentPlans![0]!.completedSteps).toBe(2);
    expect(out.recentPlans![0]!.status).toBe("done");
  });

  it("marks a partially-completed plan as active", () => {
    writeSession(
      "s1",
      eventLines({
        planSubmissions: [
          {
            ts: NOW - 60_000,
            id: 100,
            body: "wip",
            steps: [
              { id: "a", title: "x" },
              { id: "b", title: "y" },
              { id: "c", title: "z" },
            ],
          },
        ],
        stepCompletions: [{ ts: NOW - 50_000, stepId: "a" }],
      }),
    );
    const out = computeEventsCockpit(NOW, sessionsDir);
    expect(out.recentPlans![0]!.status).toBe("active");
    expect(out.recentPlans![0]!.completedSteps).toBe(1);
  });

  it("aggregates tool calls across multiple session files", () => {
    writeSession(
      "s1",
      eventLines({
        toolIntents: [{ ts: NOW - 1_000, callId: "a", name: "x" }],
      }),
    );
    writeSession(
      "s2",
      eventLines({
        toolIntents: [{ ts: NOW - 2_000, callId: "b", name: "y" }],
      }),
    );
    const out = computeEventsCockpit(NOW, sessionsDir);
    expect(out.toolCalls24h?.total).toBe(2);
  });

  it("skips event files older than 30 days based on mtime", () => {
    writeSession(
      "stale",
      eventLines({
        toolIntents: [{ ts: NOW - 1_000, callId: "x", name: "should-not-count" }],
      }),
    );
    const stalePath = join(sessionsDir, "stale.events.jsonl");
    const ancient = (NOW - 31 * DAY) / 1000;
    utimesSync(stalePath, ancient, ancient);

    writeSession(
      "fresh",
      eventLines({
        toolIntents: [{ ts: NOW - 500, callId: "y", name: "should-count" }],
      }),
    );
    const out = computeEventsCockpit(NOW, sessionsDir);
    expect(out.toolCalls24h?.total).toBe(1);
  });
});
