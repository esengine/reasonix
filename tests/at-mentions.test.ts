import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AT_MENTION_PATTERN,
  DEFAULT_AT_MENTION_MAX_BYTES,
  expandAtMentions,
} from "../src/at-mentions.js";

describe("AT_MENTION_PATTERN", () => {
  it("matches @path at start of string", () => {
    const matches = [...".".matchAll(AT_MENTION_PATTERN)];
    expect(matches).toHaveLength(0);
    const m2 = [..."@src/loop.ts".matchAll(AT_MENTION_PATTERN)];
    expect(m2).toHaveLength(1);
    expect(m2[0]![1]).toBe("src/loop.ts");
  });

  it("matches @path after whitespace", () => {
    const m = [..."look at @src/loop.ts please".matchAll(AT_MENTION_PATTERN)];
    expect(m).toHaveLength(1);
    expect(m[0]![1]).toBe("src/loop.ts");
  });

  it("does NOT match @ embedded in a word (email, social handle)", () => {
    const m1 = [..."email user@example.com".matchAll(AT_MENTION_PATTERN)];
    expect(m1).toHaveLength(0);
    const m2 = [..."foo@bar".matchAll(AT_MENTION_PATTERN)];
    expect(m2).toHaveLength(0);
  });

  it("matches multiple @paths in one string", () => {
    const m = [..."compare @a.ts and @b.ts".matchAll(AT_MENTION_PATTERN)];
    expect(m).toHaveLength(2);
    expect(m[0]![1]).toBe("a.ts");
    expect(m[1]![1]).toBe("b.ts");
  });
});

describe("expandAtMentions", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-at-mentions-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "loop.ts"), "export const x = 1;\n");
    writeFileSync(join(root, "notes.md"), "# Notes\nhello\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns text unchanged when there are no mentions", () => {
    const r = expandAtMentions("plain prompt with no mentions", root);
    expect(r.text).toBe("plain prompt with no mentions");
    expect(r.expansions).toEqual([]);
  });

  it("inlines an existing file under a `Referenced files` block", () => {
    const r = expandAtMentions("look at @src/loop.ts", root);
    expect(r.expansions).toHaveLength(1);
    expect(r.expansions[0]!.ok).toBe(true);
    expect(r.expansions[0]!.path).toBe("src/loop.ts");
    expect(r.text).toContain("look at @src/loop.ts");
    expect(r.text).toContain("[Referenced files]");
    expect(r.text).toContain('<file path="src/loop.ts">');
    expect(r.text).toContain("export const x = 1;");
    expect(r.text).toContain("</file>");
  });

  it("de-duplicates repeated mentions of the same file", () => {
    const r = expandAtMentions("compare @src/loop.ts with @src/loop.ts", root);
    expect(r.expansions).toHaveLength(1);
    // Only one file block in the output.
    const fileBlocks = r.text.match(/<file path="/g) ?? [];
    expect(fileBlocks).toHaveLength(1);
  });

  it("expands multiple different files in the same prompt", () => {
    const r = expandAtMentions("read @src/loop.ts and @notes.md", root);
    expect(r.expansions).toHaveLength(2);
    expect(r.expansions.every((ex) => ex.ok)).toBe(true);
    expect(r.text).toContain('<file path="src/loop.ts">');
    expect(r.text).toContain('<file path="notes.md">');
  });

  it("marks missing files as skipped with a reason", () => {
    const r = expandAtMentions("look at @src/does-not-exist.ts", root);
    expect(r.expansions).toHaveLength(1);
    expect(r.expansions[0]!.ok).toBe(false);
    expect(r.expansions[0]!.skip).toBe("missing");
    expect(r.text).toContain('skipped="missing"');
  });

  it("rejects paths that escape the root directory", () => {
    const r = expandAtMentions("peek at @../../../etc/passwd", root);
    expect(r.expansions).toHaveLength(1);
    expect(r.expansions[0]!.skip).toBe("escape");
    expect(r.text).not.toContain("passwd content");
  });

  it("rejects absolute paths", () => {
    const r = expandAtMentions("look at @/etc/hosts", root);
    expect(r.expansions).toHaveLength(1);
    expect(r.expansions[0]!.skip).toBe("escape");
  });

  it("skips files larger than maxBytes", () => {
    const big = join(root, "big.log");
    writeFileSync(big, "x".repeat(1000));
    const r = expandAtMentions("inspect @big.log", root, { maxBytes: 500 });
    expect(r.expansions).toHaveLength(1);
    expect(r.expansions[0]!.ok).toBe(false);
    expect(r.expansions[0]!.skip).toBe("too-large");
    expect(r.expansions[0]!.bytes).toBe(1000);
    expect(r.text).toContain('skipped="too-large"');
  });

  it("strips a trailing sentence-terminator dot from the path", () => {
    // `@src/loop.ts.` — the trailing `.` is a sentence period, not
    // part of the filename. The mention should resolve src/loop.ts.
    const r = expandAtMentions("look at @src/loop.ts.", root);
    expect(r.expansions).toHaveLength(1);
    expect(r.expansions[0]!.ok).toBe(true);
    expect(r.expansions[0]!.path).toBe("src/loop.ts");
  });

  it("default max bytes is 64KB", () => {
    expect(DEFAULT_AT_MENTION_MAX_BYTES).toBe(64 * 1024);
  });

  it("marks a directory mention as not-file", () => {
    const r = expandAtMentions("look at @src", root);
    expect(r.expansions).toHaveLength(1);
    expect(r.expansions[0]!.ok).toBe(false);
    expect(r.expansions[0]!.skip).toBe("not-file");
  });
});
