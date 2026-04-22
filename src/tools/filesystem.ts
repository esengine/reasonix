/**
 * Built-in filesystem tools for `reasonix code`.
 *
 * Why native instead of the official `@modelcontextprotocol/server-filesystem`:
 *   - No subprocess overhead — every call is 50-200 ms cheaper.
 *   - Schema shapes tuned for R1: `edit_file` takes a single
 *     SEARCH/REPLACE string instead of `string="false"`-encoded
 *     JSON arrays, which was the biggest single source of DSML
 *     hallucinations in 0.4.x.
 *   - Sandbox enforcement lives here so Reasonix can reason about
 *     it (tests cover path-traversal, symlink-escape, and the
 *     cwd-outside-root case) rather than trusting an external server.
 *   - No `npx install` / network dependency in `reasonix code`.
 *
 * Tool names + argument shapes intentionally mirror the official
 * filesystem server so R1's muscle memory carries over. The only
 * intentional divergence is `edit_file`, noted above.
 */

import { promises as fs } from "node:fs";
import * as pathMod from "node:path";
import type { ToolRegistry } from "../tools.js";

export interface FilesystemToolsOptions {
  /** Absolute directory the tools may read/write. Paths outside this are refused. */
  rootDir: string;
  /**
   * When `false`, register only read-side tools (read_file, list_directory,
   * search_files, get_file_info, directory_tree). Useful for read-only
   * workflows where the model should never mutate the tree. Default: true.
   */
  allowWriting?: boolean;
  /**
   * Cap for a single file read, in bytes. Prevents a stray `read_file`
   * on a multi-GB blob from OOM'ing Node. 2 MB is enough for any realistic
   * source file (the biggest single-file TypeScript project checked in to
   * GitHub is ~500 KB); pass higher when working with data files.
   */
  maxReadBytes?: number;
  /**
   * Cap for total bytes returned from search_files / directory_tree /
   * grep, so the model can't accidentally pull down the whole tree as
   * one giant string. 256 KB by default.
   */
  maxListBytes?: number;
}

const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LIST_BYTES = 256 * 1024;

export function registerFilesystemTools(
  registry: ToolRegistry,
  opts: FilesystemToolsOptions,
): ToolRegistry {
  const rootDir = pathMod.resolve(opts.rootDir);
  const allowWriting = opts.allowWriting !== false;
  const maxReadBytes = opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxListBytes = opts.maxListBytes ?? DEFAULT_MAX_LIST_BYTES;

  /** Resolve path, enforce it's under rootDir, return absolute. */
  const safePath = (raw: unknown): string => {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error("path must be a non-empty string");
    }
    // Interpret relative paths against rootDir (the session's scope).
    const resolved = pathMod.resolve(rootDir, raw);
    const normRoot = pathMod.resolve(rootDir);
    // Use relative() to catch any `..` segments that escape.
    const rel = pathMod.relative(normRoot, resolved);
    if (rel.startsWith("..") || pathMod.isAbsolute(rel)) {
      throw new Error(`path escapes sandbox root (${normRoot}): ${raw}`);
    }
    return resolved;
  };

  registry.register({
    name: "read_file",
    description:
      "Read a file under the sandbox root. Returns the full contents (truncated with a notice if larger than the per-call cap). Paths may be relative to the root or absolute-under-root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to read (relative to rootDir or absolute)." },
        head: { type: "integer", description: "If set, return only the first N lines." },
        tail: { type: "integer", description: "If set, return only the last N lines." },
      },
      required: ["path"],
    },
    fn: async (args: { path: string; head?: number; tail?: number }) => {
      const abs = safePath(args.path);
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        throw new Error(`not a file: ${args.path} (it's a directory)`);
      }
      const raw = await fs.readFile(abs);
      if (raw.length > maxReadBytes) {
        const head = raw.slice(0, maxReadBytes).toString("utf8");
        return `${head}\n\n[…truncated ${raw.length - maxReadBytes} bytes — file is ${raw.length} B, cap ${maxReadBytes} B. Retry with head/tail for targeted view.]`;
      }
      const text = raw.toString("utf8");
      if (typeof args.head === "number" && args.head > 0) {
        return text.split(/\r?\n/).slice(0, args.head).join("\n");
      }
      if (typeof args.tail === "number" && args.tail > 0) {
        let lines = text.split(/\r?\n/);
        // Most files end with a final '\n', which splits into an empty
        // trailing string. Drop it before slicing so tail=2 returns the
        // last two *real* lines, not "last line + empty".
        if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
        return lines.slice(Math.max(0, lines.length - args.tail)).join("\n");
      }
      return text;
    },
  });

  registry.register({
    name: "list_directory",
    description:
      "List entries in a directory under the sandbox root. Returns one line per entry, marking directories with a trailing slash. Not recursive — use directory_tree for that.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (default: root)." },
      },
    },
    fn: async (args: { path?: string }) => {
      const abs = safePath(args.path ?? ".");
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const lines: string[] = [];
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(e.isDirectory() ? `${e.name}/` : e.name);
      }
      return lines.join("\n") || "(empty directory)";
    },
  });

  registry.register({
    name: "directory_tree",
    description:
      "Recursively list entries in a directory. Shows indented tree structure with directories marked '/'. Caps output so a huge tree doesn't drown the context.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Root of the tree (default: sandbox root)." },
        maxDepth: { type: "integer", description: "Max recursion depth (default 4)." },
      },
    },
    fn: async (args: { path?: string; maxDepth?: number }) => {
      const startAbs = safePath(args.path ?? ".");
      const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 4;
      const lines: string[] = [];
      let totalBytes = 0;
      let truncated = false;
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (truncated) return;
        if (depth > maxDepth) return;
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          if (truncated) return;
          const indent = "  ".repeat(depth);
          const line = e.isDirectory() ? `${indent}${e.name}/` : `${indent}${e.name}`;
          totalBytes += line.length + 1;
          if (totalBytes > maxListBytes) {
            lines.push(`  [… tree truncated at ${maxListBytes} bytes …]`);
            truncated = true;
            return;
          }
          lines.push(line);
          if (e.isDirectory()) {
            await walk(pathMod.join(dir, e.name), depth + 1);
          }
        }
      };
      await walk(startAbs, 0);
      return lines.join("\n") || "(empty tree)";
    },
  });

  registry.register({
    name: "search_files",
    description:
      "Find files whose NAME matches a substring or regex. Case-insensitive. Walks the directory recursively under the sandbox root. Returns one path per line.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to start the search at (default: root)." },
        pattern: {
          type: "string",
          description: "Substring (or regex) to match against filenames.",
        },
      },
      required: ["pattern"],
    },
    fn: async (args: { path?: string; pattern: string }) => {
      const startAbs = safePath(args.path ?? ".");
      const needle = args.pattern.toLowerCase();
      // Try as regex first (permits users who want patterns); fall
      // back to plain substring when it's not a valid regex. Flag `i`
      // so matching is case-insensitive regardless of path.
      let re: RegExp | null = null;
      try {
        re = new RegExp(args.pattern, "i");
      } catch {
        re = null;
      }
      const matches: string[] = [];
      let totalBytes = 0;
      const walk = async (dir: string): Promise<void> => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full = pathMod.join(dir, e.name);
          const lower = e.name.toLowerCase();
          const hit = re ? re.test(e.name) : lower.includes(needle);
          if (hit) {
            const rel = pathMod.relative(rootDir, full);
            if (totalBytes + rel.length + 1 > maxListBytes) {
              matches.push("[… search truncated — refine pattern …]");
              return;
            }
            matches.push(rel);
            totalBytes += rel.length + 1;
          }
          if (e.isDirectory()) await walk(full);
        }
      };
      await walk(startAbs);
      return matches.length === 0 ? "(no matches)" : matches.join("\n");
    },
  });

  registry.register({
    name: "get_file_info",
    description:
      "Stat a path under the sandbox root. Returns type (file|directory|symlink), size in bytes, mtime in ISO-8601.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    fn: async (args: { path: string }) => {
      const abs = safePath(args.path);
      const st = await fs.lstat(abs);
      const type = st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : "file";
      return JSON.stringify({
        type,
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
    },
  });

  if (!allowWriting) return registry;

  registry.register({
    name: "write_file",
    description:
      "Create or overwrite a file under the sandbox root with the given content. Parent directories are created as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    fn: async (args: { path: string; content: string }) => {
      const abs = safePath(args.path);
      await fs.mkdir(pathMod.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, "utf8");
      return `wrote ${args.content.length} chars to ${pathMod.relative(rootDir, abs)}`;
    },
  });

  registry.register({
    name: "edit_file",
    description:
      "Apply a SEARCH/REPLACE edit to an existing file. `search` must match exactly (whitespace sensitive) — no regex. The match must be unique in the file; otherwise the edit is refused to avoid surprise rewrites. This flat-string shape replaces the `{oldText, newText}[]` JSON array form that previously triggered R1 DSML hallucinations.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        search: { type: "string", description: "Exact text to find (must be unique)." },
        replace: { type: "string", description: "Text to substitute in place of `search`." },
      },
      required: ["path", "search", "replace"],
    },
    fn: async (args: { path: string; search: string; replace: string }) => {
      const abs = safePath(args.path);
      const before = await fs.readFile(abs, "utf8");
      if (args.search.length === 0) {
        throw new Error("edit_file: search cannot be empty");
      }
      const firstIdx = before.indexOf(args.search);
      if (firstIdx < 0) {
        throw new Error(`edit_file: search text not found in ${pathMod.relative(rootDir, abs)}`);
      }
      const nextIdx = before.indexOf(args.search, firstIdx + 1);
      if (nextIdx >= 0) {
        throw new Error(
          `edit_file: search text appears multiple times in ${pathMod.relative(rootDir, abs)} — include more context to disambiguate`,
        );
      }
      const after =
        before.slice(0, firstIdx) + args.replace + before.slice(firstIdx + args.search.length);
      await fs.writeFile(abs, after, "utf8");
      const rel = pathMod.relative(rootDir, abs);
      const header = `edited ${rel} (${args.search.length}→${args.replace.length} chars)`;
      // Starting line number of the search block in the original
      // file. `split/length` on the prefix gives a 1-based line
      // count where the match begins, matching git-diff's @@ -N,M
      // +N,M @@ header convention.
      const startLine = before.slice(0, firstIdx).split(/\r?\n/).length;
      const diff = renderEditDiff(args.search, args.replace, startLine);
      return `${header}\n${diff}`;
    },
  });

  registry.register({
    name: "create_directory",
    description: "Create a directory (and any missing parents) under the sandbox root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    fn: async (args: { path: string }) => {
      const abs = safePath(args.path);
      await fs.mkdir(abs, { recursive: true });
      return `created ${pathMod.relative(rootDir, abs)}/`;
    },
  });

  registry.register({
    name: "move_file",
    description: "Rename/move a file or directory under the sandbox root.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string" },
        destination: { type: "string" },
      },
      required: ["source", "destination"],
    },
    fn: async (args: { source: string; destination: string }) => {
      const src = safePath(args.source);
      const dst = safePath(args.destination);
      await fs.mkdir(pathMod.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      return `moved ${pathMod.relative(rootDir, src)} → ${pathMod.relative(rootDir, dst)}`;
    },
  });

  return registry;
}

/**
 * Format an edit_file change as a proper line-level diff, styled
 * like `git diff`. Starts with a unified-diff hunk header —
 * `@@ -startLine,oldCount +startLine,newCount @@` — so the user
 * can tell where in the file the change lands. Body uses LCS
 * (longest common subsequence) to mark lines as removed (`-`),
 * added (`+`), or unchanged context (` `). Users were getting
 * hundreds of `-` followed by hundreds of `+` for tiny changes
 * because the naive "dump both sides" format can't tell what
 * actually moved vs. stayed — this fixes that and adds line-
 * number context on top.
 */
function renderEditDiff(search: string, replace: string, startLine: number): string {
  const a = search.split(/\r?\n/);
  const b = replace.split(/\r?\n/);
  const diff = lineDiff(a, b);
  const hunk = `@@ -${startLine},${a.length} +${startLine},${b.length} @@`;
  const body = diff.map((d) => `${d.op === " " ? " " : d.op} ${d.line}`).join("\n");
  return `${hunk}\n${body}`;
}

/**
 * Compute a line-level diff via classic LCS dynamic programming.
 * Good enough for SEARCH/REPLACE blocks where both sides are
 * typically under a few hundred lines — O(n*m) space + time. For
 * huge blocks we'd want Myers' algorithm, but the caller already
 * caps the inline-display size and `/tool N` shows the full result,
 * so quadratic is fine in practice.
 *
 * Exported so tests can exercise the diff logic without spinning
 * up the full tool dispatch path.
 */
export function lineDiff(
  a: readonly string[],
  b: readonly string[],
): Array<{ op: "-" | "+" | " "; line: string }> {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[0..i) and b[0..j).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  // Backtrack to recover the op sequence.
  const out: Array<{ op: "-" | "+" | " "; line: string }> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.unshift({ op: " ", line: a[i - 1]! });
      i--;
      j--;
    } else if ((dp[i - 1]![j] ?? 0) > (dp[i]![j - 1] ?? 0)) {
      out.unshift({ op: "-", line: a[i - 1]! });
      i--;
    } else {
      // Tie-break goes here (strictly less or equal): take the
      // insertion first during backtrack so the final forward order
      // renders removals BEFORE additions for a substitution —
      // matches git-diff convention of `- old / + new`.
      out.unshift({ op: "+", line: b[j - 1]! });
      j--;
    }
  }
  while (i > 0) {
    out.unshift({ op: "-", line: a[i - 1]! });
    i--;
  }
  while (j > 0) {
    out.unshift({ op: "+", line: b[j - 1]! });
    j--;
  }
  return out;
}
