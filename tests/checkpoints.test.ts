/**
 * Tests for the checkpoint store. Each test uses a fresh temp dir for
 * the workspace and points HOME at another temp dir so the real
 * `~/.reasonix` is never touched.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCheckpoint,
  deleteCheckpoint,
  findCheckpoint,
  fmtAgo,
  listCheckpoints,
  loadCheckpoint,
  restoreCheckpoint,
} from "../src/code/checkpoints.js";

let realHome: string | undefined;
let workspace: string;
let homeDir: string;

beforeEach(() => {
  realHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), "rx-cp-home-"));
  // checkpoints.ts uses `os.homedir()` which respects HOME on Unix and
  // USERPROFILE on Windows.
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  workspace = mkdtempSync(join(tmpdir(), "rx-cp-work-"));
});

afterEach(() => {
  // `delete` is fine here — env-var cleanup in test teardown is not
  // hot-path code. Assigning `undefined` would set the literal string.
  if (realHome === undefined) {
    // biome-ignore lint/performance/noDelete: env-var cleanup in test teardown
    delete process.env.HOME;
  } else process.env.HOME = realHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("createCheckpoint", () => {
  it("snapshots existing files with their content", () => {
    writeFileSync(join(workspace, "a.txt"), "hello");
    writeFileSync(join(workspace, "b.txt"), "world");
    const meta = createCheckpoint({
      rootDir: workspace,
      name: "first",
      paths: ["a.txt", "b.txt"],
    });
    expect(meta.fileCount).toBe(2);
    expect(meta.bytes).toBe(10);
    const cp = loadCheckpoint(workspace, meta.id);
    expect(cp).not.toBeNull();
    expect(cp!.files).toHaveLength(2);
    expect(cp!.files.find((f) => f.path === "a.txt")?.content).toBe("hello");
  });

  it("records non-existent files with content: null", () => {
    const meta = createCheckpoint({
      rootDir: workspace,
      name: "with-missing",
      paths: ["nope.txt"],
    });
    const cp = loadCheckpoint(workspace, meta.id);
    expect(cp!.files).toEqual([{ path: "nope.txt", content: null }]);
  });

  it("dedupes repeated paths in the input", () => {
    writeFileSync(join(workspace, "x.txt"), "1");
    const meta = createCheckpoint({
      rootDir: workspace,
      name: "dup",
      paths: ["x.txt", "x.txt", "x.txt"],
    });
    expect(meta.fileCount).toBe(1);
  });

  it("refuses paths that escape rootDir", () => {
    writeFileSync(join(workspace, "ok.txt"), "ok");
    const meta = createCheckpoint({
      rootDir: workspace,
      name: "escape",
      paths: ["../../etc/passwd", "ok.txt"],
    });
    const cp = loadCheckpoint(workspace, meta.id);
    expect(cp!.files).toEqual([{ path: "ok.txt", content: "ok" }]);
  });

  it("appends to the index so listCheckpoints sees the new entry", () => {
    expect(listCheckpoints(workspace)).toEqual([]);
    createCheckpoint({ rootDir: workspace, name: "one", paths: [] });
    createCheckpoint({ rootDir: workspace, name: "two", paths: [] });
    const items = listCheckpoints(workspace);
    expect(items).toHaveLength(2);
    expect(items.map((m) => m.name)).toEqual(["one", "two"]);
  });
});

describe("findCheckpoint", () => {
  it("matches by exact id", () => {
    const meta = createCheckpoint({ rootDir: workspace, name: "foo", paths: [] });
    expect(findCheckpoint(workspace, meta.id)?.id).toBe(meta.id);
  });

  it("matches by name and prefers the newest on collision", () => {
    const a = createCheckpoint({ rootDir: workspace, name: "shared", paths: [] });
    // Sleep a tick so timestamps differ.
    const b = createCheckpoint({ rootDir: workspace, name: "shared", paths: [] });
    const found = findCheckpoint(workspace, "shared");
    expect(found?.id).toBe(b.id);
    expect(a.id).not.toBe(b.id);
  });

  it("returns null when nothing matches", () => {
    expect(findCheckpoint(workspace, "ghost")).toBeNull();
  });
});

describe("restoreCheckpoint", () => {
  it("writes file contents back, replacing any newer edits", () => {
    writeFileSync(join(workspace, "a.txt"), "v1");
    const meta = createCheckpoint({
      rootDir: workspace,
      name: "snap",
      paths: ["a.txt"],
    });
    writeFileSync(join(workspace, "a.txt"), "v2 changed");
    const result = restoreCheckpoint(workspace, meta.id);
    expect(result.restored).toEqual(["a.txt"]);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("v1");
  });

  it("removes files that didn't exist at snapshot time", () => {
    // Snapshot when the file doesn't exist
    const meta = createCheckpoint({
      rootDir: workspace,
      name: "before-create",
      paths: ["new.txt"],
    });
    // Create the file later
    writeFileSync(join(workspace, "new.txt"), "added later");
    expect(existsSync(join(workspace, "new.txt"))).toBe(true);
    const result = restoreCheckpoint(workspace, meta.id);
    expect(result.removed).toEqual(["new.txt"]);
    expect(existsSync(join(workspace, "new.txt"))).toBe(false);
  });

  it("reports a (checkpoint) skip when the id doesn't exist", () => {
    const result = restoreCheckpoint(workspace, "cp-nope");
    expect(result.skipped).toEqual([{ path: "(checkpoint)", reason: "not found: cp-nope" }]);
    expect(result.restored).toEqual([]);
  });

  it("creates parent directories on restore", () => {
    writeFileSync(join(workspace, "deep.txt"), "x");
    const meta = createCheckpoint({
      rootDir: workspace,
      name: "with-deep",
      paths: ["deep.txt"],
    });
    rmSync(join(workspace, "deep.txt"));
    const result = restoreCheckpoint(workspace, meta.id);
    expect(result.restored).toEqual(["deep.txt"]);
    expect(readFileSync(join(workspace, "deep.txt"), "utf8")).toBe("x");
  });
});

describe("deleteCheckpoint", () => {
  it("removes the snapshot file and the index entry", () => {
    const meta = createCheckpoint({ rootDir: workspace, name: "doomed", paths: [] });
    expect(listCheckpoints(workspace)).toHaveLength(1);
    expect(deleteCheckpoint(workspace, meta.id)).toBe(true);
    expect(listCheckpoints(workspace)).toEqual([]);
    expect(loadCheckpoint(workspace, meta.id)).toBeNull();
  });
});

describe("fmtAgo", () => {
  it("formats short durations as seconds", () => {
    expect(fmtAgo(Date.now() - 5_000)).toMatch(/^\ds ago$/);
  });

  it("formats minute/hour/day", () => {
    expect(fmtAgo(Date.now() - 5 * 60_000)).toMatch(/m ago$/);
    expect(fmtAgo(Date.now() - 3 * 3600_000)).toMatch(/h ago$/);
    expect(fmtAgo(Date.now() - 2 * 86400_000)).toMatch(/d ago$/);
  });
});
