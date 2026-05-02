/**
 * Tests for `codeSystemPrompt` — the .gitignore injection helper.
 * Pure I/O at the edge, so filesystem-backed tests using a temp dir.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODE_SYSTEM_PROMPT, codeSystemPrompt } from "../src/code/prompt.js";

describe("codeSystemPrompt", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-prompt-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not append a .gitignore section when none exists", () => {
    // We can no longer assert raw equality with CODE_SYSTEM_PROMPT —
    // the bundled builtin skills (`explore`, `research`) always inject
    // a `# Skills` block via applySkillsIndex. Assert the absence of
    // the .gitignore-specific section instead.
    const out = codeSystemPrompt(root);
    expect(out).not.toMatch(/# Project \.gitignore/);
    expect(out).toContain(CODE_SYSTEM_PROMPT);
  });

  it("appends the .gitignore content as a fenced block", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n.env\n", "utf8");
    const out = codeSystemPrompt(root);
    expect(out.length).toBeGreaterThan(CODE_SYSTEM_PROMPT.length);
    expect(out).toMatch(/# Project \.gitignore/);
    expect(out).toContain("node_modules/");
    expect(out).toContain(".env");
  });

  it("truncates a .gitignore larger than 2000 chars", () => {
    const huge = `${"# comment ".repeat(500)}\n`; // ~5000 chars
    writeFileSync(join(root, ".gitignore"), huge, "utf8");
    const out = codeSystemPrompt(root);
    expect(out).toMatch(/truncated \d+ chars/);
    // The .gitignore block (base + truncated + fences) is bounded.
    // Allow extra slack for the builtin Skills index that applyMemoryStack
    // also injects — that's a fixed-size addition, not unbounded.
    expect(out.length).toBeLessThan(CODE_SYSTEM_PROMPT.length + 4500);
  });

  it("reminds the model to skip dependency / build / VCS dirs", () => {
    // We don't enumerate specific names in the prompt anymore (too
    // ecosystem-biased); the principle is stated generically and the
    // pinned .gitignore block is the authoritative denylist.
    expect(CODE_SYSTEM_PROMPT).toMatch(/dependency.*build.*VCS|skip/i);
  });

  describe("semantic_search routing fragment", () => {
    it("is absent by default (no index registered)", () => {
      const out = codeSystemPrompt(root);
      expect(out).not.toMatch(/# Search routing/);
    });

    it("is appended when hasSemanticSearch is true", () => {
      const out = codeSystemPrompt(root, { hasSemanticSearch: true });
      expect(out).toMatch(/# Search routing/);
      expect(out).toMatch(/semantic_search/);
      expect(out).toMatch(/search_content/);
      expect(out).toMatch(/Descriptive queries/);
    });

    it("places the routing fragment BEFORE the .gitignore section", () => {
      // .gitignore content can change between sessions; the routing
      // fragment must sit before it so the cacheable portion of the
      // prompt remains contiguous.
      writeFileSync(join(root, ".gitignore"), "node_modules\n");
      const out = codeSystemPrompt(root, { hasSemanticSearch: true });
      const routingAt = out.indexOf("# Search routing");
      const gitignoreAt = out.indexOf("# Project .gitignore");
      expect(routingAt).toBeGreaterThan(0);
      expect(gitignoreAt).toBeGreaterThan(routingAt);
    });
  });

  describe("system append", () => {
    it("does not add a User System Append section when neither option is provided", () => {
      const out = codeSystemPrompt(root);
      expect(out).not.toMatch(/# User System Append/);
    });

    it("preserves the base system prompt when appending", () => {
      const out = codeSystemPrompt(root, { systemAppend: "Extra rule." });
      expect(out).toContain(CODE_SYSTEM_PROMPT);
    });

    it("appends an inline systemAppend string under a # User System Append heading", () => {
      const out = codeSystemPrompt(root, {
        systemAppend: "Always inspect relevant files before editing.",
      });
      expect(out).toMatch(/# User System Append/);
      expect(out).toContain("Always inspect relevant files before editing.");
    });

    it("appends systemAppendFile contents under the # User System Append heading", () => {
      const out = codeSystemPrompt(root, { systemAppendFile: "Run tests before committing." });
      expect(out).toMatch(/# User System Append/);
      expect(out).toContain("Run tests before committing.");
    });

    it("appends inline prompt first, then file contents, when both are provided", () => {
      const out = codeSystemPrompt(root, {
        systemAppend: "First instruction.",
        systemAppendFile: "Second instruction.",
      });
      expect(out).toMatch(/# User System Append/);
      const appendIdx = out.indexOf("# User System Append");
      const firstIdx = out.indexOf("First instruction.", appendIdx);
      const secondIdx = out.indexOf("Second instruction.", appendIdx);
      expect(firstIdx).toBeGreaterThan(0);
      expect(secondIdx).toBeGreaterThan(firstIdx);
    });

    it("places the append section after the .gitignore section", () => {
      writeFileSync(join(root, ".gitignore"), "node_modules\n");
      const out = codeSystemPrompt(root, { systemAppend: "Post-gitignore instruction." });
      const gitignoreAt = out.indexOf("# Project .gitignore");
      const appendAt = out.indexOf("# User System Append");
      expect(gitignoreAt).toBeGreaterThan(0);
      expect(appendAt).toBeGreaterThan(gitignoreAt);
    });
  });
});
