/** REASONIX.md project-memory loader — filesystem-backed tests in a temp dir. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODE_SYSTEM_PROMPT, codeSystemPrompt } from "../src/code/prompt.js";
import {
  PROJECT_MEMORY_FILE,
  PROJECT_MEMORY_MAX_CHARS,
  applyProjectMemory,
  memoryEnabled,
  readProjectMemory,
} from "../src/memory/project.js";

const BASE = "You are a test assistant.";

describe("project-memory", () => {
  let root: string;
  const originalEnv = process.env.REASONIX_MEMORY;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-mem-"));
    // biome-ignore lint/performance/noDelete: avoid leaking "undefined" into env
    delete process.env.REASONIX_MEMORY;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: same reason
      delete process.env.REASONIX_MEMORY;
    } else {
      process.env.REASONIX_MEMORY = originalEnv;
    }
  });

  describe("readProjectMemory", () => {
    it("returns null when REASONIX.md is absent", () => {
      expect(readProjectMemory(root)).toBeNull();
    });

    it("returns null when REASONIX.md is empty / whitespace-only", () => {
      writeFileSync(join(root, PROJECT_MEMORY_FILE), "   \n\n\t  \n", "utf8");
      expect(readProjectMemory(root)).toBeNull();
    });

    it("returns trimmed content + correct metadata for a normal file", () => {
      const body = "# Notes\nAlways prefer tabs over spaces in this repo.\n";
      writeFileSync(join(root, PROJECT_MEMORY_FILE), `\n\n${body}\n\n`, "utf8");
      const mem = readProjectMemory(root);
      expect(mem).not.toBeNull();
      expect(mem?.content).toBe(body.trim());
      expect(mem?.truncated).toBe(false);
      expect(mem?.originalChars).toBe(body.trim().length);
      expect(mem?.path.endsWith(PROJECT_MEMORY_FILE)).toBe(true);
    });

    it("truncates with a visible marker when over PROJECT_MEMORY_MAX_CHARS", () => {
      const huge = "x".repeat(PROJECT_MEMORY_MAX_CHARS + 1500);
      writeFileSync(join(root, PROJECT_MEMORY_FILE), huge, "utf8");
      const mem = readProjectMemory(root);
      expect(mem?.truncated).toBe(true);
      expect(mem?.originalChars).toBe(PROJECT_MEMORY_MAX_CHARS + 1500);
      expect(mem?.content).toMatch(/truncated 1500 chars/);
      // Content is bounded: first MAX chars + the marker line.
      expect(mem?.content.length).toBeLessThan(PROJECT_MEMORY_MAX_CHARS + 64);
    });
  });

  describe("memoryEnabled", () => {
    it("defaults to true when env is unset", () => {
      expect(memoryEnabled()).toBe(true);
    });

    it.each(["off", "false", "0"])("returns false for REASONIX_MEMORY=%s", (val) => {
      process.env.REASONIX_MEMORY = val;
      expect(memoryEnabled()).toBe(false);
    });

    it("returns true for unrelated env values (on, 1, truthy, etc.)", () => {
      for (const val of ["on", "1", "true", "yes"]) {
        process.env.REASONIX_MEMORY = val;
        expect(memoryEnabled()).toBe(true);
      }
    });
  });

  describe("applyProjectMemory", () => {
    it("returns the base prompt unchanged when no memory file exists", () => {
      expect(applyProjectMemory(BASE, root)).toBe(BASE);
    });

    it("appends a '# Project memory' fenced block when the file exists", () => {
      writeFileSync(
        join(root, PROJECT_MEMORY_FILE),
        "# Notes\nTreat snake_case as the house style.\n",
        "utf8",
      );
      const out = applyProjectMemory(BASE, root);
      expect(out.length).toBeGreaterThan(BASE.length);
      expect(out).toMatch(/# Project memory \(REASONIX\.md\)/);
      expect(out).toContain("snake_case");
      // Fenced block present.
      expect(out).toMatch(/```\n[\s\S]*```/);
    });

    it("no-ops when REASONIX_MEMORY=off, even with a file present", () => {
      writeFileSync(join(root, PROJECT_MEMORY_FILE), "content\n", "utf8");
      process.env.REASONIX_MEMORY = "off";
      expect(applyProjectMemory(BASE, root)).toBe(BASE);
    });

    it("is deterministic for identical inputs (cache-prefix-safe)", () => {
      writeFileSync(join(root, PROJECT_MEMORY_FILE), "stable content\n", "utf8");
      const a = applyProjectMemory(BASE, root);
      const b = applyProjectMemory(BASE, root);
      expect(a).toBe(b);
    });
  });

  describe("codeSystemPrompt integration", () => {
    it("stacks base → memory → .gitignore when both files exist", () => {
      writeFileSync(
        join(root, PROJECT_MEMORY_FILE),
        "## House rules\nAlways write tests alongside new tools.\n",
        "utf8",
      );
      writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n", "utf8");
      const out = codeSystemPrompt(root);
      const memIdx = out.indexOf("# Project memory");
      const gitIdx = out.indexOf("# Project .gitignore");
      expect(memIdx).toBeGreaterThan(CODE_SYSTEM_PROMPT.length - 1);
      expect(gitIdx).toBeGreaterThan(memIdx);
      expect(out).toContain("Always write tests");
      expect(out).toContain("node_modules/");
    });

    it("memory alone (no .gitignore) still appends only the memory block", () => {
      writeFileSync(join(root, PROJECT_MEMORY_FILE), "memory-only content\n", "utf8");
      const out = codeSystemPrompt(root);
      expect(out).toContain("memory-only content");
      expect(out).not.toMatch(/# Project \.gitignore/);
    });
  });
});
