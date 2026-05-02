/** Native FS tools — sandbox enforced here, not delegated. `edit_file` takes a single SEARCH/REPLACE string. */

import { promises as fs } from "node:fs";
import * as pathMod from "node:path";
import { DEFAULT_INDEX_EXCLUDES } from "../index/config.js";
import type { ToolRegistry } from "../tools.js";

export interface FilesystemToolsOptions {
  /** Absolute directory the tools may read/write. Paths outside this are refused. */
  rootDir: string;
  /** false → register only read-side tools. Default true. */
  allowWriting?: boolean;
  /** Per-read byte cap; floor against OOM on a multi-GB blob. */
  maxReadBytes?: number;
  /** Cap on total bytes from listing/grep tools — bounds tree-as-one-string accidents. */
  maxListBytes?: number;
}

const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LIST_BYTES = 256 * 1024;

/** Auto-preview threshold — files above this force the model to scope (range/head/tail). */
const DEFAULT_AUTO_PREVIEW_LINES = 200;
const AUTO_PREVIEW_HEAD_LINES = 80;
const AUTO_PREVIEW_TAIL_LINES = 40;

/** Skipped unless `include_deps:true` — shared with the semantic indexer via DEFAULT_INDEX_EXCLUDES. */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(DEFAULT_INDEX_EXCLUDES.dirs);

/** First line of binary defense; NUL-byte sniff is the second (catches mislabeled `.txt`). */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set(DEFAULT_INDEX_EXCLUDES.exts);

function isLikelyBinaryByName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

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
    // Sandbox-root semantics: a leading POSIX-style `/` (or `\` on
    // Windows) means "from the project root", not "from the filesystem
    // root". Models routinely write `path: "/"` or `path: "/src/foo.ts"`
    // intending the sandbox root — without this normalization,
    // path.resolve interprets `/` as the actual drive root (`F:\` on
    // Windows, `/` on POSIX) and the escape check rightly rejects it,
    // confusing the model. Strip leading separators so the rest of the
    // resolution treats the input as relative to rootDir. Drive-letter
    // absolutes (`C:\foo`) and Unix absolutes outside rootDir still
    // get caught by the relative-escape check below.
    let normalized = raw;
    while (normalized.startsWith("/") || normalized.startsWith("\\")) {
      normalized = normalized.slice(1);
    }
    if (normalized.length === 0) normalized = ".";
    const resolved = pathMod.resolve(rootDir, normalized);
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
    description: `Read a file under the sandbox root. To save context, PREFER to scope the read instead of pulling the whole file:
  - head: N  → first N lines (imports, public API, small configs)
  - tail: N  → last N lines (recently-added code, log tails)
  - range: "A-B"  → inclusive line range A..B, 1-indexed (e.g. "120-180" around an edit site)
When none of these is given AND the file is longer than ${DEFAULT_AUTO_PREVIEW_LINES} lines, the tool auto-returns a head+tail preview with an "N lines omitted" marker rather than dumping everything. If you need the middle, re-call with a range. Prefer search_content to locate a symbol first, then read_file with a range around the hit — one scoped read beats three full-file reads.`,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to read (relative to rootDir or absolute)." },
        head: { type: "integer", description: "If set, return only the first N lines." },
        tail: { type: "integer", description: "If set, return only the last N lines." },
        range: {
          type: "string",
          description:
            'Inclusive line range like "50-100" or "50-50". 1-indexed. Takes precedence over head/tail when all three are set. Out-of-range requests clamp to file bounds.',
        },
      },
      required: ["path"],
    },
    fn: async (args: { path: string; head?: number; tail?: number; range?: string }) => {
      const abs = safePath(args.path);
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        throw new Error(`not a file: ${args.path} (it's a directory)`);
      }
      const raw = await fs.readFile(abs);
      if (raw.length > maxReadBytes) {
        const headBytes = raw.slice(0, maxReadBytes).toString("utf8");
        return `${headBytes}\n\n[…truncated ${raw.length - maxReadBytes} bytes — file is ${raw.length} B, cap ${maxReadBytes} B. Retry with head/tail/range for targeted view.]`;
      }
      const text = raw.toString("utf8");
      let lines = text.split(/\r?\n/);
      // Most files end with '\n' which splits into an empty trailing
      // entry; drop it so head/tail/range counts match the user's
      // visible line numbers in an editor.
      if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
      const totalLines = lines.length;

      // range wins over head/tail when set — the most precise ask
      // should dominate. Parse "A-B" strictly; bad formats fall through
      // to head/tail / auto-preview instead of erroring.
      if (typeof args.range === "string" && /^\d+\s*-\s*\d+$/.test(args.range)) {
        const [rawStart, rawEnd] = args.range.split("-").map((s) => Number.parseInt(s, 10));
        const start = Math.max(1, rawStart ?? 1);
        const end = Math.min(totalLines, Math.max(start, rawEnd ?? totalLines));
        const slice = lines.slice(start - 1, end);
        const label = `[range ${start}-${end} of ${totalLines} lines]`;
        return `${label}\n${slice.join("\n")}`;
      }
      if (typeof args.head === "number" && args.head > 0) {
        const count = Math.min(args.head, totalLines);
        const slice = lines.slice(0, count);
        const marker =
          count < totalLines
            ? `\n\n[…head ${count} of ${totalLines} lines — call again with range / tail for more]`
            : "";
        return slice.join("\n") + marker;
      }
      if (typeof args.tail === "number" && args.tail > 0) {
        const count = Math.min(args.tail, totalLines);
        const slice = lines.slice(totalLines - count);
        const marker =
          count < totalLines
            ? `[…tail ${count} of ${totalLines} lines — call again with range / head for more]\n\n`
            : "";
        return marker + slice.join("\n");
      }

      // No explicit scope + file is small → full content.
      if (totalLines <= DEFAULT_AUTO_PREVIEW_LINES) return lines.join("\n");

      // No explicit scope + file is large → head + tail preview plus
      // a marker telling the model how much it missed and how to get
      // it. This is the single biggest lever on read_file token cost —
      // historically a 500-line file dumped ~4K tokens into the turn
      // even when the model only needed 20 of them.
      const head = lines.slice(0, AUTO_PREVIEW_HEAD_LINES).join("\n");
      const tail = lines.slice(totalLines - AUTO_PREVIEW_TAIL_LINES).join("\n");
      const omitted = totalLines - AUTO_PREVIEW_HEAD_LINES - AUTO_PREVIEW_TAIL_LINES;
      return [
        `[auto-preview: head ${AUTO_PREVIEW_HEAD_LINES} + tail ${AUTO_PREVIEW_TAIL_LINES} of ${totalLines} lines]`,
        head,
        `\n[… ${omitted} lines omitted — call read_file again with range:"A-B" (1-indexed) or head / tail to get the middle]\n`,
        tail,
      ].join("\n");
    },
  });

  registry.register({
    name: "list_directory",
    description:
      "List entries in a directory under the sandbox root. Returns one line per entry, marking directories with a trailing slash. Not recursive — use directory_tree for that.",
    readOnly: true,
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
    description: `Recursively list entries in a directory. Shows indented tree structure with directories marked '/'. Budget-aware by default:
  - maxDepth defaults to 2 (root + one level). A depth-4 tree on a real repo blew ~5K tokens in one call. If you truly need deeper, pass maxDepth:N explicitly.
  - Skips ${[...SKIP_DIR_NAMES].sort().join(", ")} unless include_deps:true. Traversing into node_modules / .git / dist is almost always token-waste.
  - Large subtrees (>50 children) auto-collapse to "[N files, M dirs hidden — list_directory <path> to inspect]" so one huge folder can't dominate the output.
Prefer \`list_directory\` for a single-level view, \`search_files\` to find specific paths, and \`search_content\` to find code.`,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Root of the tree (default: sandbox root)." },
        maxDepth: {
          type: "integer",
          description:
            "Max recursion depth (default 2). Depth 0 shows only the top-level entries; depth 2 is usually enough to see module structure.",
        },
        include_deps: {
          type: "boolean",
          description:
            "When true, also traverse node_modules / .git / dist / build / etc. Off by default — most exploration questions are about the user's own code.",
        },
      },
    },
    fn: async (args: { path?: string; maxDepth?: number; include_deps?: boolean }) => {
      const startAbs = safePath(args.path ?? ".");
      const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 2;
      const includeDeps = args.include_deps === true;
      const lines: string[] = [];
      let totalBytes = 0;
      let truncated = false;
      // Per-directory child cap — long fixture / asset folders (200+
      // snapshots) would otherwise dominate; the collapse keeps the
      // overall shape visible. Modest: normal source dirs have <50
      // entries.
      const PER_DIR_CHILD_CAP = 50;
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
        let emitted = 0;
        for (const e of entries) {
          if (truncated) return;
          // Dep-skip applies only to DIRECTORIES (a file named
          // "node_modules" is fine to list). Anything in the skip set
          // still shows up as a single node with a trailing " (skipped)"
          // hint so the model knows the dir exists but wasn't walked.
          const skip = e.isDirectory() && !includeDeps && SKIP_DIR_NAMES.has(e.name);
          if (emitted >= PER_DIR_CHILD_CAP) {
            const remaining = entries.length - emitted;
            let restFiles = 0;
            let restDirs = 0;
            for (const r of entries.slice(emitted)) {
              if (r.isDirectory()) restDirs++;
              else restFiles++;
            }
            const indent = "  ".repeat(depth);
            lines.push(
              `${indent}[… ${remaining} entries hidden (${restDirs} dirs, ${restFiles} files) — list_directory on this path to see all]`,
            );
            return;
          }
          const indent = "  ".repeat(depth);
          const suffix = skip ? " (skipped — pass include_deps:true to traverse)" : "";
          const line = e.isDirectory() ? `${indent}${e.name}/${suffix}` : `${indent}${e.name}`;
          totalBytes += line.length + 1;
          if (totalBytes > maxListBytes) {
            lines.push(`  [… tree truncated at ${maxListBytes} bytes …]`);
            truncated = true;
            return;
          }
          lines.push(line);
          emitted++;
          if (e.isDirectory() && !skip) {
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
    readOnly: true,
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
    name: "search_content",
    description:
      "Recursively grep file CONTENTS for a substring or regex. This is the right tool for 'find all places that call X', 'where is Y referenced', 'what files contain Z'. Different from search_files (which matches FILE NAMES). Returns one match per line in 'path:line: text' format. Skips dependency / VCS / build directories (node_modules, .git, dist, build, .next, target, .venv) and binary files by default.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Substring (or regex) to search file contents for.",
        },
        path: {
          type: "string",
          description: "Directory to start the search at (default: sandbox root).",
        },
        glob: {
          type: "string",
          description:
            "Optional file-name suffix or substring filter. Examples: '.ts' (only TypeScript), 'test' (any file with 'test' in the name). Reduces noise when you know the file shape.",
        },
        case_sensitive: {
          type: "boolean",
          description: "When true, match case exactly. Default false (case-insensitive).",
        },
        include_deps: {
          type: "boolean",
          description:
            "When true, also search inside node_modules / .git / dist / build / etc. Off by default — most exploration questions are about the user's own code.",
        },
      },
      required: ["pattern"],
    },
    fn: async (args: {
      pattern: string;
      path?: string;
      glob?: string;
      case_sensitive?: boolean;
      include_deps?: boolean;
    }) => {
      const startAbs = safePath(args.path ?? ".");
      const caseSensitive = args.case_sensitive === true;
      const includeDeps = args.include_deps === true;
      const nameFilter = typeof args.glob === "string" ? args.glob.toLowerCase() : null;
      // Try the pattern as a regex first (lets the model say `\bdispatch\(`
      // for a word-bounded match); fall back to literal substring on
      // invalid regex. No `g` flag — we test once per line, so global
      // statefulness (lastIndex tracking) would just be noise.
      let re: RegExp | null = null;
      try {
        re = new RegExp(args.pattern, caseSensitive ? "" : "i");
      } catch {
        re = null;
      }
      const needle = caseSensitive ? args.pattern : args.pattern.toLowerCase();
      const matches: string[] = [];
      let totalBytes = 0;
      let scanned = 0;
      let truncated = false;

      const walk = async (dir: string): Promise<void> => {
        if (truncated) return;
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (truncated) return;
          if (e.isDirectory()) {
            if (!includeDeps && SKIP_DIR_NAMES.has(e.name)) continue;
            await walk(pathMod.join(dir, e.name));
            continue;
          }
          if (!e.isFile()) continue;
          if (nameFilter && !e.name.toLowerCase().includes(nameFilter)) continue;
          if (isLikelyBinaryByName(e.name)) continue;
          const full = pathMod.join(dir, e.name);
          let stat: import("node:fs").Stats;
          try {
            stat = await fs.stat(full);
          } catch {
            continue;
          }
          // Per-file size cap so a 50MB log doesn't dominate the search.
          // Anything legitimately interesting fits in 2 MB; bigger files
          // are usually data dumps or generated bundles.
          if (stat.size > 2 * 1024 * 1024) continue;
          let raw: Buffer;
          try {
            raw = await fs.readFile(full);
          } catch {
            continue;
          }
          // Content-based binary sniff: a NUL byte in the first 8KB is
          // a strong indicator. Catches binaries with .json or .txt
          // extensions (yes, this happens).
          const firstNul = raw.indexOf(0);
          if (firstNul !== -1 && firstNul < 8 * 1024) continue;
          const text = raw.toString("utf8");
          const rel = pathMod.relative(rootDir, full);
          const lines = text.split(/\r?\n/);
          for (let li = 0; li < lines.length; li++) {
            const line = lines[li]!;
            const lineForCheck = caseSensitive ? line : line.toLowerCase();
            const hit = re ? re.test(line) : lineForCheck.includes(needle);
            if (!hit) continue;
            // Truncate very long lines so one giant minified file
            // doesn't blow the budget on a single match.
            const display = line.length > 200 ? `${line.slice(0, 200)}…` : line;
            const out = `${rel}:${li + 1}: ${display}`;
            if (totalBytes + out.length + 1 > maxListBytes) {
              matches.push(`[… truncated at ${maxListBytes} bytes — refine pattern or path …]`);
              truncated = true;
              return;
            }
            matches.push(out);
            totalBytes += out.length + 1;
          }
          scanned++;
        }
      };
      await walk(startAbs);
      if (matches.length === 0) {
        return scanned === 0
          ? "(no files scanned — path empty or all files filtered out)"
          : `(no matches across ${scanned} file${scanned === 1 ? "" : "s"})`;
      }
      return matches.join("\n");
    },
  });

  registry.register({
    name: "get_file_info",
    description:
      "Stat a path under the sandbox root. Returns type (file|directory|symlink), size in bytes, mtime in ISO-8601.",
    readOnly: true,
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
      "Apply a SEARCH/REPLACE edit to an existing file. `search` must match exactly (whitespace sensitive) — no regex. The match must be unique in the file; otherwise the edit is refused to avoid surprise rewrites.",
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
      const le = before.includes("\r\n") ? "\r\n" : "\n";
      const adaptedSearch = args.search.replace(/\r?\n/g, le);
      const adaptedReplace = args.replace.replace(/\r?\n/g, le);
      const firstIdx = before.indexOf(adaptedSearch);
      if (firstIdx < 0) {
        throw new Error(`edit_file: search text not found in ${pathMod.relative(rootDir, abs)}`);
      }
      const nextIdx = before.indexOf(adaptedSearch, firstIdx + 1);
      if (nextIdx >= 0) {
        throw new Error(
          `edit_file: search text appears multiple times in ${pathMod.relative(rootDir, abs)} — include more context to disambiguate`,
        );
      }
      const after =
        before.slice(0, firstIdx) + adaptedReplace + before.slice(firstIdx + adaptedSearch.length);
      await fs.writeFile(abs, after, "utf8");
      const rel = pathMod.relative(rootDir, abs);
      const header = `edited ${rel} (${adaptedSearch.length}→${adaptedReplace.length} chars)`;
      const startLine = before.slice(0, firstIdx).split(/\r?\n/).length;
      const diff = renderEditDiff(adaptedSearch, adaptedReplace, startLine);
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

function renderEditDiff(search: string, replace: string, startLine: number): string {
  const a = search.split(/\r?\n/);
  const b = replace.split(/\r?\n/);
  const diff = lineDiff(a, b);
  const hunk = `@@ -${startLine},${a.length} +${startLine},${b.length} @@`;
  const body = diff.map((d) => `${d.op === " " ? " " : d.op} ${d.line}`).join("\n");
  return `${hunk}\n${body}`;
}

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
