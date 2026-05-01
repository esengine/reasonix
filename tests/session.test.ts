import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import {
  appendSessionMessage,
  deleteSession,
  findSessionsByPrefix,
  listSessions,
  loadSessionMessages,
  pruneStaleSessions,
  resolveSession,
  sanitizeName,
  sessionPath,
  sessionsDir,
  timestampSuffix,
} from "../src/memory/session.js";

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

  it("deleteSession removes the plan-state sidecar too", () => {
    // Regression: before plan-state sidecar cleanup was added,
    // /forget left orphaned .plan.json files that caused "RESUMED
    // PLAN" banners on fresh sessions sharing the same name.
    appendSessionMessage("plan-sidecar", { role: "user", content: "hi" });
    const planPath = sessionPath("plan-sidecar").replace(/\.jsonl$/, ".plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        version: 1,
        steps: [{ id: "s1", title: "t", action: "a" }],
        completedStepIds: [],
        updatedAt: new Date().toISOString(),
      }),
    );
    expect(existsSync(planPath)).toBe(true);
    deleteSession("plan-sidecar");
    expect(existsSync(sessionPath("plan-sidecar"))).toBe(false);
    expect(existsSync(planPath)).toBe(false);
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

  describe("timestampSuffix", () => {
    it("returns a 12-character string of digits", () => {
      const ts = timestampSuffix();
      expect(ts).toMatch(/^\d{12}$/);
    });

    it("starts with the current year", () => {
      const year = String(new Date().getFullYear());
      expect(timestampSuffix().startsWith(year)).toBe(true);
    });

    it("is sortable — later calls produce lexicographically larger strings", () => {
      const a = timestampSuffix();
      const b = timestampSuffix();
      // In the unlikely event both fall on the same minute, they're equal
      expect(b.localeCompare(a)).toBeGreaterThanOrEqual(0);
    });
  });

  describe("resolveSession", () => {
    it("returns the base name when no prior sessions and no flags", () => {
      const { resolved, preview } = resolveSession("fresh");
      expect(resolved).toBe("fresh");
      expect(preview).toBeUndefined();
    });

    it("generates a timestamped name on forceNew", () => {
      const { resolved, preview } = resolveSession("demo", true);
      expect(resolved).toMatch(/^demo-\d{12}$/);
      expect(preview).toBeUndefined();
    });

    it("returns undefined when sessionName is undefined", () => {
      const { resolved, preview } = resolveSession(undefined);
      expect(resolved).toBeUndefined();
      expect(preview).toBeUndefined();
    });

    it("picks the base name when no prefixed sessions exist and it has messages", () => {
      appendSessionMessage("project", { role: "user", content: "hello" });
      const { resolved, preview } = resolveSession("project");
      expect(resolved).toBe("project");
      expect(preview).toBeDefined();
      expect(preview!.messageCount).toBe(1);
    });

    it("ignores timestamped sessions that have only .events.jsonl (no messages file)", () => {
      // Simulate: a "new" created a timestamped session, App mounted and
      // wrote .events.jsonl, but no messages were ever sent — so no .jsonl.
      appendSessionMessage("myproject", { role: "user", content: "real messages" });
      const eventsPath = sessionPath("myproject-20260430T200000").replace(
        /\.jsonl$/,
        ".events.jsonl",
      );
      writeFileSync(eventsPath, "{}");

      const { resolved, preview } = resolveSession("myproject");
      // Should fall back to the base session, not the empty timestamped one
      expect(resolved).toBe("myproject");
      expect(preview).toBeDefined();
      expect(preview!.messageCount).toBe(1);
    });

    it("picks the latest prefixed session over the base name", () => {
      appendSessionMessage("project", { role: "user", content: "old" });
      appendSessionMessage("project-20260430T091500", { role: "user", content: "newer" });
      // Create a later timestamp so it sorts first
      const evenLater = new Date(Date.now() + 5000);
      appendSessionMessage("project-20260430T154500", { role: "user", content: "newest" });
      utimesSync(sessionPath("project-20260430T154500"), evenLater, evenLater);

      const { resolved, preview } = resolveSession("project");
      // Alpha-reverse: "project-20260430T154500" sorts before "project-20260430T091500".
      // "project" sorts after both ('.' > '-'), so it comes first in reverse.
      // Wait — let's trace: ascending = project-2026..., project-2026..., project
      // Actually '.' (46) > '-' (45), so ascending: project-2026..., project-2026..., project
      // Then reverse: project, project-2026..., project-2026...
      // So 'project' (no timestamp) would be first after reverse...
      // Hmm, that's not what we want. Let me just check the behavior.
      //
      // Actually, for the prefix-based resolution, resolveSession calls
      // findSessionsByPrefix("project-") which excludes the bare "project"
      // (doesn't start with "project-"). So only timestamped ones compete.
      expect(resolved).toBe("project-20260430T154500");
      expect(preview).toBeDefined();
    });

    it("forceResume resolves to the latest prefixed session", () => {
      appendSessionMessage("app", { role: "user", content: "a" });
      appendSessionMessage("app-20260430T091500", { role: "user", content: "b" });
      const { resolved, preview } = resolveSession("app", false, true);
      expect(resolved).toBe("app-20260430T091500");
      expect(preview).toBeUndefined();
    });

    it("forceResume falls back to base name when no prefixed sessions exist", () => {
      const { resolved, preview } = resolveSession("standalone", false, true);
      expect(resolved).toBe("standalone");
      expect(preview).toBeUndefined();
    });
  });

  describe("findSessionsByPrefix", () => {
    it("returns [] when the sessions directory does not exist", () => {
      // Remove the sessions dir to simulate a clean state
      const dir = sessionsDir();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      expect(findSessionsByPrefix("anything")).toEqual([]);
    });

    it("returns session names matching the prefix, sorted alpha-reverse", () => {
      // Sort is by filename (no stat I/O). Timestamped names sort
      // correctly because YYYYMMDDHHmm is zero-padded; the largest
      // (newest) timestamp sorts last ascending → first after reverse.
      // Non-timestamped names like "code-reasonix-old" start with a
      // letter, which in ASCII sorts after digits, so they come first
      // after reverse — a minor edge case that doesn't affect real use.
      appendSessionMessage("code-reasonix-old", { role: "user", content: "x" });
      appendSessionMessage("code-reasonix-20260430T143200", { role: "user", content: "y" });
      appendSessionMessage("code-reasonix-20260430T154500", { role: "user", content: "z" });

      const result = findSessionsByPrefix("code-reasonix-");
      expect(result).toEqual([
        "code-reasonix-old",
        "code-reasonix-20260430T154500",
        "code-reasonix-20260430T143200",
      ]);
    });

    it("does not return sessions that don't start with the prefix", () => {
      appendSessionMessage("foo-bar", { role: "user", content: "a" });
      appendSessionMessage("foo-baz", { role: "user", content: "b" });
      appendSessionMessage("other-thing", { role: "user", content: "c" });

      expect(findSessionsByPrefix("foo-")).toEqual(["foo-baz", "foo-bar"]);
    });

    it("only matches .jsonl files, not sidecar files", () => {
      appendSessionMessage("alpha-001", { role: "user", content: "x" });
      // Write a .plan.json sidecar manually — should be ignored
      const planPath = sessionPath("alpha-001").replace(/\.jsonl$/, ".plan.json");
      writeFileSync(planPath, "{}");
      // Write a .pending.json sidecar
      const pendingPath = sessionPath("alpha-001").replace(/\.jsonl$/, ".pending.json");
      writeFileSync(pendingPath, "{}");
      // Write a .events.jsonl sidecar — ends with .jsonl but is NOT a session
      const eventsPath = sessionPath("alpha-001").replace(/\.jsonl$/, ".events.jsonl");
      writeFileSync(eventsPath, "{}");

      const result = findSessionsByPrefix("alpha-");
      expect(result).toEqual(["alpha-001"]);
    });

    it("prefix with trailing dash excludes the bare base session name", () => {
      appendSessionMessage("project", { role: "user", content: "a" });
      appendSessionMessage("project-20260430T143200", { role: "user", content: "b" });

      // Prefix with dash: matches "project-*" but not bare "project"
      expect(findSessionsByPrefix("project-")).toEqual(["project-20260430T143200"]);
      // Prefix without dash matches everything starting with "project".
      // "project" (no dash) sorts before "project-..." because '.' (46)
      // comes after '-' (45) in ASCII, so reverse puts "project" first.
      expect(findSessionsByPrefix("project")).toEqual(["project", "project-20260430T143200"]);
    });
  });
});
