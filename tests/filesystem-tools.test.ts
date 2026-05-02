import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { lineDiff, registerFilesystemTools } from "../src/tools/filesystem.js";

describe("filesystem tools (built-in, sandbox-enforced)", () => {
  let root: string;
  let tools: ToolRegistry;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reasonix-fs-"));
    tools = new ToolRegistry();
    registerFilesystemTools(tools, { rootDir: root });
    await fs.writeFile(join(root, "hello.txt"), "line 1\nline 2\nline 3\n");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.writeFile(join(root, "src", "index.ts"), "export const x = 1;\n");
    await fs.writeFile(join(root, "src", "util.ts"), "export const y = 2;\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("read_file", () => {
    it("reads the full contents", async () => {
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt" }));
      expect(out).toContain("line 1");
      expect(out).toContain("line 3");
    });

    it("honors head=N to return only the first N lines", async () => {
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt", head: 2 }));
      // Head output now includes an "N of M lines" marker so the model
      // knows it didn't get the whole file. The actual content still
      // leads the string, un-escaped.
      expect(out).toMatch(/^line 1\nline 2/);
      expect(out).toMatch(/head 2 of 3 lines/);
    });

    it("honors tail=N", async () => {
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt", tail: 2 }));
      expect(out).toContain("line 2");
      expect(out).toContain("line 3");
      expect(out).not.toContain("line 1");
      expect(out).toMatch(/tail 2 of 3 lines/);
    });

    it("range='A-B' returns the inclusive line range", async () => {
      // Write a bigger file so the range slice is distinguishable from
      // the head/tail paths and the auto-preview cutover.
      await fs.writeFile(
        join(root, "big.txt"),
        Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"),
      );
      const out = await tools.dispatch(
        "read_file",
        JSON.stringify({ path: "big.txt", range: "3-5" }),
      );
      expect(out).toMatch(/\[range 3-5 of 10 lines\]/);
      expect(out).toContain("line 3");
      expect(out).toContain("line 5");
      expect(out).not.toContain("line 2");
      expect(out).not.toContain("line 6");
    });

    it("range clamps out-of-range values to the file bounds", async () => {
      const out = await tools.dispatch(
        "read_file",
        JSON.stringify({ path: "hello.txt", range: "2-99" }),
      );
      expect(out).toMatch(/\[range 2-3 of 3 lines\]/);
      expect(out).toContain("line 2");
      expect(out).toContain("line 3");
    });

    it("auto-previews large files when no scope is given", async () => {
      // File larger than DEFAULT_AUTO_PREVIEW_LINES (200) triggers the
      // head+tail preview + omitted-lines marker.
      const bigLines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
      await fs.writeFile(join(root, "huge.txt"), bigLines.join("\n"));
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "huge.txt" }));
      expect(out).toMatch(/auto-preview: head 80 \+ tail 40 of 250 lines/);
      expect(out).toMatch(/130 lines omitted/);
      expect(out).toContain("line 1");
      expect(out).toContain("line 80");
      expect(out).toContain("line 211");
      expect(out).toContain("line 250");
      expect(out).not.toContain("line 100");
      expect(out).not.toContain("line 200");
    });

    it("returns full content when file is at or below the auto-preview threshold", async () => {
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt" }));
      expect(out).toBe("line 1\nline 2\nline 3");
    });

    it("rejects paths outside the sandbox root", async () => {
      const out = await tools.dispatch(
        "read_file",
        JSON.stringify({ path: "../../../etc/passwd" }),
      );
      expect(out).toMatch(/escapes sandbox/);
    });

    it("reinterprets POSIX-absolute paths as sandbox-relative (model can't escape via /)", async () => {
      // Sandbox-root semantics: `/etc/passwd` becomes `etc/passwd`
      // under rootDir. Real /etc/passwd stays unreachable; the lookup
      // just fails because <root>/etc/passwd doesn't exist.
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "/etc/passwd" }));
      expect(out).not.toMatch(/escapes sandbox/);
      expect(out).toMatch(/ENOENT|no such file/i);
    });

    it("returns a truncation notice when file exceeds maxReadBytes", async () => {
      const tiny = new ToolRegistry();
      registerFilesystemTools(tiny, { rootDir: root, maxReadBytes: 10 });
      const out = await tiny.dispatch("read_file", JSON.stringify({ path: "hello.txt" }));
      expect(out).toMatch(/truncated/);
    });

    it("refuses to read a directory as a file", async () => {
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "src" }));
      expect(out).toMatch(/not a file/);
    });
  });

  describe("list_directory / directory_tree", () => {
    it("list_directory shows entries with trailing slash for dirs", async () => {
      const out = await tools.dispatch("list_directory", JSON.stringify({ path: "." }));
      expect(out).toContain("hello.txt");
      expect(out).toContain("src/");
    });

    it("directory_tree recurses", async () => {
      const out = await tools.dispatch("directory_tree", JSON.stringify({ path: "." }));
      expect(out).toContain("hello.txt");
      expect(out).toContain("src/");
      expect(out).toContain("index.ts");
      expect(out).toContain("util.ts");
    });

    it("directory_tree respects maxDepth", async () => {
      const out = await tools.dispatch(
        "directory_tree",
        JSON.stringify({ path: ".", maxDepth: 0 }),
      );
      // With depth 0 we list the top level only — no descent into src/.
      expect(out).toContain("src/");
      expect(out).not.toContain("index.ts");
    });

    it("directory_tree skips node_modules / .git / dist by default", async () => {
      await fs.mkdir(join(root, "node_modules", "foo"), { recursive: true });
      await fs.writeFile(join(root, "node_modules", "foo", "dep.js"), "// dep\n");
      await fs.mkdir(join(root, ".git"), { recursive: true });
      await fs.writeFile(join(root, ".git", "HEAD"), "ref\n");
      await fs.mkdir(join(root, "dist"), { recursive: true });
      await fs.writeFile(join(root, "dist", "out.js"), "// out\n");
      const out = await tools.dispatch("directory_tree", JSON.stringify({ path: "." }));
      // Skip markers show the dir exists but don't walk into it.
      expect(out).toMatch(/node_modules\/\s+\(skipped/);
      expect(out).toMatch(/\.git\/\s+\(skipped/);
      expect(out).toMatch(/dist\/\s+\(skipped/);
      expect(out).not.toContain("dep.js");
      expect(out).not.toContain("HEAD");
      expect(out).not.toContain("out.js");
    });

    it("directory_tree traverses deps when include_deps:true", async () => {
      await fs.mkdir(join(root, "node_modules", "foo"), { recursive: true });
      await fs.writeFile(join(root, "node_modules", "foo", "dep.js"), "// dep\n");
      const out = await tools.dispatch(
        "directory_tree",
        JSON.stringify({ path: ".", include_deps: true, maxDepth: 3 }),
      );
      expect(out).toContain("dep.js");
      expect(out).not.toMatch(/skipped/);
    });

    it("directory_tree default maxDepth is 2", async () => {
      await fs.mkdir(join(root, "a", "b", "c"), { recursive: true });
      await fs.writeFile(join(root, "a", "b", "c", "deep.txt"), "x\n");
      await fs.writeFile(join(root, "a", "b", "shallow.txt"), "y\n");
      const out = await tools.dispatch("directory_tree", JSON.stringify({ path: "." }));
      // depth 2 shows a/, a/b/, a/b/shallow.txt — but NOT a/b/c's children.
      expect(out).toContain("shallow.txt");
      expect(out).toContain("c/");
      expect(out).not.toContain("deep.txt");
    });

    it("directory_tree collapses directories with >50 entries", async () => {
      await fs.mkdir(join(root, "huge"), { recursive: true });
      for (let i = 0; i < 60; i++) {
        await fs.writeFile(join(root, "huge", `f${String(i).padStart(3, "0")}.txt`), "x");
      }
      const out = await tools.dispatch(
        "directory_tree",
        JSON.stringify({ path: "huge", maxDepth: 1 }),
      );
      expect(out).toMatch(/\[… \d+ entries hidden/);
      expect(out).toMatch(/list_directory/);
    });
  });

  describe("search_files", () => {
    it("finds matching filenames recursively", async () => {
      const out = await tools.dispatch("search_files", JSON.stringify({ pattern: "index" }));
      expect(out).toContain("index.ts");
    });

    it("is case-insensitive", async () => {
      const out = await tools.dispatch("search_files", JSON.stringify({ pattern: "HELLO" }));
      expect(out).toContain("hello.txt");
    });

    it("reports no-matches cleanly", async () => {
      const out = await tools.dispatch("search_files", JSON.stringify({ pattern: "nothing123" }));
      expect(out).toBe("(no matches)");
    });

    it("treats path: '/' as the sandbox root (model's POSIX intuition)", async () => {
      // Common model failure mode: the LLM passes path: "/" intending
      // "search the whole project". Without sandbox-root semantics
      // path.resolve treats "/" as the actual filesystem root, the
      // escape check rejects it, and the model sees a confusing error.
      const out = await tools.dispatch(
        "search_files",
        JSON.stringify({ path: "/", pattern: "index" }),
      );
      expect(out).not.toMatch(/escapes sandbox/);
      expect(out).toContain("index.ts");
    });

    it("treats path: '/src' as <root>/src", async () => {
      const out = await tools.dispatch(
        "search_files",
        JSON.stringify({ path: "/src", pattern: "util" }),
      );
      expect(out).not.toMatch(/escapes sandbox/);
      expect(out).toContain("util.ts");
    });
  });

  describe("search_content", () => {
    it("finds a literal substring inside a file's content", async () => {
      // src/index.ts has `export const x = 1;`
      const out = await tools.dispatch(
        "search_content",
        JSON.stringify({ pattern: "export const x" }),
      );
      // Format: path:line: text
      expect(out).toMatch(/src[\\/]index\.ts:1: export const x = 1;/);
    });

    it("matches across multiple files and reports each line", async () => {
      // Both src/index.ts and src/util.ts have `export const`.
      const out = await tools.dispatch(
        "search_content",
        JSON.stringify({ pattern: "export const" }),
      );
      expect(out).toContain("index.ts");
      expect(out).toContain("util.ts");
    });

    it("supports regex patterns (word-bounded match)", async () => {
      const out = await tools.dispatch(
        "search_content",
        JSON.stringify({ pattern: "\\bexport\\s+const\\s+y\\b" }),
      );
      expect(out).toContain("util.ts");
      expect(out).not.toContain("index.ts");
    });

    it("is case-insensitive by default", async () => {
      const out = await tools.dispatch("search_content", JSON.stringify({ pattern: "EXPORT" }));
      expect(out).toContain("export");
    });

    it("respects case_sensitive when set", async () => {
      const out = await tools.dispatch(
        "search_content",
        JSON.stringify({ pattern: "EXPORT", case_sensitive: true }),
      );
      expect(out).toMatch(/no matches/);
    });

    it("filters by glob substring on the file name", async () => {
      const out = await tools.dispatch(
        "search_content",
        JSON.stringify({ pattern: "export const", glob: "util" }),
      );
      expect(out).toContain("util.ts");
      expect(out).not.toContain("index.ts");
    });

    it("skips dependency dirs by default", async () => {
      // Drop a node_modules-style file matching the pattern.
      await fs.mkdir(join(root, "node_modules", "junk"), { recursive: true });
      await fs.writeFile(
        join(root, "node_modules", "junk", "vendor.ts"),
        "export const NEEDLE = 1;\n",
      );
      const out = await tools.dispatch("search_content", JSON.stringify({ pattern: "NEEDLE" }));
      expect(out).toMatch(/no matches/);
    });

    it("includes dependency dirs when include_deps:true", async () => {
      await fs.mkdir(join(root, "node_modules", "junk"), { recursive: true });
      await fs.writeFile(
        join(root, "node_modules", "junk", "vendor.ts"),
        "export const NEEDLE = 1;\n",
      );
      const out = await tools.dispatch(
        "search_content",
        JSON.stringify({ pattern: "NEEDLE", include_deps: true }),
      );
      expect(out).toContain("vendor.ts");
    });

    it("skips binary files by extension", async () => {
      // A .png with searchable text inside — extension wins.
      await fs.writeFile(join(root, "logo.png"), "this is a PNG with NEEDLE inside\n");
      const out = await tools.dispatch("search_content", JSON.stringify({ pattern: "NEEDLE" }));
      expect(out).not.toContain("logo.png");
    });

    it("skips binary files by content (NUL byte sniff)", async () => {
      // A .txt that's actually binary — content sniff catches it.
      const buf = Buffer.concat([Buffer.from("NEEDLE\0"), Buffer.from([0, 1, 2, 3])]);
      await fs.writeFile(join(root, "data.txt"), buf);
      const out = await tools.dispatch("search_content", JSON.stringify({ pattern: "NEEDLE" }));
      expect(out).not.toContain("data.txt");
    });

    it("returns a clean (no matches) message when nothing matches", async () => {
      const out = await tools.dispatch(
        "search_content",
        JSON.stringify({ pattern: "definitely_not_present_anywhere_zxq" }),
      );
      expect(out).toMatch(/no matches/);
    });
  });

  describe("get_file_info", () => {
    it("returns type + size + mtime as JSON", async () => {
      const out = await tools.dispatch("get_file_info", JSON.stringify({ path: "hello.txt" }));
      const parsed = JSON.parse(out);
      expect(parsed.type).toBe("file");
      expect(parsed.size).toBeGreaterThan(0);
      expect(parsed.mtime).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it("reports directories", async () => {
      const out = await tools.dispatch("get_file_info", JSON.stringify({ path: "src" }));
      expect(JSON.parse(out).type).toBe("directory");
    });
  });

  describe("write_file", () => {
    it("creates a new file with contents", async () => {
      const out = await tools.dispatch(
        "write_file",
        JSON.stringify({ path: "new.md", content: "hi" }),
      );
      expect(out).toMatch(/wrote 2 chars/);
      const disk = await fs.readFile(join(root, "new.md"), "utf8");
      expect(disk).toBe("hi");
    });

    it("creates parent directories as needed", async () => {
      await tools.dispatch("write_file", JSON.stringify({ path: "a/b/c/deep.txt", content: "x" }));
      const disk = await fs.readFile(join(root, "a", "b", "c", "deep.txt"), "utf8");
      expect(disk).toBe("x");
    });

    it("rejects writes outside the sandbox", async () => {
      const out = await tools.dispatch(
        "write_file",
        JSON.stringify({ path: "../escape.txt", content: "bad" }),
      );
      expect(out).toMatch(/escapes sandbox/);
    });
  });

  describe("edit_file (flat SEARCH/REPLACE — the anti-DSML shape)", () => {
    it("replaces a unique search string", async () => {
      await fs.writeFile(join(root, "a.txt"), "foo bar baz");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "bar", replace: "QUX" }),
      );
      expect(out).toMatch(/edited/);
      const disk = await fs.readFile(join(root, "a.txt"), "utf8");
      expect(disk).toBe("foo QUX baz");
    });

    it("includes a git-style @@ -N,M +N,M @@ hunk header with the real starting line", async () => {
      // File has 4 pre-existing lines; SEARCH starts at line 3.
      // Expected hunk header: @@ -3,1 +3,2 @@ (1 old line → 2 new).
      await fs.writeFile(join(root, "a.txt"), "alpha\nbeta\nTARGET\ntail\n");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "TARGET", replace: "TARGET\nextra" }),
      );
      expect(out).toMatch(/@@ -3,1 \+3,2 @@/);
    });

    it("returns a proper LCS diff with context lines, not just - old / + new", async () => {
      // The user-reported case: SEARCH is a single line, REPLACE keeps
      // that line and adds three more below it. A naive dump-both-sides
      // would show "- line\n+ line\n+ new1\n+ new2\n+ new3" (redundant
      // `-` for the unchanged line). Proper LCS shows the first line
      // as context (` `) and only the additions as `+`.
      await fs.writeFile(
        join(root, "a.txt"),
        "const a = doc.getElementById('a');\nconst b = doc.getElementById('b');",
      );
      const search = "const a = doc.getElementById('a');";
      const replace = [
        "const a = doc.getElementById('a');",
        "const b2 = doc.getElementById('b2');",
        "const c = doc.getElementById('c');",
      ].join("\n");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search, replace }),
      );
      // The unchanged first line appears as context (space-prefixed),
      // NOT as a `-` / `+` pair.
      expect(out).toContain("  const a = doc.getElementById('a');");
      // The new lines are `+` prefixed.
      expect(out).toContain("+ const b2 = doc.getElementById('b2');");
      expect(out).toContain("+ const c = doc.getElementById('c');");
      // No line should appear as both `-` and `+` for the preserved
      // one — that was the old broken behavior.
      const minuses = out.split("\n").filter((l) => l.startsWith("- "));
      expect(minuses.some((l) => l.includes("getElementById('a')"))).toBe(false);
    });

    it("refuses when the search text is not found", async () => {
      await fs.writeFile(join(root, "a.txt"), "foo bar");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "baz", replace: "x" }),
      );
      expect(out).toMatch(/not found/);
    });

    it("refuses when the search text appears multiple times", async () => {
      await fs.writeFile(join(root, "a.txt"), "cat cat cat");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "cat", replace: "dog" }),
      );
      expect(out).toMatch(/multiple times/);
      // File unchanged.
      const disk = await fs.readFile(join(root, "a.txt"), "utf8");
      expect(disk).toBe("cat cat cat");
    });

    it("refuses an empty search", async () => {
      await fs.writeFile(join(root, "a.txt"), "x");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "", replace: "y" }),
      );
      expect(out).toMatch(/search cannot be empty/);
    });

    it("matches LF search against a CRLF file and preserves CRLF after write", async () => {
      await fs.writeFile(join(root, "a.txt"), "hello world\r\ngoodbye world\r\n");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "hello world", replace: "hello WORLD" }),
      );
      expect(out).toMatch(/edited/);
      const disk = await fs.readFile(join(root, "a.txt"), "utf8");
      expect(disk).toBe("hello WORLD\r\ngoodbye world\r\n");
    });

    it("matches LF multi-line search against a CRLF file and preserves CRLF", async () => {
      await fs.writeFile(join(root, "a.txt"), "line one\r\nline two\r\nline three\r\n");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({
          path: "a.txt",
          search: "line one\nline two",
          replace: "line ONE\nline TWO",
        }),
      );
      expect(out).toMatch(/edited/);
      const disk = await fs.readFile(join(root, "a.txt"), "utf8");
      expect(disk).toBe("line ONE\r\nline TWO\r\nline three\r\n");
    });

    it("refuses duplicate match in a CRLF file when search adapted to CRLF", async () => {
      await fs.writeFile(join(root, "a.txt"), "dup\r\ndup\r\nunique\r\n");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "dup", replace: "fixed" }),
      );
      expect(out).toMatch(/multiple times/);
      const disk = await fs.readFile(join(root, "a.txt"), "utf8");
      expect(disk).toBe("dup\r\ndup\r\nunique\r\n");
    });
  });

  describe("create_directory + move_file", () => {
    it("create_directory is idempotent (mkdir -p)", async () => {
      const a = await tools.dispatch("create_directory", JSON.stringify({ path: "d/e/f" }));
      expect(a).toMatch(/created/);
      const b = await tools.dispatch("create_directory", JSON.stringify({ path: "d/e/f" }));
      expect(b).toMatch(/created/);
      const st = await fs.stat(join(root, "d", "e", "f"));
      expect(st.isDirectory()).toBe(true);
    });

    it("move_file renames", async () => {
      const out = await tools.dispatch(
        "move_file",
        JSON.stringify({ source: "hello.txt", destination: "bye.txt" }),
      );
      expect(out).toMatch(/moved/);
      const disk = await fs.readFile(join(root, "bye.txt"), "utf8");
      expect(disk).toContain("line 1");
      await expect(fs.stat(join(root, "hello.txt"))).rejects.toThrow();
    });

    it("move_file into a new subdir creates the parent", async () => {
      await tools.dispatch(
        "move_file",
        JSON.stringify({ source: "hello.txt", destination: "archive/old.txt" }),
      );
      const disk = await fs.readFile(join(root, "archive", "old.txt"), "utf8");
      expect(disk).toContain("line 1");
    });
  });

  describe("allowWriting=false (read-only mode)", () => {
    it("skips registering write_file / edit_file / create_directory / move_file", async () => {
      const ro = new ToolRegistry();
      registerFilesystemTools(ro, { rootDir: root, allowWriting: false });
      expect(ro.has("read_file")).toBe(true);
      expect(ro.has("list_directory")).toBe(true);
      expect(ro.has("write_file")).toBe(false);
      expect(ro.has("edit_file")).toBe(false);
      expect(ro.has("create_directory")).toBe(false);
      expect(ro.has("move_file")).toBe(false);
    });
  });
});

describe("lineDiff — LCS line-level diff used by edit_file", () => {
  it("pure insertion: common prefix as context, new lines as +", () => {
    const d = lineDiff(["a"], ["a", "b", "c"]);
    expect(d).toEqual([
      { op: " ", line: "a" },
      { op: "+", line: "b" },
      { op: "+", line: "c" },
    ]);
  });

  it("pure deletion: kept lines as context, dropped as -", () => {
    const d = lineDiff(["a", "b", "c"], ["a"]);
    expect(d).toEqual([
      { op: " ", line: "a" },
      { op: "-", line: "b" },
      { op: "-", line: "c" },
    ]);
  });

  it("substitution: line-in-line-out without touching neighbors", () => {
    const d = lineDiff(["a", "old", "c"], ["a", "new", "c"]);
    // "a" and "c" stay as context; "old" → "new" is a -/+ pair.
    expect(d.map((o) => o.op).join("")).toBe(" -+ ");
    expect(d.map((o) => o.line)).toEqual(["a", "old", "new", "c"]);
  });

  it("identical arrays produce pure context (no +/- ops)", () => {
    const lines = ["a", "b", "c"];
    const d = lineDiff(lines, lines);
    expect(d.every((o) => o.op === " ")).toBe(true);
  });

  it("empty search → all replace lines are added", () => {
    const d = lineDiff([], ["x", "y"]);
    expect(d).toEqual([
      { op: "+", line: "x" },
      { op: "+", line: "y" },
    ]);
  });

  it("handles the user's real case: one-line search → multi-line replace with the line preserved", () => {
    const search = [
      "const prestigePointsGainElement = doc.getElementById('prestige-points-gain');",
    ];
    const replace = [
      "const prestigePointsGainElement = doc.getElementById('prestige-points-gain');",
      "const bonusClickElement = doc.getElementById('bonus-click');",
      "const bonusCpsElement = doc.getElementById('bonus-cps');",
    ];
    const d = lineDiff(search, replace);
    // First line is context — not a -/+ redundant pair.
    expect(d[0]!.op).toBe(" ");
    expect(d[0]!.line).toContain("prestigePointsGainElement");
    // The rest are pure additions.
    expect(d.slice(1).every((o) => o.op === "+")).toBe(true);
  });
});
