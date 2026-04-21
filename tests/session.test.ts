import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendSessionMessage,
  deleteSession,
  listSessions,
  loadSessionMessages,
  sanitizeName,
  sessionPath,
  sessionsDir,
} from "../src/session.js";

describe("sanitizeName", () => {
  it("keeps alphanumerics, CJK, dashes, underscores", () => {
    expect(sanitizeName("hello-world_1")).toBe("hello-world_1");
    expect(sanitizeName("我的对话")).toBe("我的对话");
  });
  it("replaces other characters with underscore", () => {
    expect(sanitizeName("my/path:bad?")).toBe("my_path_bad_");
  });
  it("caps at 64 chars and defaults to 'default' when empty", () => {
    expect(sanitizeName("")).toBe("default");
    expect(sanitizeName("/:@!").length).toBeLessThanOrEqual(4);
    expect(sanitizeName("a".repeat(200))).toHaveLength(64);
  });
});

describe("session persistence", () => {
  let tmp: string;
  const realHome = homedir();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-session-"));
    vi.stubEnv("USERPROFILE", tmp); // Windows
    vi.stubEnv("HOME", tmp); // Unix
    // os.homedir() is cached per-process on some platforms — override via spy.
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("sessionPath lives under <home>/.reasonix/sessions", () => {
    const p = sessionPath("demo");
    expect(p).toContain(".reasonix");
    expect(p).toContain("sessions");
    expect(p.endsWith("demo.jsonl")).toBe(true);
    expect(p.startsWith(tmp)).toBe(true);
  });

  it("loadSessionMessages returns [] when the file doesn't exist", () => {
    expect(loadSessionMessages("ghost")).toEqual([]);
  });

  it("appendSessionMessage + loadSessionMessages round-trip", () => {
    appendSessionMessage("foo", { role: "user", content: "hi" });
    appendSessionMessage("foo", { role: "assistant", content: "hello" });
    const msgs = loadSessionMessages("foo");
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toEqual({ role: "user", content: "hi" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "hello" });
  });

  it("tolerates malformed lines (skips them)", () => {
    appendSessionMessage("mix", { role: "user", content: "a" });
    // inject a garbage line directly
    const p = sessionPath("mix");
    writeFileSync(p, `${readFileSync(p, "utf8")}not json\n`);
    appendSessionMessage("mix", { role: "user", content: "b" });
    const msgs = loadSessionMessages("mix");
    expect(msgs.length).toBe(2);
  });

  it("listSessions returns metadata sorted by mtime desc", () => {
    appendSessionMessage("alpha", { role: "user", content: "x" });
    appendSessionMessage("beta", { role: "user", content: "y" });
    appendSessionMessage("beta", { role: "user", content: "z" });
    const items = listSessions();
    expect(items.length).toBe(2);
    const names = items.map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    const beta = items.find((s) => s.name === "beta")!;
    expect(beta.messageCount).toBe(2);
    expect(beta.size).toBeGreaterThan(0);
  });

  it("deleteSession removes the file", () => {
    appendSessionMessage("gone", { role: "user", content: "x" });
    expect(existsSync(sessionPath("gone"))).toBe(true);
    expect(deleteSession("gone")).toBe(true);
    expect(existsSync(sessionPath("gone"))).toBe(false);
    expect(deleteSession("gone")).toBe(false);
  });

  it("sessionsDir exists after first append", () => {
    appendSessionMessage("s", { role: "user", content: "x" });
    expect(existsSync(sessionsDir())).toBe(true);
    expect(existsSync(dirname(sessionPath("s")))).toBe(true);
  });
});
