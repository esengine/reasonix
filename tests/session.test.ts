import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory.js";
import {
  appendSessionMessage,
  deleteSession,
  listSessions,
  loadSessionMessages,
  pruneStaleSessions,
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

  it("pruneStaleSessions deletes sessions older than the cutoff and leaves fresh ones", () => {
    // Three sessions: two backdated past the 90-day default, one
    // fresh. Backdate via utimesSync since createTime/mtime is what
    // listSessions reads.
    appendSessionMessage("ancient1", { role: "user", content: "x" });
    appendSessionMessage("ancient2", { role: "user", content: "x" });
    appendSessionMessage("recent", { role: "user", content: "x" });
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    utimesSync(sessionPath("ancient1"), oldDate, oldDate);
    utimesSync(sessionPath("ancient2"), oldDate, oldDate);

    const removed = pruneStaleSessions(90);
    expect(removed.sort()).toEqual(["ancient1", "ancient2"]);
    expect(existsSync(sessionPath("ancient1"))).toBe(false);
    expect(existsSync(sessionPath("ancient2"))).toBe(false);
    expect(existsSync(sessionPath("recent"))).toBe(true);
  });

  it("pruneStaleSessions with a tighter cutoff catches sessions the default would skip", () => {
    appendSessionMessage("yesterday", { role: "user", content: "x" });
    const yest = new Date(Date.now() - 36 * 60 * 60 * 1000); // 1.5 days
    utimesSync(sessionPath("yesterday"), yest, yest);

    expect(pruneStaleSessions(90)).toEqual([]);
    expect(existsSync(sessionPath("yesterday"))).toBe(true);
    expect(pruneStaleSessions(1)).toEqual(["yesterday"]);
    expect(existsSync(sessionPath("yesterday"))).toBe(false);
  });

  it("sessionsDir exists after first append", () => {
    appendSessionMessage("s", { role: "user", content: "x" });
    expect(existsSync(sessionsDir())).toBe(true);
    expect(existsSync(dirname(sessionPath("s")))).toBe(true);
  });

  it("loop.appendAndPersist writes bang-style messages to the session file", () => {
    // Regression: before 0.5.14 the bang handler called loop.log.append which
    // only touched memory, so `!cmd` output was lost on session resume.
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: (async () => new Response()) as any,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      session: "bang-persist",
    });
    loop.appendAndPersist({ role: "user", content: "[!ls]\n$ ls\n[exit 0]\nfile1 file2" });
    const reloaded = loadSessionMessages("bang-persist");
    expect(reloaded).toEqual([{ role: "user", content: "[!ls]\n$ ls\n[exit 0]\nfile1 file2" }]);
  });
});
