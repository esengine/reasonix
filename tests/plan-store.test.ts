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
  listPlanArchives,
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

  it("round-trips optional body + summary when supplied", () => {
    savePlanState("with-extras", [{ id: "x", title: "y", action: "z" }], [], {
      body: "# Plan\n- do thing",
      summary: "Refactor foo into bar",
    });
    const loaded = loadPlanState("with-extras");
    expect(loaded?.body).toBe("# Plan\n- do thing");
    expect(loaded?.summary).toBe("Refactor foo into bar");
  });

  it("omits body / summary when not supplied (keeps older plans clean)", () => {
    savePlanState("no-extras", [{ id: "x", title: "y", action: "z" }], []);
    const loaded = loadPlanState("no-extras");
    expect(loaded?.body).toBeUndefined();
    expect(loaded?.summary).toBeUndefined();
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

  it("loadPlanState returns the plan even with no session messages (orphaned plan file)", () => {
    // Bug: when a session is wiped (--new, /forget, session picker
    // "new"/"delete") the plan-state sidecar was historically NOT
    // cleaned up.  On next launch loadPlanState would find the stale
    // file and the UI would show a spurious "RESUMED PLAN" banner.
    // This test documents that loadPlanState itself has no guard
    // against the orphan — the fix lives in the session-wipe paths
    // (deleteSession, rewriteSession callers) that must clear the
    // plan file proactively.
    savePlanState("orphan", [{ id: "s1", title: "t", action: "a" }], []);
    // Simulate: the session JSONL is empty / doesn't exist, but the
    // plan file was left behind.
    expect(loadPlanState("orphan")).not.toBeNull();
    // After clearPlanState (simulating the fix in the wipe paths),
    // the orphan is gone.
    clearPlanState("orphan");
    expect(loadPlanState("orphan")).toBeNull();
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

describe("listPlanArchives", () => {
  it("returns empty when no archives exist", () => {
    expect(listPlanArchives("nothing-here")).toEqual([]);
  });

  it("lists archived plans newest-first by completedAt", async () => {
    // Two plans for the same session, archived ~milliseconds apart.
    // Force completedAt by hand-writing instead of going through
    // savePlanState so timing isn't a flaky factor.
    const oldStamp = "2026-04-01T10:00:00.000Z";
    const newStamp = "2026-04-20T15:30:00.000Z";
    const fs = await import("node:fs");
    const { join: pj } = await import("node:path");
    const dir = pj(tempHome, ".reasonix", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      pj(dir, "test-list.plan.2026-04-01-old.done.json"),
      JSON.stringify({
        version: 1,
        steps: [{ id: "x", title: "y", action: "z" }],
        completedStepIds: ["x"],
        updatedAt: oldStamp,
      }),
    );
    fs.writeFileSync(
      pj(dir, "test-list.plan.2026-04-20-new.done.json"),
      JSON.stringify({
        version: 1,
        steps: [
          { id: "a", title: "b", action: "c" },
          { id: "d", title: "e", action: "f" },
        ],
        completedStepIds: ["a", "d"],
        updatedAt: newStamp,
      }),
    );
    const archives = listPlanArchives("test-list");
    expect(archives).toHaveLength(2);
    expect(archives[0]?.completedAt).toBe(newStamp);
    expect(archives[1]?.completedAt).toBe(oldStamp);
    expect(archives[0]?.steps).toHaveLength(2);
  });

  it("ignores active plan.json (only .done.json files count)", () => {
    savePlanState("active-only", [{ id: "x", title: "y", action: "z" }], []);
    expect(listPlanArchives("active-only")).toEqual([]);
  });

  it("does NOT cross sessions — each project sees its own archives", async () => {
    const fs = await import("node:fs");
    const { join: pj } = await import("node:path");
    const dir = pj(tempHome, ".reasonix", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      pj(dir, "project-a.plan.2026-04-01-x.done.json"),
      JSON.stringify({
        version: 1,
        steps: [{ id: "x", title: "y", action: "z" }],
        completedStepIds: [],
        updatedAt: "2026-04-01T10:00:00.000Z",
      }),
    );
    fs.writeFileSync(
      pj(dir, "project-b.plan.2026-04-02-y.done.json"),
      JSON.stringify({
        version: 1,
        steps: [{ id: "x", title: "y", action: "z" }],
        completedStepIds: [],
        updatedAt: "2026-04-02T10:00:00.000Z",
      }),
    );
    expect(listPlanArchives("project-a")).toHaveLength(1);
    expect(listPlanArchives("project-b")).toHaveLength(1);
  });

  it("skips corrupt archives without failing the whole list", async () => {
    const fs = await import("node:fs");
    const { join: pj } = await import("node:path");
    const dir = pj(tempHome, ".reasonix", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    // One good, one malformed JSON, one wrong-version, one zero-steps.
    fs.writeFileSync(
      pj(dir, "robust.plan.2026-01-good.done.json"),
      JSON.stringify({
        version: 1,
        steps: [{ id: "x", title: "y", action: "z" }],
        completedStepIds: [],
        updatedAt: "2026-01-15T00:00:00.000Z",
      }),
    );
    fs.writeFileSync(pj(dir, "robust.plan.2026-01-bad-json.done.json"), "{ not json");
    fs.writeFileSync(
      pj(dir, "robust.plan.2026-01-bad-version.done.json"),
      JSON.stringify({ version: 99, steps: [], completedStepIds: [] }),
    );
    fs.writeFileSync(
      pj(dir, "robust.plan.2026-01-empty.done.json"),
      JSON.stringify({
        version: 1,
        steps: [],
        completedStepIds: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const archives = listPlanArchives("robust");
    expect(archives).toHaveLength(1);
    expect(archives[0]?.steps).toHaveLength(1);
  });

  it("falls back to mtime when updatedAt is missing or unparseable", async () => {
    const fs = await import("node:fs");
    const { join: pj } = await import("node:path");
    const dir = pj(tempHome, ".reasonix", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    // Archive without updatedAt should still surface, dated by mtime.
    fs.writeFileSync(
      pj(dir, "fallback.plan.2026-01-x.done.json"),
      JSON.stringify({
        version: 1,
        steps: [{ id: "x", title: "y", action: "z" }],
        completedStepIds: [],
        // updatedAt deliberately omitted
      }),
    );
    const archives = listPlanArchives("fallback");
    expect(archives).toHaveLength(1);
    // Should be a valid ISO timestamp (mtime fallback) — not empty
    expect(archives[0]?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
