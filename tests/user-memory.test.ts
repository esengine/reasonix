/** `~/.reasonix/memory/` store + prefix-loading composer — temp homeDir per test. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProjectMemory } from "../src/memory/project.js";
import {
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_MAX_CHARS,
  MemoryStore,
  applyGlobalReasonixMemory,
  applyMemoryStack,
  applyUserMemory,
  projectHash,
  sanitizeMemoryName,
} from "../src/memory/user.js";

const BASE = "You are a test assistant.";

describe("user-memory", () => {
  let home: string;
  let projectRoot: string;
  const originalEnv = process.env.REASONIX_MEMORY;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-umem-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-umem-proj-"));
    // biome-ignore lint/performance/noDelete: avoid leaking "undefined" into env
    delete process.env.REASONIX_MEMORY;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: same
      delete process.env.REASONIX_MEMORY;
    } else {
      process.env.REASONIX_MEMORY = originalEnv;
    }
  });

  describe("sanitizeMemoryName", () => {
    it("accepts simple identifiers", () => {
      expect(sanitizeMemoryName("foo_bar")).toBe("foo_bar");
      expect(sanitizeMemoryName("abc-def.9")).toBe("abc-def.9");
      expect(sanitizeMemoryName("  padded  ")).toBe("padded");
    });
    it("rejects path-separator injection", () => {
      expect(() => sanitizeMemoryName("../etc/passwd")).toThrow(/invalid memory name/);
      expect(() => sanitizeMemoryName("foo/bar")).toThrow();
      expect(() => sanitizeMemoryName("foo\\bar")).toThrow();
    });
    it("rejects leading dot / too-short / too-long names", () => {
      expect(() => sanitizeMemoryName(".hidden")).toThrow();
      expect(() => sanitizeMemoryName("ab")).toThrow();
      expect(() => sanitizeMemoryName("a".repeat(41))).toThrow();
    });
  });

  describe("projectHash", () => {
    it("returns a stable 16-hex-char digest for the same path", () => {
      const a = projectHash("/tmp/whatever");
      const b = projectHash("/tmp/whatever");
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{16}$/);
    });
    it("differs across paths", () => {
      expect(projectHash("/tmp/a")).not.toBe(projectHash("/tmp/b"));
    });
  });

  describe("MemoryStore basic I/O", () => {
    it("writes a global memory and regenerates MEMORY.md", () => {
      const store = new MemoryStore({ homeDir: home });
      store.write({
        name: "snake_case",
        type: "feedback",
        scope: "global",
        description: "User prefers snake_case for new Python modules",
        body: "Rule.\n\n**Why:** PEP 8.\n\n**How to apply:** new .py files default to snake_case.",
      });
      const file = join(home, "memory", "global", "snake_case.md");
      expect(existsSync(file)).toBe(true);
      const raw = readFileSync(file, "utf8");
      expect(raw).toMatch(/^---\nname: snake_case\n/);
      expect(raw).toContain("Rule.");
      const indexPath = join(home, "memory", "global", MEMORY_INDEX_FILE);
      expect(existsSync(indexPath)).toBe(true);
      const index = readFileSync(indexPath, "utf8");
      expect(index).toContain("[snake_case](snake_case.md)");
      expect(index).toContain("User prefers snake_case");
    });

    it("round-trips write → read → list → delete for global scope", () => {
      const store = new MemoryStore({ homeDir: home });
      store.write({
        name: "one",
        type: "user",
        scope: "global",
        description: "First memory",
        body: "content one",
      });
      store.write({
        name: "two",
        type: "reference",
        scope: "global",
        description: "Second memory",
        body: "content two",
      });
      const listed = store.list();
      expect(listed.map((e) => e.name).sort()).toEqual(["one", "two"]);

      const one = store.read("global", "one");
      expect(one.body).toBe("content one");
      expect(one.type).toBe("user");
      expect(one.description).toBe("First memory");
      expect(one.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const removed = store.delete("global", "one");
      expect(removed).toBe(true);
      expect(store.list().map((e) => e.name)).toEqual(["two"]);

      // MEMORY.md should no longer reference "one".
      const index = readFileSync(join(home, "memory", "global", MEMORY_INDEX_FILE), "utf8");
      expect(index).not.toContain("one.md");
      expect(index).toContain("two.md");
    });

    it("returns false when deleting a nonexistent memory", () => {
      const store = new MemoryStore({ homeDir: home });
      expect(store.delete("global", "ghost")).toBe(false);
    });

    it("removes MEMORY.md entirely when the last memory is deleted", () => {
      const store = new MemoryStore({ homeDir: home });
      store.write({
        name: "only",
        type: "project",
        scope: "global",
        description: "d",
        body: "b",
      });
      store.delete("global", "only");
      const indexPath = join(home, "memory", "global", MEMORY_INDEX_FILE);
      expect(existsSync(indexPath)).toBe(false);
    });

    it("refuses project scope without a projectRoot", () => {
      const store = new MemoryStore({ homeDir: home });
      expect(store.hasProjectScope()).toBe(false);
      expect(() =>
        store.write({
          name: "nope",
          type: "project",
          scope: "project",
          description: "d",
          body: "b",
        }),
      ).toThrow(/projectRoot/);
    });

    it("routes project scope into the hashed subdir", () => {
      const store = new MemoryStore({ homeDir: home, projectRoot });
      expect(store.hasProjectScope()).toBe(true);
      store.write({
        name: "bun_build",
        type: "project",
        scope: "project",
        description: "Build command is `bun run build` on this machine",
        body: "Body here.",
      });
      const hashDir = join(home, "memory", projectHash(projectRoot));
      const file = join(hashDir, "bun_build.md");
      expect(existsSync(file)).toBe(true);
      // Global scope dir should NOT contain the project file.
      expect(existsSync(join(home, "memory", "global", "bun_build.md"))).toBe(false);
    });

    it("validates description / body non-empty", () => {
      const store = new MemoryStore({ homeDir: home });
      expect(() =>
        store.write({ name: "x_y_z", type: "user", scope: "global", description: "", body: "b" }),
      ).toThrow(/description/);
      expect(() =>
        store.write({
          name: "x_y_z",
          type: "user",
          scope: "global",
          description: "d",
          body: " \n",
        }),
      ).toThrow(/body/);
    });

    it("loadIndex returns null for absent scope, content + flag for present", () => {
      const store = new MemoryStore({ homeDir: home });
      expect(store.loadIndex("global")).toBeNull();
      store.write({
        name: "x_y_z",
        type: "user",
        scope: "global",
        description: "hi",
        body: "b",
      });
      const idx = store.loadIndex("global");
      expect(idx).not.toBeNull();
      expect(idx?.truncated).toBe(false);
      expect(idx?.content).toContain("x_y_z");
    });

    it("loadIndex truncates with a visible marker past the cap", () => {
      const store = new MemoryStore({ homeDir: home });
      // Write many entries so MEMORY.md crosses the cap.
      for (let i = 0; i < 80; i++) {
        store.write({
          name: `entry_${String(i).padStart(3, "0")}`,
          type: "user",
          scope: "global",
          description: "x".repeat(120),
          body: "b",
        });
      }
      const idx = store.loadIndex("global");
      expect(idx?.truncated).toBe(true);
      expect(idx?.content).toMatch(/truncated \d+ chars/);
      expect(idx?.content.length).toBeLessThan(MEMORY_INDEX_MAX_CHARS + 64);
    });

    it("list() skips malformed frontmatter gracefully", () => {
      const store = new MemoryStore({ homeDir: home });
      const dir = store.dir("global");
      writeFileSync(join(dir, "broken.md"), "no frontmatter here, just text\n", "utf8");
      store.write({
        name: "sane",
        type: "user",
        scope: "global",
        description: "ok",
        body: "b",
      });
      const entries = store.list();
      expect(entries.map((e) => e.name).sort()).toContain("sane");
    });

    it("regenerated MEMORY.md is byte-stable for identical file sets (cache-prefix safety)", () => {
      const storeA = new MemoryStore({ homeDir: home });
      storeA.write({ name: "a_one", type: "user", scope: "global", description: "d1", body: "b1" });
      storeA.write({ name: "b_two", type: "user", scope: "global", description: "d2", body: "b2" });
      const first = readFileSync(join(home, "memory", "global", MEMORY_INDEX_FILE), "utf8");
      // Delete + re-write in reverse order — sorted index should match.
      storeA.delete("global", "a_one");
      storeA.delete("global", "b_two");
      storeA.write({ name: "b_two", type: "user", scope: "global", description: "d2", body: "b2" });
      storeA.write({ name: "a_one", type: "user", scope: "global", description: "d1", body: "b1" });
      const second = readFileSync(join(home, "memory", "global", MEMORY_INDEX_FILE), "utf8");
      expect(second).toBe(first);
    });
  });

  describe("applyUserMemory", () => {
    it("is a no-op when both scopes are empty", () => {
      expect(applyUserMemory(BASE, { homeDir: home, projectRoot })).toBe(BASE);
    });

    it("appends only the global block when no project memory exists", () => {
      const store = new MemoryStore({ homeDir: home, projectRoot });
      store.write({
        name: "pref_one",
        type: "user",
        scope: "global",
        description: "prefers tabs",
        body: "b",
      });
      const out = applyUserMemory(BASE, { homeDir: home, projectRoot });
      expect(out).toContain("# User memory — global");
      expect(out).not.toContain("# User memory — this project");
      expect(out).toContain("pref_one");
    });

    it("appends both blocks when both scopes populated", () => {
      const store = new MemoryStore({ homeDir: home, projectRoot });
      store.write({
        name: "global_one",
        type: "user",
        scope: "global",
        description: "g",
        body: "b",
      });
      store.write({
        name: "project_one",
        type: "project",
        scope: "project",
        description: "p",
        body: "b",
      });
      const out = applyUserMemory(BASE, { homeDir: home, projectRoot });
      expect(out).toContain("# User memory — global");
      expect(out).toContain("# User memory — this project");
      expect(out).toContain("global_one");
      expect(out).toContain("project_one");
      // Global precedes project — stable ordering for cache hash.
      expect(out.indexOf("global_one")).toBeLessThan(out.indexOf("project_one"));
    });

    it("is deterministic — identical state ⇒ identical output (cache-safe)", () => {
      const store = new MemoryStore({ homeDir: home, projectRoot });
      store.write({
        name: "stable",
        type: "user",
        scope: "global",
        description: "d",
        body: "b",
      });
      const a = applyUserMemory(BASE, { homeDir: home, projectRoot });
      const b = applyUserMemory(BASE, { homeDir: home, projectRoot });
      expect(a).toBe(b);
    });

    it("respects REASONIX_MEMORY=off", () => {
      const store = new MemoryStore({ homeDir: home, projectRoot });
      store.write({
        name: "pref_one",
        type: "user",
        scope: "global",
        description: "d",
        body: "b",
      });
      process.env.REASONIX_MEMORY = "off";
      expect(applyUserMemory(BASE, { homeDir: home, projectRoot })).toBe(BASE);
    });

    it("skips the project block when no projectRoot is configured", () => {
      const store = new MemoryStore({ homeDir: home });
      store.write({
        name: "global_only",
        type: "user",
        scope: "global",
        description: "d",
        body: "b",
      });
      const out = applyUserMemory(BASE, { homeDir: home });
      expect(out).toContain("# User memory — global");
      expect(out).not.toContain("# User memory — this project");
    });
  });

  describe("applyMemoryStack", () => {
    it("composes REASONIX.md → global memory → project memory", () => {
      writeFileSync(join(projectRoot, "REASONIX.md"), "Pinned by REASONIX.md\n", "utf8");
      // applyMemoryStack uses ~/.reasonix by default — redirect via HOME
      // isn't portable across Windows; use the public applyUserMemory
      // directly for the global/project part and compose manually to
      // check ordering is what the helper produces.
      const withProj = applyProjectMemory(BASE, projectRoot);
      const store = new MemoryStore({ homeDir: home, projectRoot });
      store.write({
        name: "g_pref",
        type: "user",
        scope: "global",
        description: "global pref",
        body: "b",
      });
      store.write({
        name: "p_fact",
        type: "project",
        scope: "project",
        description: "project fact",
        body: "b",
      });
      const out = applyUserMemory(withProj, { homeDir: home, projectRoot });
      // Order: REASONIX.md content → global → project. Each unique
      // string should appear, and in that order.
      const iReasonix = out.indexOf("Pinned by REASONIX.md");
      const iGlobal = out.indexOf("g_pref");
      const iProject = out.indexOf("p_fact");
      expect(iReasonix).toBeGreaterThan(BASE.length - 1);
      expect(iGlobal).toBeGreaterThan(iReasonix);
      expect(iProject).toBeGreaterThan(iGlobal);
    });

    it("applyMemoryStack injects no memory blocks when no memory is set", () => {
      // No REASONIX.md, no HOME memory → no memory blocks. The bundled
      // builtin skills (`explore`, `research`) still inject a Skills
      // index, so we assert the absence of the memory-specific blocks
      // rather than raw equality with BASE.
      const out = applyMemoryStack(BASE, projectRoot);
      expect(out).toContain(BASE);
      expect(out).not.toMatch(/# Project memory/);
      expect(out).not.toMatch(/# User memory/);
      expect(out).not.toMatch(/# Global memory/);
    });
  });

  describe("applyGlobalReasonixMemory", () => {
    it("loads ~/.reasonix/REASONIX.md when present", () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "REASONIX.md"), "- always pnpm not npm\n", "utf8");
      const out = applyGlobalReasonixMemory(BASE, home);
      expect(out).toContain("# Global memory");
      expect(out).toContain("always pnpm not npm");
      expect(out.startsWith(BASE)).toBe(true);
    });

    it("returns BASE unchanged when the file is missing", () => {
      const out = applyGlobalReasonixMemory(BASE, home);
      expect(out).toBe(BASE);
    });

    it("returns BASE unchanged when the file is empty / whitespace-only", () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "REASONIX.md"), "   \n  \n", "utf8");
      const out = applyGlobalReasonixMemory(BASE, home);
      expect(out).toBe(BASE);
    });

    it("respects REASONIX_MEMORY=off opt-out", () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "REASONIX.md"), "- secret\n", "utf8");
      const orig = process.env.REASONIX_MEMORY;
      process.env.REASONIX_MEMORY = "off";
      try {
        const out = applyGlobalReasonixMemory(BASE, home);
        expect(out).toBe(BASE);
      } finally {
        if (orig === undefined) {
          // biome-ignore lint/performance/noDelete: env key must lose presence
          delete process.env.REASONIX_MEMORY;
        } else {
          process.env.REASONIX_MEMORY = orig;
        }
      }
    });
  });
});
