/** JobRegistry — real spawn/pipe/kill via inline `node -e` scripts. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobRegistry } from "../src/tools/jobs.js";

describe("JobRegistry", () => {
  let cwd: string;
  let registry: JobRegistry;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "reasonix-job-"));
    registry = new JobRegistry();
  });
  afterEach(async () => {
    await registry.shutdown(1500);
    // Windows occasionally hangs on to the cwd handle for a few ms
    // after the child exits; a retry-with-delay catches that without
    // failing the suite when cleanup is a lost cause.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(cwd, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it("returns after waitSec for a process that stays alive", async () => {
    // Long-lived child that prints a line and sleeps 10s. We'll return
    // after waitSec=1 while it's still running.
    const cmd = `node -e "console.log('hi'); setTimeout(() => {}, 10000)"`;
    const t0 = Date.now();
    const res = await registry.start(cmd, { cwd, waitSec: 1 });
    const elapsed = Date.now() - t0;
    expect(res.stillRunning).toBe(true);
    expect(res.preview).toContain("hi");
    expect(elapsed).toBeGreaterThanOrEqual(900);
    // readiness pattern may or may not match "hi" depending on env;
    // the test's primary claim is "we came back without waiting 10s".
    expect(elapsed).toBeLessThan(3000);
  });

  it("short-circuits on ready signal before waitSec elapses", async () => {
    // Print a known ready banner immediately; waitSec=5 should be
    // cut short when the regex fires.
    const cmd = `node -e "console.log('listening on http://localhost:1234'); setTimeout(() => {}, 10000)"`;
    const t0 = Date.now();
    const res = await registry.start(cmd, { cwd, waitSec: 5 });
    const elapsed = Date.now() - t0;
    expect(res.stillRunning).toBe(true);
    expect(res.readyMatched).toBe(true);
    // Must be well under the 5s ceiling — startup + ready-regex match
    // should land in a few hundred ms at most.
    expect(elapsed).toBeLessThan(2500);
  });

  it("captures exit code when the child dies during wait", async () => {
    const cmd = `node -e "console.log('bye'); process.exit(7)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 3 });
    expect(res.stillRunning).toBe(false);
    expect(res.exitCode).toBe(7);
    expect(res.preview).toContain("bye");
  });

  it("read(jobId) returns live output and running flag", async () => {
    const cmd = `node -e "console.log('a'); setTimeout(() => console.log('b'), 80); setTimeout(() => {}, 10000)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 1.5 });
    let early = registry.read(res.jobId);
    for (let i = 0; i < 20 && !early?.output.includes("a"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      early = registry.read(res.jobId);
    }
    expect(early?.running).toBe(true);
    expect(early?.output).toContain("a");
    let later = registry.read(res.jobId);
    for (let i = 0; i < 20 && !later?.output.includes("b"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      later = registry.read(res.jobId);
    }
    expect(later?.output).toContain("b");
    expect((later?.byteLength ?? 0) >= (early?.byteLength ?? 0)).toBe(true);
  });

  it("read supports `since` for incremental polling", async () => {
    // `first` prints synchronously at child startup so snap catches it
    // reliably; `second` is delayed well past the waitSec ceiling so it
    // arrives AFTER the snapshot, guaranteeing the `since`-slice actually
    // has new bytes to return.
    const cmd = `node -e "console.log('first'); setTimeout(()=>console.log('second'), 1500); setTimeout(()=>{}, 10000)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 0.6 });
    // Poll briefly in case Windows node startup is slow — we need
    // `first` in the buffer before capturing the cursor, otherwise the
    // whole premise of the test falls apart.
    let snap = registry.read(res.jobId);
    for (let i = 0; i < 10 && !snap?.output.includes("first"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      snap = registry.read(res.jobId);
    }
    expect(snap?.output).toContain("first");
    expect(snap?.output).not.toContain("second");
    const cursor = snap?.byteLength ?? 0;
    expect(cursor).toBeGreaterThan(0);
    // Wait past the delayed print so we have new content.
    await new Promise((r) => setTimeout(r, 1800));
    const delta = registry.read(res.jobId, { since: cursor });
    expect(delta?.output).not.toContain("first");
    expect(delta?.output).toContain("second");
  });

  it("tailLines caps returned output to the last N lines", async () => {
    const cmd = `node -e "for (let i=0;i<50;i++) console.log('line'+i); setTimeout(()=>{}, 10000)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 0.5 });
    const tailed = registry.read(res.jobId, { tailLines: 5 });
    const lines = (tailed?.output ?? "").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(tailed?.output).toContain("line49");
    expect(tailed?.output).not.toContain("line0\n");
  });

  it("stop() kills a running job", async () => {
    const cmd = `node -e "setTimeout(()=>{}, 10000)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 0.2 });
    expect(res.stillRunning).toBe(true);
    const rec = await registry.stop(res.jobId, { graceMs: 200 });
    expect(rec?.running).toBe(false);
  });

  it("stop() on an already-exited job is idempotent", async () => {
    const cmd = `node -e "process.exit(0)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 2 });
    expect(res.stillRunning).toBe(false);
    const rec = await registry.stop(res.jobId);
    expect(rec?.running).toBe(false);
    expect(rec?.exitCode).toBe(0);
  });

  it("list() reports running and exited jobs together", async () => {
    const running = await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, {
      cwd,
      waitSec: 0.2,
    });
    const exited = await registry.start(`node -e "process.exit(0)"`, { cwd, waitSec: 2 });
    const rows = registry.list();
    expect(rows).toHaveLength(2);
    const r1 = rows.find((r) => r.id === running.jobId);
    const r2 = rows.find((r) => r.id === exited.jobId);
    expect(r1?.running).toBe(true);
    expect(r2?.running).toBe(false);
    expect(r2?.exitCode).toBe(0);
  });

  it("runningCount() reflects live state", async () => {
    expect(registry.runningCount()).toBe(0);
    const a = await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, { cwd, waitSec: 0.2 });
    expect(registry.runningCount()).toBe(1);
    await registry.stop(a.jobId);
    expect(registry.runningCount()).toBe(0);
  });

  it("rejects shell operators with a clear message", async () => {
    await expect(registry.start("echo hi | grep h", { cwd })).rejects.toThrow(/shell operator/);
  });

  it("read() returns null for unknown job id", () => {
    expect(registry.read(999)).toBeNull();
  });

  it("shutdown() kills all running jobs", async () => {
    await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, { cwd, waitSec: 0.2 });
    await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, { cwd, waitSec: 0.2 });
    expect(registry.runningCount()).toBe(2);
    // 4s deadline: Windows taskkill /T is async and needs ~500-800ms
    // per process to propagate through the tree + reap confirmation.
    await registry.shutdown(4000);
    expect(registry.runningCount()).toBe(0);
  });
});
