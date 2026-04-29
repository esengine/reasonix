/**
 * `reasonix events <name>` command formatter — pure stdout assertions.
 * The command itself is mostly formatting; this proves the per-event-type
 * detail rendering hits the right shape, plus the filter / projection
 * flags work end-to-end.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventsCommand } from "../src/cli/commands/events.js";
import { sessionsDir } from "../src/session.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reasonix-events-cmd-"));
  // Override the home dir so eventLogPath resolves into our temp area.
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(name: string, lines: string[]): void {
  const target = join(sessionsDir(), `${name}.events.jsonl`);
  const fs = require("node:fs") as typeof import("node:fs");
  fs.mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, lines.map((l) => `${l}\n`).join(""), "utf8");
}

const ev = (id: number, type: string, extra: Record<string, unknown>): string =>
  JSON.stringify({ id, ts: "2026-04-29T12:00:00Z", turn: 1, type, ...extra });

describe("eventsCommand", () => {
  it("formats common event types with sensible details", () => {
    seed("demo", [
      ev(1, "session.opened", { name: "demo", resumedFromTurn: 0 }),
      ev(2, "user.message", { text: "list src" }),
      ev(3, "model.turn.started", {
        model: "deepseek-v4-flash",
        reasoningEffort: "max",
        prefixHash: "abcd1234ef",
      }),
      ev(4, "tool.intent", { callId: "tc-1", name: "list_directory", args: '{"path":"src"}' }),
      ev(5, "tool.dispatched", { callId: "tc-1" }),
      ev(6, "tool.result", { callId: "tc-1", ok: true, output: "App.tsx\n", durationMs: 12 }),
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    eventsCommand({ name: "demo" });
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();

    expect(out).toContain("session.opened");
    expect(out).toContain("user.message");
    expect(out).toContain('"list src"');
    expect(out).toContain("model=deepseek-v4-flash");
    expect(out).toContain("prefix=abcd1234");
    expect(out).toContain("tc-1 list_directory");
    expect(out).toContain("tc-1 ok 8B"); // "App.tsx\n".length === 8
  });

  it("--type filters to one event variant", () => {
    seed("demo", [
      ev(1, "user.message", { text: "hi" }),
      ev(2, "tool.intent", { callId: "tc-1", name: "shell", args: "{}" }),
      ev(3, "status", { text: "thinking" }),
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    eventsCommand({ name: "demo", type: "tool.intent" });
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    expect(out).toContain("tool.intent");
    expect(out).not.toContain("user.message");
    expect(out).not.toContain("status ");
  });

  it("--tail keeps only the last N", () => {
    seed("demo", [
      ev(1, "status", { text: "a" }),
      ev(2, "status", { text: "b" }),
      ev(3, "status", { text: "c" }),
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    eventsCommand({ name: "demo", tail: 2 });
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    expect(out).toContain('"b"');
    expect(out).toContain('"c"');
    expect(out).not.toContain('"a"');
  });

  it("--json passes through raw JSONL", () => {
    seed("demo", [ev(1, "status", { text: "raw" })]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    eventsCommand({ name: "demo", json: true });
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    // Must be parseable JSON line, not formatted.
    const parsed = JSON.parse(out.split("\n").filter((l) => l.trim())[0]!);
    expect(parsed).toMatchObject({ id: 1, type: "status", text: "raw" });
  });

  it("--projection emits the reduced ProjectionSet", () => {
    seed("demo", [ev(1, "user.message", { text: "hi" }), ev(2, "status", { text: "thinking" })]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    eventsCommand({ name: "demo", projection: true });
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    const parsed = JSON.parse(out);
    expect(parsed.conversation.messages[0]).toMatchObject({ role: "user", content: "hi" });
    expect(parsed.session.currentTurn).toBe(1);
  });

  it("missing session exits 1 with a helpful message", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    eventsCommand({ name: "no-such-session" });
    expect(exit).toHaveBeenCalledWith(1);
    const errOut = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errOut).toContain('no events for session "no-such-session"');
    err.mockRestore();
    exit.mockRestore();
  });
});
