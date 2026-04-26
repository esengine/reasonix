import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendProjectMemory, detectHashMemory } from "../src/cli/ui/hash-memory.js";

describe("detectHashMemory", () => {
  it("returns the note body for a `#`-prefixed input", () => {
    expect(detectHashMemory("#always use pnpm")).toEqual({
      kind: "memory",
      note: "always use pnpm",
    });
  });

  it("trims whitespace after the hash", () => {
    expect(detectHashMemory("#  always use pnpm")).toEqual({
      kind: "memory",
      note: "always use pnpm",
    });
    expect(detectHashMemory("# always use pnpm  ")).toEqual({
      kind: "memory",
      note: "always use pnpm",
    });
  });

  it("returns null for non-hash input", () => {
    expect(detectHashMemory("always use pnpm")).toBeNull();
    expect(detectHashMemory("/help")).toBeNull();
    expect(detectHashMemory("!ls")).toBeNull();
    expect(detectHashMemory("")).toBeNull();
  });

  it("returns null for `#` alone or whitespace-only body", () => {
    expect(detectHashMemory("#")).toBeNull();
    expect(detectHashMemory("#   ")).toBeNull();
  });

  it("does NOT trigger on `##` or higher markdown headings", () => {
    // Level-2+ headings pass through to the model so users can talk
    // about markdown without their headings being eaten.
    expect(detectHashMemory("## section")).toBeNull();
    expect(detectHashMemory("### subsection")).toBeNull();
  });

  it("does NOT trigger when `#` appears mid-string", () => {
    expect(detectHashMemory("look at #foo")).toBeNull();
    expect(detectHashMemory("issue #123")).toBeNull();
  });

  it("recognizes `\\#` as an escape that produces a literal `#` prompt", () => {
    // User wants to send "# Title" to the model verbatim — backslash
    // escape strips the prefix and skips the memory write.
    expect(detectHashMemory("\\#title")).toEqual({ kind: "escape", text: "#title" });
    expect(detectHashMemory("\\# heading text")).toEqual({
      kind: "escape",
      text: "# heading text",
    });
  });
});

describe("appendProjectMemory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-hashmem-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("creates REASONIX.md with a header and the first bullet when absent", () => {
    const path = join(dir, "REASONIX.md");
    expect(existsSync(path)).toBe(false);
    const result = appendProjectMemory(dir, "always use pnpm");
    expect(result.created).toBe(true);
    expect(result.path).toBe(path);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("# Reasonix project memory");
    expect(content).toMatch(/- always use pnpm\n$/);
  });

  it("appends to an existing REASONIX.md without disturbing earlier content", () => {
    const path = join(dir, "REASONIX.md");
    writeFileSync(path, "# Custom header\n\nSome existing note.\n", "utf8");
    const result = appendProjectMemory(dir, "always use pnpm");
    expect(result.created).toBe(false);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("# Custom header");
    expect(content).toContain("Some existing note.");
    expect(content).toMatch(/- always use pnpm\n$/);
  });

  it("inserts a separator newline if the file lacks a trailing newline", () => {
    const path = join(dir, "REASONIX.md");
    writeFileSync(path, "no trailing newline", "utf8");
    appendProjectMemory(dir, "fresh note");
    const content = readFileSync(path, "utf8");
    expect(content).toBe("no trailing newline\n- fresh note\n");
  });

  it("appends multiple bullets in order across calls", () => {
    appendProjectMemory(dir, "first");
    appendProjectMemory(dir, "second");
    appendProjectMemory(dir, "third");
    const content = readFileSync(join(dir, "REASONIX.md"), "utf8");
    const bullets = content.match(/- (first|second|third)/g);
    expect(bullets).toEqual(["- first", "- second", "- third"]);
  });

  it("rejects empty / whitespace-only notes", () => {
    expect(() => appendProjectMemory(dir, "   ")).toThrow(/cannot be empty/);
  });

  it("respects nested rootDir paths (creates REASONIX.md in the given dir, not cwd)", () => {
    const nested = join(dir, "subproject");
    mkdirSync(nested);
    const result = appendProjectMemory(nested, "scoped note");
    expect(result.path).toBe(join(nested, "REASONIX.md"));
    expect(existsSync(join(dir, "REASONIX.md"))).toBe(false);
  });
});
