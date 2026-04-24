/**
 * Expand `@path/to/file` mentions in a user prompt to inline file
 * content.
 *
 * Why: most interactive coding sessions start with "look at X, then
 * change Y". Typing `@src/loop.ts` reads faster and cheaper than
 * "look at src/loop.ts (and the model fires read_file, and we pay for
 * the round trip)" — the model sees the file content from turn 1
 * instead of round-tripping a tool call for it.
 *
 * Shape: the user's text is kept verbatim. Expanded file contents are
 * appended in a "Referenced files" block at the end, each wrapped in
 * `<file path="...">...</file>` so the model can cite them back
 * unambiguously.
 *
 * Safety: paths must resolve inside `rootDir` (no `..` escape, no
 * absolute paths), must exist as a regular file, and must be under
 * `maxBytes`. Missing / too-large / escaping paths get a short note
 * appended instead of content so the user sees why it was skipped.
 */

import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Caps match tool-result dispatch truncation (0.5.2). */
export const DEFAULT_AT_MENTION_MAX_BYTES = 64 * 1024;

/**
 * Default directory names skipped when listing files for the picker.
 * Matches what most repos gitignore AND keeps the picker off the
 * hottest bloat — `node_modules` alone can be 100k+ entries.
 */
export const DEFAULT_PICKER_IGNORE_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".cache",
  ".vscode",
  ".idea",
  "target",
  ".venv",
  "venv",
  "__pycache__",
];

export interface ListFilesOptions {
  /** Cap the walk once we've collected this many entries. Default 500. */
  maxResults?: number;
  /** Directory names to skip entirely. Defaults to {@link DEFAULT_PICKER_IGNORE_DIRS}. */
  ignoreDirs?: readonly string[];
}

/**
 * Walk `root` recursively and return relative file paths (forward-slash
 * separator, regardless of platform) for the `@` picker.
 *
 * Synchronous on purpose: this runs once at App mount (and on each turn
 * so newly-created files show up) and blocks the render thread for a
 * predictable ~10-50ms on a moderate repo. An async variant would need
 * to coordinate with the Ink render loop; sync fits the rest of the
 * TUI's single-turn-per-tick model cleanly.
 *
 * Skips:
 *   - directories in `ignoreDirs` (default: DEFAULT_PICKER_IGNORE_DIRS)
 *   - any directory whose name starts with `.` (covers `.git`,
 *     `.vscode`, dotfile vendors). Dotfile REGULAR FILES (`.env`,
 *     `.gitignore`, `.prettierrc`) are kept — users reference them.
 *   - entries the walker can't read (permission errors, broken links).
 */
export function listFilesSync(root: string, opts: ListFilesOptions = {}): string[] {
  const maxResults = Math.max(1, opts.maxResults ?? 500);
  const ignore = new Set(opts.ignoreDirs ?? DEFAULT_PICKER_IGNORE_DIRS);
  const rootAbs = resolve(root);
  const out: string[] = [];

  const walk = (dirAbs: string, dirRel: string) => {
    if (out.length >= maxResults) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (out.length >= maxResults) return;
      const relPath = dirRel ? `${dirRel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        // Skip dot-dirs (.git, .vscode, .idea…) and the explicit ignore
        // list. Users who want to @-reference a file inside a dot-dir
        // can type the full path — picker just doesn't surface them.
        if (ent.name.startsWith(".") || ignore.has(ent.name)) continue;
        walk(join(dirAbs, ent.name), relPath);
      } else if (ent.isFile()) {
        out.push(relPath);
      }
    }
  };

  walk(rootAbs, "");
  return out;
}

/**
 * Prefix pattern used by the `@` picker to detect an IN-PROGRESS
 * mention at the END of the input buffer. Captures the partial path
 * (which may be empty — just `@`) so the picker can use it as a
 * substring filter.
 *
 * Distinct from {@link AT_MENTION_PATTERN} (which finds completed
 * mentions anywhere in the text for expansion-at-submit). This one
 * fires on the trailing token only, anchored at end-of-input.
 */
export const AT_PICKER_PREFIX = /(?:^|\s)@([a-zA-Z0-9_./\\-]*)$/;

/**
 * Return the picker state for a given input buffer: the partial query
 * (may be empty string — just `@`) and the buffer offset of the `@`
 * character. `null` when the buffer doesn't end in a mention-in-
 * progress.
 */
export function detectAtPicker(input: string): { query: string; atOffset: number } | null {
  const m = AT_PICKER_PREFIX.exec(input);
  if (!m) return null;
  const query = m[1] ?? "";
  // `m.index` is the offset of the capture group's SURROUNDING match —
  // which starts at either ^ or the preceding whitespace. The `@`
  // itself is at `end-of-input - query.length - 1`.
  const atOffset = input.length - query.length - 1;
  return { query, atOffset };
}

/**
 * Filter and rank candidate files against the picker's partial query.
 * Empty query → return the first `limit` candidates as-is (alpha).
 * Non-empty query → case-insensitive substring match, with a modest
 * boost for basename-starts-with matches so `src/l` still puts
 * `loop.ts`-shaped paths near the top.
 */
export function rankPickerCandidates(
  files: readonly string[],
  query: string,
  limit = 40,
): string[] {
  if (!query) return files.slice(0, limit);
  const needle = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const hit = lower.indexOf(needle);
    if (hit < 0) continue;
    // Rank: basename prefix < path prefix < substring. Lower score = better.
    const slash = lower.lastIndexOf("/");
    const base = slash >= 0 ? lower.slice(slash + 1) : lower;
    let score = 2;
    if (base.startsWith(needle)) score = 0;
    else if (lower.startsWith(needle)) score = 1;
    scored.push({ path: f, score: score * 10_000 + hit });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.path);
}

/**
 * Matches `@` at a word boundary (start-of-string or preceded by
 * whitespace) followed by a path-like token. Deliberately rejects `@`
 * embedded in longer words (email addresses, mentions on social sites)
 * by requiring the word boundary.
 *
 * Path charset keeps it to the characters that appear in real repo
 * paths — letters, digits, `_` `-` `.` `/` `\`. Trailing `.` (e.g.
 * `@foo.ts.`) is stripped before lookup so a sentence-terminating
 * period doesn't break the mention.
 */
export const AT_MENTION_PATTERN = /(?<=^|\s)@([a-zA-Z0-9_./\\-]+)/g;

export interface AtMentionExpansion {
  /** The raw `@path` token as it appeared in the text. */
  token: string;
  /** The relative path, as resolved against rootDir. */
  path: string;
  /** True if the content was inlined. False = skipped (reason in `skip`). */
  ok: boolean;
  /** Bytes read (only for ok=true). */
  bytes?: number;
  /** Why the mention was skipped. Set when ok=false. */
  skip?: "missing" | "not-file" | "too-large" | "escape" | "read-error";
}

export interface AtMentionOptions {
  /** Max file size in bytes before a mention is skipped. */
  maxBytes?: number;
  /**
   * Optional file-system overrides for tests. Real callers omit these;
   * the helper falls through to `node:fs`.
   */
  fs?: {
    exists: (path: string) => boolean;
    isFile: (path: string) => boolean;
    size: (path: string) => number;
    read: (path: string) => string;
  };
}

/**
 * Expand `@path` mentions in `text`. Returns the (possibly augmented)
 * text plus a per-mention report so the caller can surface expansions
 * in the UI.
 */
export function expandAtMentions(
  text: string,
  rootDir: string,
  opts: AtMentionOptions = {},
): { text: string; expansions: AtMentionExpansion[] } {
  const maxBytes = opts.maxBytes ?? DEFAULT_AT_MENTION_MAX_BYTES;
  const fs = opts.fs ?? defaultFs;
  const root = resolve(rootDir);
  // De-dupe by token so `@file.ts` referenced twice inlines once.
  const seen = new Map<string, AtMentionExpansion>();
  const expansions: AtMentionExpansion[] = [];

  for (const match of text.matchAll(AT_MENTION_PATTERN)) {
    const rawPath = match[1] ?? "";
    // Strip trailing dot (sentence terminator): `@foo.ts.` → `@foo.ts`.
    // Keep internal dots intact.
    const cleaned = rawPath.replace(/\.+$/, "");
    if (!cleaned) continue;
    const token = `@${cleaned}`;
    if (seen.has(token)) continue;

    const expansion = resolveMention(cleaned, root, maxBytes, fs);
    seen.set(token, expansion);
    expansions.push(expansion);
  }

  if (expansions.length === 0) return { text, expansions };

  // Build the trailing "Referenced files" block. Keep successful
  // inlines and skipped ones (with their reason) so the model sees
  // both what's here and what's missing.
  const blocks: string[] = [];
  for (const ex of expansions) {
    if (ex.ok) {
      const content = readSafe(root, ex.path, fs);
      blocks.push(`<file path="${ex.path}">\n${content}\n</file>`);
    } else {
      blocks.push(`<file path="${ex.path}" skipped="${ex.skip}" />`);
    }
  }
  const augmented = `${text}\n\n[Referenced files]\n${blocks.join("\n\n")}`;
  return { text: augmented, expansions };
}

function resolveMention(
  rawPath: string,
  root: string,
  maxBytes: number,
  fs: NonNullable<AtMentionOptions["fs"]>,
): AtMentionExpansion {
  // Reject absolute paths — `@/etc/passwd` should not inline.
  if (isAbsolute(rawPath)) {
    return { token: `@${rawPath}`, path: rawPath, ok: false, skip: "escape" };
  }
  const resolved = resolve(root, rawPath);
  // Sandbox escape: after resolution the path must still be inside root.
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { token: `@${rawPath}`, path: rawPath, ok: false, skip: "escape" };
  }
  if (!fs.exists(resolved)) {
    return { token: `@${rawPath}`, path: rawPath, ok: false, skip: "missing" };
  }
  if (!fs.isFile(resolved)) {
    return { token: `@${rawPath}`, path: rawPath, ok: false, skip: "not-file" };
  }
  const size = fs.size(resolved);
  if (size > maxBytes) {
    return { token: `@${rawPath}`, path: rawPath, ok: false, skip: "too-large", bytes: size };
  }
  return { token: `@${rawPath}`, path: rawPath, ok: true, bytes: size };
}

function readSafe(root: string, rawPath: string, fs: NonNullable<AtMentionOptions["fs"]>): string {
  const resolved = resolve(root, rawPath);
  try {
    return fs.read(resolved);
  } catch {
    return "(read failed)";
  }
}

const defaultFs: NonNullable<AtMentionOptions["fs"]> = {
  exists: (p) => existsSync(p),
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  size: (p) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  },
  read: (p) => readFileSync(p, "utf8"),
};
