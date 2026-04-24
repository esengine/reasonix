import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AT_MENTION_PATTERN,
  AT_PICKER_PREFIX,
  DEFAULT_AT_MENTION_MAX_BYTES,
  DEFAULT_PICKER_IGNORE_DIRS,
  detectAtPicker,
  expandAtMentions,
  listFilesSync,
  rankPickerCandidates,
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

describe("detectAtPicker", () => {
  it("fires when the buffer ends with `@`", () => {
    const r = detectAtPicker("look at @");
    expect(r).not.toBeNull();
    expect(r!.query).toBe("");
    // `@` is at offset 8 (after "look at ").
    expect(r!.atOffset).toBe(8);
  });

  it("captures the partial query after `@`", () => {
    const r = detectAtPicker("edit @src/lo");
    expect(r).not.toBeNull();
    expect(r!.query).toBe("src/lo");
    expect(r!.atOffset).toBe(5);
  });

  it("does NOT fire when @ is embedded in a word", () => {
    expect(detectAtPicker("email@example.com")).toBeNull();
  });

  it("does NOT fire when the buffer ends with a space after the mention", () => {
    // Trailing space closes the picker — the user's done picking.
    expect(detectAtPicker("@src/loop.ts ")).toBeNull();
  });

  it("does NOT fire when there's no @ at all", () => {
    expect(detectAtPicker("just a normal message")).toBeNull();
  });

  it("fires at start of string", () => {
    const r = detectAtPicker("@sr");
    expect(r).not.toBeNull();
    expect(r!.query).toBe("sr");
    expect(r!.atOffset).toBe(0);
  });
});

describe("AT_PICKER_PREFIX vs AT_MENTION_PATTERN (sanity)", () => {
  it("picker captures empty partial", () => {
    const m = AT_PICKER_PREFIX.exec("hi @");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("");
  });

  it("expansion pattern requires a non-empty path", () => {
    // Completed mentions for expandAtMentions need at least one char.
    const m = [..."hi @".matchAll(AT_MENTION_PATTERN)];
    expect(m).toHaveLength(0);
  });
});

describe("rankPickerCandidates", () => {
  const files = [
    "src/loop.ts",
    "src/at-mentions.ts",
    "src/tokenizer.ts",
    "src/cli/ui/App.tsx",
    "src/cli/ui/PromptInput.tsx",
    "tests/loop.test.ts",
    "tests/at-mentions.test.ts",
    "README.md",
  ];

  it("returns the first `limit` entries when query is empty", () => {
    const r = rankPickerCandidates(files, "", 3);
    expect(r).toHaveLength(3);
    expect(r).toEqual(files.slice(0, 3));
  });

  it("filters by substring match (case-insensitive)", () => {
    const r = rankPickerCandidates(files, "LOOP");
    expect(r).toContain("src/loop.ts");
    expect(r).toContain("tests/loop.test.ts");
    expect(r).not.toContain("README.md");
  });

  it("ranks basename-prefix matches above substring matches", () => {
    // `ment` appears in "at-mentions" (both src and tests). Basenames
    // are "at-mentions.ts" and "at-mentions.test.ts" — both start
    // with `at-m` not `ment`. Not a basename-prefix hit; both should
    // score the same (substring).
    const r = rankPickerCandidates(files, "at-m");
    // `at-m` is a basename prefix for both at-mentions files:
    expect(r[0]).toMatch(/at-mentions/);
    expect(r[1]).toMatch(/at-mentions/);
  });

  it("ranks path-prefix above substring when basename doesn't match", () => {
    // `tests/` is a path prefix (not basename). Both tests/* hit.
    const r = rankPickerCandidates(files, "tests/");
    expect(r[0]).toMatch(/^tests\//);
  });

  it("returns empty array when nothing matches", () => {
    const r = rankPickerCandidates(files, "zzznomatch");
    expect(r).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const r = rankPickerCandidates(files, "s", 2);
    expect(r).toHaveLength(2);
  });
});

describe("listFilesSync", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-listfiles-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    mkdirSync(join(root, "node_modules", "foo"), { recursive: true });
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "README.md"), "# hi");
    writeFileSync(join(root, ".gitignore"), "dist/");
    writeFileSync(join(root, "src", "index.ts"), "");
    writeFileSync(join(root, "src", "cli", "app.ts"), "");
    writeFileSync(join(root, "node_modules", "foo", "index.js"), "");
    writeFileSync(join(root, ".git", "objects", "abc"), "");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns files recursively, with forward-slash separators", () => {
    const files = listFilesSync(root);
    expect(files).toContain("package.json");
    expect(files).toContain("README.md");
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/cli/app.ts");
    // All entries use forward slashes even on Windows.
    for (const f of files) {
      expect(f).not.toContain("\\");
    }
  });

  it("skips ignored directories by default", () => {
    const files = listFilesSync(root);
    expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
    expect(files.every((f) => !f.includes(".git/"))).toBe(true);
  });

  it("includes dotfiles at the top level (e.g. .gitignore)", () => {
    const files = listFilesSync(root);
    expect(files).toContain(".gitignore");
  });

  it("respects custom ignoreDirs", () => {
    const files = listFilesSync(root, { ignoreDirs: ["src"] });
    expect(files.every((f) => !f.startsWith("src/"))).toBe(true);
    expect(files).toContain("package.json");
  });

  it("caps the result count at maxResults", () => {
    const files = listFilesSync(root, { maxResults: 2 });
    expect(files.length).toBeLessThanOrEqual(2);
  });

  it("returns an empty list for an unreadable root (falls through)", () => {
    const files = listFilesSync(join(root, "does-not-exist"));
    expect(files).toEqual([]);
  });

  it("exposes the default ignore list", () => {
    expect(DEFAULT_PICKER_IGNORE_DIRS).toContain("node_modules");
    expect(DEFAULT_PICKER_IGNORE_DIRS).toContain(".git");
    expect(DEFAULT_PICKER_IGNORE_DIRS).toContain("dist");
  });
});
