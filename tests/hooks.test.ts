/** Hooks — settings load, match patterns, outcome decisions, runHooks dispatcher (stubbed spawner). */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HookSpawnInput,
  type HookSpawnResult,
  type ResolvedHook,
  decideOutcome,
  formatHookOutcomeMessage,
  globalSettingsPath,
  loadHooks,
  matchesTool,
  projectSettingsPath,
  runHooks,
} from "../src/hooks.js";

function writeSettings(dir: string, json: unknown): string {
  const path = join(dir, ".reasonix", "settings.json");
  mkdirSync(join(dir, ".reasonix"), { recursive: true });
  writeFileSync(path, JSON.stringify(json), "utf8");
  return path;
}

function makeSpawner(
  responses: HookSpawnResult[],
  log?: HookSpawnInput[],
): (input: HookSpawnInput) => Promise<HookSpawnResult> {
  let i = 0;
  return async (input) => {
    log?.push(input);
    const r = responses[i++];
    if (!r) throw new Error("spawner exhausted — test set up too few responses");
    return r;
  };
}

const ok = (overrides: Partial<HookSpawnResult> = {}): HookSpawnResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...overrides,
});

describe("loadHooks", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-hooks-home-"));
    project = mkdtempSync(join(tmpdir(), "reasonix-hooks-proj-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("returns [] when no settings file exists in either scope", () => {
    expect(loadHooks({ homeDir: home, projectRoot: project })).toEqual([]);
  });

  it("loads project then global, in array order, with scope tags", () => {
    writeSettings(home, {
      hooks: { Stop: [{ command: "echo global1" }, { command: "echo global2" }] },
    });
    writeSettings(project, {
      hooks: { Stop: [{ command: "echo proj" }] },
    });
    const hooks = loadHooks({ homeDir: home, projectRoot: project });
    expect(hooks.map((h) => `${h.scope}:${h.command}`)).toEqual([
      "project:echo proj",
      "global:echo global1",
      "global:echo global2",
    ]);
  });

  it("ignores entries without a string command", () => {
    writeSettings(home, {
      hooks: {
        Stop: [
          { command: "echo good" },
          { command: "" },
          { description: "no command" },
          { command: 42 } as unknown as { command: string },
        ],
      },
    });
    const hooks = loadHooks({ homeDir: home });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.command).toBe("echo good");
  });

  it("tolerates malformed JSON without throwing", () => {
    mkdirSync(join(home, ".reasonix"), { recursive: true });
    writeFileSync(join(home, ".reasonix", "settings.json"), "{ not valid json", "utf8");
    expect(() => loadHooks({ homeDir: home })).not.toThrow();
    expect(loadHooks({ homeDir: home })).toEqual([]);
  });

  it("project scope is skipped when projectRoot omitted", () => {
    writeSettings(project, { hooks: { Stop: [{ command: "echo proj" }] } });
    const hooks = loadHooks({ homeDir: home }); // no projectRoot
    expect(hooks).toEqual([]);
  });

  it("paths reported by *SettingsPath helpers are absolute", () => {
    expect(globalSettingsPath(home)).toBe(join(home, ".reasonix", "settings.json"));
    expect(projectSettingsPath(project)).toBe(join(project, ".reasonix", "settings.json"));
  });
});

describe("matchesTool", () => {
  const baseHook: ResolvedHook = {
    event: "PreToolUse",
    scope: "global",
    source: "/tmp/x",
    command: "true",
  };

  it("returns true when match is undefined or '*'", () => {
    expect(matchesTool(baseHook, "edit_file")).toBe(true);
    expect(matchesTool({ ...baseHook, match: "*" }, "edit_file")).toBe(true);
  });

  it("anchored regex matches only the full tool name", () => {
    const hook: ResolvedHook = { ...baseHook, match: "edit_file|write_file" };
    expect(matchesTool(hook, "edit_file")).toBe(true);
    expect(matchesTool(hook, "write_file")).toBe(true);
    expect(matchesTool(hook, "read_file")).toBe(false);
    // Substring should NOT match (anchored)
    expect(matchesTool({ ...baseHook, match: "file" }, "edit_file")).toBe(false);
  });

  it("malformed regex falls back to no-match (safer than fire-on-everything)", () => {
    const hook: ResolvedHook = { ...baseHook, match: "[unclosed" };
    expect(matchesTool(hook, "edit_file")).toBe(false);
  });

  it("non-tool events ignore the match field", () => {
    const hook: ResolvedHook = {
      ...baseHook,
      event: "UserPromptSubmit",
      match: "never",
    };
    expect(matchesTool(hook, "anything")).toBe(true);
  });
});

describe("decideOutcome", () => {
  it("exit 0 → pass", () => {
    expect(decideOutcome("PreToolUse", ok())).toBe("pass");
  });
  it("exit 2 on PreToolUse → block", () => {
    expect(decideOutcome("PreToolUse", ok({ exitCode: 2 }))).toBe("block");
  });
  it("exit 2 on PostToolUse → warn (block is meaningless after the fact)", () => {
    expect(decideOutcome("PostToolUse", ok({ exitCode: 2 }))).toBe("warn");
  });
  it("any other non-zero → warn", () => {
    expect(decideOutcome("PreToolUse", ok({ exitCode: 1 }))).toBe("warn");
    expect(decideOutcome("Stop", ok({ exitCode: 127 }))).toBe("warn");
  });
  it("timeout on a blocking event → block, on a logging event → warn", () => {
    expect(decideOutcome("PreToolUse", ok({ timedOut: true, exitCode: null }))).toBe("block");
    expect(decideOutcome("Stop", ok({ timedOut: true, exitCode: null }))).toBe("warn");
  });
  it("spawn error → error, regardless of event", () => {
    const err = ok({ exitCode: null, spawnError: new Error("ENOENT") });
    expect(decideOutcome("PreToolUse", err)).toBe("error");
    expect(decideOutcome("Stop", err)).toBe("error");
  });
});

describe("runHooks", () => {
  const hook = (overrides: Partial<ResolvedHook> = {}): ResolvedHook => ({
    event: "PreToolUse",
    scope: "project",
    source: "/tmp/x",
    command: "true",
    ...overrides,
  });

  it("filters by event AND tool match before running", async () => {
    const log: HookSpawnInput[] = [];
    const spawner = makeSpawner([ok()], log);
    const hooks: ResolvedHook[] = [
      hook({ event: "Stop", command: "wrong-event" }),
      hook({ event: "PreToolUse", match: "write_file", command: "wrong-tool" }),
      hook({ event: "PreToolUse", match: "edit_file", command: "right" }),
    ];
    const report = await runHooks({
      hooks,
      spawner,
      payload: { event: "PreToolUse", cwd: "/tmp", toolName: "edit_file" },
    });
    expect(log).toHaveLength(1);
    expect(log[0]?.command).toBe("right");
    expect(report.outcomes[0]?.decision).toBe("pass");
    expect(report.blocked).toBe(false);
  });

  it("stops at the first block on a blocking event", async () => {
    const log: HookSpawnInput[] = [];
    const spawner = makeSpawner([ok(), ok({ exitCode: 2, stderr: "denied" }), ok()], log);
    const hooks: ResolvedHook[] = [
      hook({ command: "first" }),
      hook({ command: "blocker" }),
      hook({ command: "third — should not run" }),
    ];
    const report = await runHooks({
      hooks,
      spawner,
      payload: { event: "PreToolUse", cwd: "/tmp", toolName: "x" },
    });
    expect(log.map((l) => l.command)).toEqual(["first", "blocker"]);
    expect(report.blocked).toBe(true);
    expect(report.outcomes[1]?.decision).toBe("block");
  });

  it("does not stop on warn — collects every outcome", async () => {
    const spawner = makeSpawner([ok({ exitCode: 1, stderr: "noisy" }), ok()]);
    const hooks: ResolvedHook[] = [hook({ command: "warner" }), hook({ command: "ok" })];
    const report = await runHooks({
      hooks,
      spawner,
      payload: { event: "PreToolUse", cwd: "/tmp", toolName: "x" },
    });
    expect(report.outcomes.map((o) => o.decision)).toEqual(["warn", "pass"]);
    expect(report.blocked).toBe(false);
  });

  it("stdin contains a single-line JSON envelope of the payload", async () => {
    const log: HookSpawnInput[] = [];
    const spawner = makeSpawner([ok()], log);
    await runHooks({
      hooks: [hook({ command: "echo" })],
      spawner,
      payload: {
        event: "PreToolUse",
        cwd: "/tmp",
        toolName: "edit_file",
        toolArgs: { path: "a.ts" },
      },
    });
    const stdin = log[0]?.stdin ?? "";
    const decoded = JSON.parse(stdin);
    expect(decoded.event).toBe("PreToolUse");
    expect(decoded.toolName).toBe("edit_file");
    expect(decoded.toolArgs).toEqual({ path: "a.ts" });
    expect(stdin.endsWith("\n")).toBe(true);
  });

  it("uses payload.cwd by default and per-hook cwd override when set", async () => {
    const log: HookSpawnInput[] = [];
    const spawner = makeSpawner([ok(), ok()], log);
    await runHooks({
      hooks: [hook({ command: "a" }), hook({ command: "b", cwd: "/special" })],
      spawner,
      payload: { event: "PreToolUse", cwd: "/payload-cwd", toolName: "x" },
    });
    expect(log[0]?.cwd).toBe("/payload-cwd");
    expect(log[1]?.cwd).toBe("/special");
  });

  it("default timeout is 5s for blocking events and 30s for logging events", async () => {
    const log: HookSpawnInput[] = [];
    const spawner = makeSpawner([ok(), ok()], log);
    const h: ResolvedHook[] = [
      hook({ event: "PreToolUse", command: "pre" }),
      hook({ event: "Stop", command: "stop" }),
    ];
    await runHooks({
      hooks: h,
      spawner,
      payload: { event: "PreToolUse", cwd: "/tmp", toolName: "x" },
    });
    await runHooks({
      hooks: h,
      spawner,
      payload: { event: "Stop", cwd: "/tmp" },
    });
    expect(log[0]?.timeoutMs).toBe(5_000);
    expect(log[1]?.timeoutMs).toBe(30_000);
  });

  it("per-hook timeout overrides the default", async () => {
    const log: HookSpawnInput[] = [];
    const spawner = makeSpawner([ok()], log);
    await runHooks({
      hooks: [hook({ command: "x", timeout: 999 })],
      spawner,
      payload: { event: "PreToolUse", cwd: "/tmp", toolName: "x" },
    });
    expect(log[0]?.timeoutMs).toBe(999);
  });
});

describe("formatHookOutcomeMessage", () => {
  const baseHook: ResolvedHook = {
    event: "PostToolUse",
    scope: "global",
    source: "/tmp/x",
    command: "echo hi",
  };

  it("returns empty string for pass", () => {
    expect(
      formatHookOutcomeMessage({
        hook: baseHook,
        decision: "pass",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      }),
    ).toBe("");
  });

  it("includes scope/event tag, command, decision, and stderr detail", () => {
    const msg = formatHookOutcomeMessage({
      hook: baseHook,
      decision: "warn",
      exitCode: 1,
      stdout: "",
      stderr: "something went sideways",
      durationMs: 5,
    });
    expect(msg).toContain("global/PostToolUse");
    expect(msg).toContain("echo hi");
    expect(msg).toContain("warn");
    expect(msg).toContain("something went sideways");
  });

  it("truncates very long commands at 60 chars + ellipsis", () => {
    const long = "x".repeat(200);
    const msg = formatHookOutcomeMessage({
      hook: { ...baseHook, command: long },
      decision: "warn",
      exitCode: 1,
      stdout: "",
      stderr: "",
      durationMs: 5,
    });
    expect(msg).toContain(`${"x".repeat(60)}…`);
    expect(msg).not.toContain("x".repeat(61));
  });

  it("flags truncated output so users know their hook wrote more than was kept", () => {
    const msg = formatHookOutcomeMessage({
      hook: baseHook,
      decision: "warn",
      exitCode: 1,
      stdout: "",
      stderr: "first line of many",
      durationMs: 5,
      truncated: true,
    });
    expect(msg).toContain("(output truncated at 256KB)");
  });
});

describe("runHooks output truncation", () => {
  it("propagates the spawner's truncated flag onto the HookOutcome", async () => {
    const hook: ResolvedHook = {
      event: "PostToolUse",
      scope: "project",
      source: "/tmp/p",
      command: "noop",
    };
    const spawner = makeSpawner([
      { exitCode: 0, stdout: "x".repeat(1024), stderr: "", timedOut: false, truncated: true },
    ]);
    const report = await runHooks({
      payload: { event: "PostToolUse", cwd: "/tmp", toolName: "edit_file" },
      hooks: [hook],
      spawner,
    });
    expect(report.outcomes[0]?.truncated).toBe(true);
  });

  it("leaves truncated undefined when the spawner did not flag it", async () => {
    const hook: ResolvedHook = {
      event: "PostToolUse",
      scope: "project",
      source: "/tmp/p",
      command: "noop",
    };
    const spawner = makeSpawner([ok({ stdout: "small" })]);
    const report = await runHooks({
      payload: { event: "PostToolUse", cwd: "/tmp", toolName: "edit_file" },
      hooks: [hook],
      spawner,
    });
    expect(report.outcomes[0]?.truncated).toBeUndefined();
  });
});
