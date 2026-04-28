import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AT_MENTION_PATTERN,
  AT_PICKER_PREFIX,
  AT_URL_PATTERN,
  type AtUrlExpansion,
  DEFAULT_AT_MENTION_MAX_BYTES,
  DEFAULT_PICKER_IGNORE_DIRS,
  detectAtPicker,
  expandAtMentions,
  expandAtUrls,
  listFilesSync,
  listFilesWithStatsAsync,
  rankPickerCandidates,
  stripUrlTail,
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

  it("sorts by mtime descending when entries carry FileWithStats and query is empty", () => {
    const entries = [
      { path: "a.ts", mtimeMs: 100 },
      { path: "b.ts", mtimeMs: 300 },
      { path: "c.ts", mtimeMs: 200 },
    ];
    const r = rankPickerCandidates(entries, "", 5);
    // Newest (b, mtime 300) → middle (c, 200) → oldest (a, 100).
    expect(r).toEqual(["b.ts", "c.ts", "a.ts"]);
  });

  it("recently-used paths float to the top on empty query regardless of mtime", () => {
    const entries = [
      { path: "a.ts", mtimeMs: 300 },
      { path: "b.ts", mtimeMs: 100 },
      { path: "c.ts", mtimeMs: 200 },
    ];
    const r = rankPickerCandidates(entries, "", {
      limit: 5,
      recentlyUsed: ["c.ts"],
    });
    // Recently-used c.ts comes first even though a.ts has a newer mtime.
    expect(r[0]).toBe("c.ts");
    // Remaining sorted by mtime descending.
    expect(r[1]).toBe("a.ts");
    expect(r[2]).toBe("b.ts");
  });

  it("tie-breaks query matches by recently-used, then mtime", () => {
    const entries = [
      { path: "src/alpha.ts", mtimeMs: 100 },
      { path: "src/alpha2.ts", mtimeMs: 500 }, // newer
    ];
    const r = rankPickerCandidates(entries, "alpha", { limit: 5 });
    // Both match with the same score (basename prefix, same hit
    // position) — mtime tiebreak puts alpha2 first.
    expect(r[0]).toBe("src/alpha2.ts");
    expect(r[1]).toBe("src/alpha.ts");

    // Now with recency: older alpha.ts boosted over newer alpha2.ts.
    const r2 = rankPickerCandidates(entries, "alpha", {
      limit: 5,
      recentlyUsed: ["src/alpha.ts"],
    });
    expect(r2[0]).toBe("src/alpha.ts");
    expect(r2[1]).toBe("src/alpha2.ts");
  });

  it("preserves input order on empty query when no mtime + no recency signal", () => {
    // Back-compat: bare string input behaves as before.
    const r = rankPickerCandidates(files, "", 3);
    expect(r).toEqual(files.slice(0, 3));
  });

  it("accepts a number literal as the third arg for limit (back-compat)", () => {
    const r = rankPickerCandidates(files, "loop", 1);
    expect(r).toHaveLength(1);
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

describe("listFilesWithStatsAsync", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-listfiles-async-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    mkdirSync(join(root, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "README.md"), "# hi");
    writeFileSync(join(root, "src", "index.ts"), "");
    writeFileSync(join(root, "src", "cli", "app.ts"), "");
    writeFileSync(join(root, "node_modules", "foo", "index.js"), "");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the same shape as listFilesSync — DFS-alphabetical", async () => {
    const entries = await listFilesWithStatsAsync(root);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/cli/app.ts");
    // Forward slashes on every platform — same contract the sync
    // walk advertises.
    for (const e of entries) {
      expect(e.path).not.toContain("\\");
    }
  });

  it("skips default-ignored dirs (node_modules, .git, etc)", async () => {
    const entries = await listFilesWithStatsAsync(root);
    expect(entries.every((e) => !e.path.includes("node_modules"))).toBe(true);
  });

  it("respects maxResults", async () => {
    const entries = await listFilesWithStatsAsync(root, { maxResults: 2 });
    expect(entries.length).toBeLessThanOrEqual(2);
  });

  it("populates mtimeMs for each entry", async () => {
    const entries = await listFilesWithStatsAsync(root);
    for (const e of entries) {
      expect(e.mtimeMs).toBeGreaterThan(0);
    }
  });

  it("returns [] for an unreadable root", async () => {
    const entries = await listFilesWithStatsAsync(join(root, "does-not-exist"));
    expect(entries).toEqual([]);
  });
});

describe("AT_URL_PATTERN", () => {
  it("matches @http and @https at a word boundary", () => {
    const text = "see @https://example.com and @http://x.org/y for context";
    const matches = [...text.matchAll(AT_URL_PATTERN)].map((m) => m[1]);
    expect(matches).toEqual(["https://example.com", "http://x.org/y"]);
  });

  it("does NOT match @something-without-scheme", () => {
    const text = "@foo.ts @user @127.0.0.1 are not URLs";
    expect([...text.matchAll(AT_URL_PATTERN)]).toEqual([]);
  });

  it("does NOT match an URL embedded inside a longer word (no boundary)", () => {
    const text = "noatsign@https://example.com";
    expect([...text.matchAll(AT_URL_PATTERN)]).toEqual([]);
  });
});

describe("stripUrlTail", () => {
  it("strips trailing sentence punctuation", () => {
    expect(stripUrlTail("https://example.com.")).toBe("https://example.com");
    expect(stripUrlTail("https://example.com,")).toBe("https://example.com");
    expect(stripUrlTail("https://example.com!")).toBe("https://example.com");
    expect(stripUrlTail("https://example.com?")).toBe("https://example.com");
  });

  it("strips an unmatched closing bracket but keeps matched ones", () => {
    expect(stripUrlTail("https://example.com)")).toBe("https://example.com");
    // Matched: the URL has the open paren so we keep both.
    expect(stripUrlTail("https://example.com/(thing)")).toBe("https://example.com/(thing)");
  });

  it("preserves internal punctuation in path / query", () => {
    expect(stripUrlTail("https://x.com/a,b,c")).toBe("https://x.com/a,b,c");
    expect(stripUrlTail("https://x.com/?q=a&b=c")).toBe("https://x.com/?q=a&b=c");
  });

  it("handles a chain of trailing punctuation", () => {
    expect(stripUrlTail("https://x.com.).")).toBe("https://x.com");
  });

  it("returns empty string when everything strips away (degenerate input)", () => {
    expect(stripUrlTail("...")).toBe("");
  });
});

describe("expandAtUrls", () => {
  function fakeFetcher(map: Record<string, { title?: string; text: string; truncated?: boolean }>) {
    return async (url: string) => {
      const hit = map[url];
      if (!hit) throw new Error(`unknown URL in test: ${url}`);
      return {
        url,
        title: hit.title,
        text: hit.text,
        truncated: hit.truncated ?? false,
      };
    };
  }

  it("inlines fetched content under [Referenced URLs]", async () => {
    const fetcher = fakeFetcher({
      "https://example.com": { title: "Example", text: "Hello world" },
    });
    const out = await expandAtUrls("see @https://example.com for details", { fetcher });
    expect(out.expansions).toHaveLength(1);
    expect(out.expansions[0]?.ok).toBe(true);
    expect(out.expansions[0]?.title).toBe("Example");
    expect(out.text).toContain("[Referenced URLs]");
    expect(out.text).toContain('<url href="https://example.com" title="Example">');
    expect(out.text).toContain("Hello world");
    expect(out.text).toContain("</url>");
  });

  it("strips trailing punctuation before fetching", async () => {
    const fetcher = fakeFetcher({
      "https://example.com": { text: "body" },
    });
    const out = await expandAtUrls("look at @https://example.com.", { fetcher });
    expect(out.expansions[0]?.url).toBe("https://example.com");
  });

  it("dedupes — same URL referenced twice fetches once", async () => {
    let calls = 0;
    const fetcher = async (url: string) => {
      calls++;
      return { url, text: "x", truncated: false };
    };
    const out = await expandAtUrls("@https://example.com and again @https://example.com", {
      fetcher,
    });
    expect(calls).toBe(1);
    expect(out.expansions).toHaveLength(1);
  });

  it("uses the cache across calls when one is provided", async () => {
    let calls = 0;
    const fetcher = async (url: string) => {
      calls++;
      return { url, text: "cached body", truncated: false };
    };
    const cache = new Map<string, AtUrlExpansion & { body?: string }>();
    await expandAtUrls("@https://example.com", { fetcher, cache });
    expect(calls).toBe(1);
    const out2 = await expandAtUrls("@https://example.com again", { fetcher, cache });
    expect(calls).toBe(1); // cache hit, no second network call
    expect(out2.text).toContain("cached body");
  });

  it("emits a skipped <url /> tag on fetch failure (not a thrown error)", async () => {
    const fetcher = async () => {
      throw new Error("HTTP 503");
    };
    const out = await expandAtUrls("@https://example.com", { fetcher });
    expect(out.expansions).toHaveLength(1);
    expect(out.expansions[0]?.ok).toBe(false);
    expect(out.expansions[0]?.skip).toBe("fetch-error");
    expect(out.text).toContain('<url href="https://example.com" skipped="fetch-error" />');
  });

  it("tags timeouts and blocked responses for UI hinting", async () => {
    const timeoutFetcher = async () => {
      throw new Error("Request aborted: timeout");
    };
    const blockedFetcher = async () => {
      throw new Error("HTTP 403 Forbidden");
    };
    const t = await expandAtUrls("@https://slow.example", { fetcher: timeoutFetcher });
    expect(t.expansions[0]?.skip).toBe("timeout");
    const b = await expandAtUrls("@https://blocked.example", { fetcher: blockedFetcher });
    expect(b.expansions[0]?.skip).toBe("blocked");
  });

  it("returns input unchanged when no @url is in the text", async () => {
    const out = await expandAtUrls("plain text with no urls", {
      fetcher: async () => ({ url: "", text: "" }),
    });
    expect(out.text).toBe("plain text with no urls");
    expect(out.expansions).toEqual([]);
  });

  it("throws when no fetcher is provided (misconfiguration, not a runtime error)", async () => {
    await expect(expandAtUrls("@https://x.com", {})).rejects.toThrow(/fetcher option/);
  });

  it("escapes title attributes and never breaks XML on quotes/newlines", async () => {
    const fetcher = fakeFetcher({
      "https://x.com": { title: 'Weird "quoted"\ntitle', text: "body" },
    });
    const out = await expandAtUrls("@https://x.com", { fetcher });
    expect(out.text).toContain('title="Weird &quot;quoted&quot; title"');
    expect(out.text).not.toContain('"\n');
  });
});
