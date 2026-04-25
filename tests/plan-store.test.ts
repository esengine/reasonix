/**
 * plan-store — load/save the structured plan state next to the
 * session JSONL log so plans survive terminal restarts. Tests cover
 * the roundtrip, malformed-file recovery, and the relativeTime
 * helper that powers the resume notice.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function writeFixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
import {
  archivePlanState,
  clearPlanState,
  loadPlanState,
  planStatePath,
  relativeTime,
  savePlanState,
} from "../src/code/plan-store.js";

// We point the test at a temp HOME so the real ~/.reasonix isn't
// touched. sessionsDir() reads homedir() via os, which honors HOME on
// POSIX and USERPROFILE on Windows. Setting both keeps the test
// portable across the matrix.
let tempHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "reasonix-plan-store-"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("plan-store roundtrip", () => {
  it("returns null when no plan file exists", () => {
    expect(loadPlanState("never-touched")).toBeNull();
  });

  it("save then load preserves steps + completed ids", () => {
    const steps = [
      { id: "step-1", title: "extract", action: "split tokens", risk: "low" as const },
      { id: "step-2", title: "rewire", action: "wire middleware", risk: "med" as const },
    ];
    savePlanState("test-session", steps, ["step-1"]);
    const loaded = loadPlanState("test-session");
    expect(loaded).not.toBeNull();
    expect(loaded?.steps).toEqual(steps);
    expect(loaded?.completedStepIds).toEqual(["step-1"]);
    expect(loaded?.version).toBe(1);
    expect(typeof loaded?.updatedAt).toBe("string");
  });

  it("clearPlanState removes the file", () => {
    savePlanState("test", [{ id: "x", title: "y", action: "z" }], []);
    expect(loadPlanState("test")).not.toBeNull();
    clearPlanState("test");
    expect(loadPlanState("test")).toBeNull();
  });

  it("clearPlanState is a no-op when no file exists", () => {
    expect(() => clearPlanState("nonexistent")).not.toThrow();
  });

  it("returns null on malformed JSON", () => {
    writeFixture(planStatePath("broken"), "not json {");
    expect(loadPlanState("broken")).toBeNull();
  });

  it("returns null on wrong version", () => {
    writeFixture(
      planStatePath("v0"),
      JSON.stringify({ version: 0, steps: [], completedStepIds: [], updatedAt: "x" }),
    );
    expect(loadPlanState("v0")).toBeNull();
  });

  it("filters out malformed step entries", () => {
    writeFixture(
      planStatePath("partial"),
      JSON.stringify({
        version: 1,
        steps: [
          { id: "ok", title: "good", action: "do" },
          { id: "", title: "no id", action: "x" },
          { id: "bad", title: "", action: "x" },
          null,
          "not-an-object",
          { id: "ok-2", title: "also good", action: "do2" },
        ],
        completedStepIds: ["ok"],
        updatedAt: new Date().toISOString(),
      }),
    );
    const loaded = loadPlanState("partial");
    expect(loaded?.steps).toHaveLength(2);
    expect(loaded?.steps.map((s) => s.id)).toEqual(["ok", "ok-2"]);
  });

  it("returns null when sanitization leaves zero steps (empty plan is no plan)", () => {
    writeFixture(
      planStatePath("emptied"),
      JSON.stringify({
        version: 1,
        steps: [{ id: "", title: "", action: "" }],
        completedStepIds: [],
        updatedAt: new Date().toISOString(),
      }),
    );
    expect(loadPlanState("emptied")).toBeNull();
  });

  it("strips invalid risk values rather than failing the whole file", () => {
    writeFixture(
      planStatePath("riskcheck"),
      JSON.stringify({
        version: 1,
        steps: [
          { id: "a", title: "t", action: "a", risk: "critical" },
          { id: "b", title: "t", action: "a", risk: "low" },
        ],
        completedStepIds: [],
        updatedAt: new Date().toISOString(),
      }),
    );
    const loaded = loadPlanState("riskcheck");
    expect(loaded?.steps[0]?.risk).toBeUndefined();
    expect(loaded?.steps[1]?.risk).toBe("low");
  });

  it("filters out non-string entries from completedStepIds", () => {
    writeFixture(
      planStatePath("badcompleted"),
      JSON.stringify({
        version: 1,
        steps: [{ id: "x", title: "y", action: "z" }],
        completedStepIds: ["x", null, 42, "", "y"],
        updatedAt: new Date().toISOString(),
      }),
    );
    const loaded = loadPlanState("badcompleted");
    expect(loaded?.completedStepIds).toEqual(["x", "y"]);
  });

  it("sanitizes session names so unsafe chars don't escape the dir", () => {
    const path = planStatePath("../etc/passwd");
    expect(path).toMatch(/\.plan\.json$/);
    expect(path).not.toMatch(/\.\.[\\/]etc/);
  });
});

describe("archivePlanState", () => {
  it("returns null when no active plan exists", () => {
    expect(archivePlanState("never-touched")).toBeNull();
  });

  it("renames the active plan to a timestamped .done.json", () => {
    savePlanState("done-test", [{ id: "x", title: "y", action: "z" }], ["x"]);
    const before = loadPlanState("done-test");
    expect(before).not.toBeNull();
    const archive = archivePlanState("done-test");
    expect(archive).not.toBeNull();
    expect(archive).toMatch(/\.done\.json$/);
    // Active plan is gone after archive
    expect(loadPlanState("done-test")).toBeNull();
  });

  it("preserves the original payload in the archive", async () => {
    const steps = [
      { id: "step-1", title: "extract", action: "split tokens", risk: "med" as const },
    ];
    savePlanState("payload-test", steps, ["step-1"]);
    const archive = archivePlanState("payload-test");
    expect(archive).not.toBeNull();
    const fs = await import("node:fs");
    const raw = fs.readFileSync(archive!, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.steps).toEqual(steps);
    expect(parsed.completedStepIds).toEqual(["step-1"]);
    expect(parsed.version).toBe(1);
  });

  it("two archives within the same millisecond don't collide", () => {
    // Random suffix prevents filename collision when consecutive
    // mark_step_complete calls finalize a plan and immediately a new
    // submit_plan + complete cycle archives again. Hard to literally
    // race in a test; we settle for archiving twice rapidly and
    // checking we got two different paths.
    savePlanState("race-1", [{ id: "x", title: "y", action: "z" }], ["x"]);
    const a = archivePlanState("race-1");
    savePlanState("race-1", [{ id: "x", title: "y", action: "z" }], ["x"]);
    const b = archivePlanState("race-1");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

describe("relativeTime", () => {
  const NOW = Date.parse("2026-04-24T12:00:00.000Z");

  it("renders sub-minute as seconds", () => {
    expect(relativeTime("2026-04-24T11:59:30.000Z", NOW)).toBe("30s ago");
    expect(relativeTime("2026-04-24T12:00:00.000Z", NOW)).toBe("0s ago");
  });

  it("renders minutes / hours / days", () => {
    expect(relativeTime("2026-04-24T11:55:00.000Z", NOW)).toBe("5m ago");
    expect(relativeTime("2026-04-24T10:00:00.000Z", NOW)).toBe("2h ago");
    expect(relativeTime("2026-04-22T12:00:00.000Z", NOW)).toBe("2d ago");
  });

  it("falls back to date-only for >7 days", () => {
    expect(relativeTime("2026-04-01T12:00:00.000Z", NOW)).toBe("2026-04-01");
  });

  it("returns the raw string for unparseable input", () => {
    expect(relativeTime("not a date", NOW)).toBe("not a date");
  });
});
