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
import { readdir, stat } from "node:fs/promises";
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
  return listFilesWithStatsSync(root, opts).map((e) => e.path);
}

export interface FileWithStats {
  /** Relative path with forward-slash separator. */
  path: string;
  /** Modification time (Date.getTime() / ms since epoch). 0 when stat failed. */
  mtimeMs: number;
}

/**
 * Same walk as {@link listFilesSync} but also statS each file for
 * modification time. Used by the `@` picker to surface recently-
 * edited files first — matches VS Code Quick Open / similar UX.
 *
 * Stat failures don't throw: the entry is kept with `mtimeMs: 0` so
 * it still appears in the picker (just sinks to the bottom of the
 * recency sort).
 */
export function listFilesWithStatsSync(root: string, opts: ListFilesOptions = {}): FileWithStats[] {
  const maxResults = Math.max(1, opts.maxResults ?? 500);
  const ignore = new Set(opts.ignoreDirs ?? DEFAULT_PICKER_IGNORE_DIRS);
  const rootAbs = resolve(root);
  const out: FileWithStats[] = [];

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
        if (ent.name.startsWith(".") || ignore.has(ent.name)) continue;
        walk(join(dirAbs, ent.name), relPath);
      } else if (ent.isFile()) {
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(join(dirAbs, ent.name)).mtimeMs;
        } catch {
          /* stat failed (permission / EAGAIN) — keep the entry with mtime=0 */
        }
        out.push({ path: relPath, mtimeMs });
      }
    }
  };

  walk(rootAbs, "");
  return out;
}

/**
 * Async variant of {@link listFilesWithStatsSync}. Same walk semantics
 * (DFS, alphabetical, respects ignore + maxResults), but each
 * directory's entries are stat'd in parallel via `Promise.all`,
 * which slashes wall-clock time on Windows where individual stat
 * syscalls are 3-5x slower than Linux.
 *
 * Use this from the TUI mount path so a 500-file repo doesn't add
 * 200-300ms of synchronous block to first paint. Sync variant is
 * kept for paths where the caller can't `await` (server APIs,
 * test scaffolding).
 */
export async function listFilesWithStatsAsync(
  root: string,
  opts: ListFilesOptions = {},
): Promise<FileWithStats[]> {
  const maxResults = Math.max(1, opts.maxResults ?? 500);
  const ignore = new Set(opts.ignoreDirs ?? DEFAULT_PICKER_IGNORE_DIRS);
  const rootAbs = resolve(root);
  const out: FileWithStats[] = [];

  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    if (out.length >= maxResults) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // Pull file stats for THIS directory in parallel before
    // recursing — readdir gave us all the names at once, may as
    // well issue all the stats at once too. Recursion stays
    // sequential so the alphabetical ordering of the merged list
    // matches the sync walk's contract.
    const fileEnts: Dirent[] = [];
    for (const ent of entries) {
      if (out.length >= maxResults) break;
      if (ent.isDirectory()) {
        if (ent.name.startsWith(".") || ignore.has(ent.name)) continue;
        // Drain pending file stats from THIS directory before
        // descending so the output order stays DFS-alphabetical.
        if (fileEnts.length > 0) {
          await statBatch(fileEnts, dirAbs, dirRel, out, maxResults);
          fileEnts.length = 0;
          if (out.length >= maxResults) return;
        }
        await walk(join(dirAbs, ent.name), dirRel ? `${dirRel}/${ent.name}` : ent.name);
      } else if (ent.isFile()) {
        fileEnts.push(ent);
      }
    }
    if (fileEnts.length > 0 && out.length < maxResults) {
      await statBatch(fileEnts, dirAbs, dirRel, out, maxResults);
    }
  };

  await walk(rootAbs, "");
  return out;
}

async function statBatch(
  ents: readonly Dirent[],
  dirAbs: string,
  dirRel: string,
  out: FileWithStats[],
  maxResults: number,
): Promise<void> {
  const remaining = Math.max(0, maxResults - out.length);
  const batch = ents.slice(0, remaining);
  const stats = await Promise.all(
    batch.map((e) =>
      stat(join(dirAbs, e.name))
        .then((s) => s.mtimeMs)
        .catch(() => 0),
    ),
  );
  for (let i = 0; i < batch.length; i++) {
    const ent = batch[i]!;
    out.push({
      path: dirRel ? `${dirRel}/${ent.name}` : ent.name,
      mtimeMs: stats[i] ?? 0,
    });
  }
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

/** A candidate accepted by the picker ranker — either a bare path or a path with mtime. */
export type PickerCandidate = string | FileWithStats;

export interface RankPickerOptions {
  /** Upper bound on returned entries. Default 40. */
  limit?: number;
  /**
   * Paths the user or model has touched recently (via tool calls like
   * `read_file` / `edit_file`). Matching paths get a recency boost so
   * the picker surfaces "stuff I just looked at" near the top.
   */
  recentlyUsed?: readonly string[];
}

/**
 * Filter and rank candidate files against the picker's partial query.
 *
 * Empty query:
 *   - Sort by "recently used" bucket first (if provided), then mtime
 *     descending (newer first), then path alpha.
 *   - Pure-string input (no mtime data) falls back to alpha since
 *     recency info isn't available.
 *
 * Non-empty query:
 *   - Case-insensitive substring match, with a basename-prefix boost
 *     so `lo` floats `loop.ts`-shaped paths to the top.
 *   - Ties broken first by recently-used membership, then mtime.
 *
 * Back-compat: passes `string[]` through the same logic (mtime = 0,
 * recently-used still honored).
 */
export function rankPickerCandidates(
  files: readonly PickerCandidate[],
  query: string,
  limitOrOpts?: number | RankPickerOptions,
): string[] {
  const opts: RankPickerOptions =
    typeof limitOrOpts === "number" ? { limit: limitOrOpts } : (limitOrOpts ?? {});
  const limit = opts.limit ?? 40;
  const recent = new Set(opts.recentlyUsed ?? []);

  const entries: FileWithStats[] = files.map((f) =>
    typeof f === "string" ? { path: f, mtimeMs: 0 } : f,
  );

  if (!query) {
    // Only re-sort when we actually have signal to sort by. If input
    // is bare strings (mtime = 0 everywhere) AND there's no recent-
    // used list, preserve input order so callers keep their existing
    // layout. Passing FileWithStats or a non-empty recentlyUsed opts
    // you into mtime+recency ranking.
    const anyMtime = entries.some((e) => e.mtimeMs > 0);
    if (!anyMtime && recent.size === 0) {
      return entries.slice(0, limit).map((e) => e.path);
    }
    const sorted = [...entries].sort((a, b) => {
      const aRecent = recent.has(a.path) ? 1 : 0;
      const bRecent = recent.has(b.path) ? 1 : 0;
      if (aRecent !== bRecent) return bRecent - aRecent;
      if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return a.path.localeCompare(b.path);
    });
    return sorted.slice(0, limit).map((e) => e.path);
  }

  const needle = query.toLowerCase();
  const scored: Array<{ path: string; score: number; mtimeMs: number; recent: boolean }> = [];
  for (const e of entries) {
    const lower = e.path.toLowerCase();
    const hit = lower.indexOf(needle);
    if (hit < 0) continue;
    const slash = lower.lastIndexOf("/");
    const base = slash >= 0 ? lower.slice(slash + 1) : lower;
    let score = 2;
    if (base.startsWith(needle)) score = 0;
    else if (lower.startsWith(needle)) score = 1;
    scored.push({
      path: e.path,
      score: score * 10_000 + hit,
      mtimeMs: e.mtimeMs,
      recent: recent.has(e.path),
    });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // Tie-break: recently-used, then mtime (newer first).
    if (a.recent !== b.recent) return a.recent ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  });
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

// =============================================================================
// @url mentions — async sibling of @path. Matches `@http(s)://...` after a
// word boundary, fetches each URL once per session (in-memory cache), and
// appends a "Referenced URLs" block under the prompt the model sees. Uses
// the same web-fetch + HTML-strip pipeline as the model's `web_fetch` tool
// so a `@url` reference and a model-issued fetch produce identical content.

/**
 * Matches `@http://...` or `@https://...` at a word boundary. Captures the
 * URL minus the leading `@`. Trailing sentence punctuation is stripped
 * separately because URLs can legitimately contain `,` `.` `)` etc., and a
 * blanket trim would butcher real query strings.
 */
export const AT_URL_PATTERN = /(?<=^|\s)@(https?:\/\/\S+)/g;

/** Default cap on inlined URL body (chars). Matches DEFAULT_AT_MENTION_MAX_BYTES order-of-magnitude. */
export const DEFAULT_AT_URL_MAX_CHARS = 32_000;

export interface AtUrlExpansion {
  /** The raw `@url` token as it appeared in the text. */
  token: string;
  /** Absolute URL (after trailing-punctuation strip). */
  url: string;
  /** True if content was inlined. False = skipped (reason in `skip`). */
  ok: boolean;
  /** Page title when extractable from `<title>`. */
  title?: string;
  /** Char count of the (post-truncation) inlined body. */
  chars?: number;
  /** True iff the original page exceeded `maxChars` and was clipped. */
  truncated?: boolean;
  /** Why the mention was skipped — set when ok=false. */
  skip?: "fetch-error" | "non-text" | "timeout" | "blocked";
  /** Free-form error message attached to skip outcomes. */
  error?: string;
}

export interface AtUrlOptions {
  /** Max chars of inlined body per URL. Default DEFAULT_AT_URL_MAX_CHARS. */
  maxChars?: number;
  /** Per-URL fetch timeout in ms. */
  timeoutMs?: number;
  /**
   * Override the fetcher — production wires `webFetch` from src/tools/web.ts.
   * Tests inject a stub so the suite stays offline.
   */
  fetcher?: (
    url: string,
    opts: { maxChars?: number; timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<{ url: string; title?: string; text: string; truncated: boolean }>;
  /**
   * Optional cache the caller persists across calls (e.g. one map per
   * session). Hit-on-URL skips the fetch entirely. Omit for one-shot
   * tests that don't care about reuse.
   */
  cache?: Map<string, AtUrlExpansion & { body?: string }>;
  /** Forward Esc/abort to the fetcher. */
  signal?: AbortSignal;
}

/**
 * Expand `@http(s)://…` mentions in `text`. Returns the (possibly augmented)
 * text plus a per-URL report so the caller can surface fetched URLs in the
 * UI. Async because each URL hits the network; the file-mention sibling
 * (`expandAtMentions`) stays sync.
 *
 * Caching: when `opts.cache` is provided, a hit skips the network and
 * reuses the prior expansion (including its body). One Map per session is
 * the intended use — a long conversation that references the same URL
 * twice doesn't pay twice.
 *
 * Trailing-punctuation handling: a sentence like "see @https://x.com." has
 * the period stripped so the actual fetched URL is `https://x.com`. We
 * conservatively strip only `.,;:!?` and `)]}>` from the tail; anything
 * else is preserved so query strings survive intact.
 */
export async function expandAtUrls(
  text: string,
  opts: AtUrlOptions = {},
): Promise<{ text: string; expansions: AtUrlExpansion[] }> {
  const maxChars = opts.maxChars ?? DEFAULT_AT_URL_MAX_CHARS;
  const fetcher = opts.fetcher;
  if (!fetcher) {
    throw new Error("expandAtUrls: fetcher option is required (wire src/tools/web.ts:webFetch)");
  }

  // De-dupe by URL so the same `@https://x.com` referenced twice fetches once.
  const seen = new Map<string, AtUrlExpansion>();
  const bodies = new Map<string, string>();
  const order: string[] = [];

  for (const match of text.matchAll(AT_URL_PATTERN)) {
    const rawUrl = match[1] ?? "";
    const url = stripUrlTail(rawUrl);
    if (!url) continue;
    if (seen.has(url)) continue;

    const cached = opts.cache?.get(url);
    if (cached) {
      seen.set(url, cached);
      if (cached.body) bodies.set(url, cached.body);
      order.push(url);
      continue;
    }

    let expansion: AtUrlExpansion;
    let body = "";
    try {
      const page = await fetcher(url, {
        maxChars,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
      body = page.text;
      expansion = {
        token: `@${url}`,
        url,
        ok: true,
        title: page.title,
        chars: body.length,
        truncated: page.truncated,
      };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // Tag a few common shapes so the UI can hint at causes.
      let skip: AtUrlExpansion["skip"] = "fetch-error";
      if (/aborted|timeout/i.test(message)) skip = "timeout";
      else if (/40\d|forbidden|access denied|captcha/i.test(message)) skip = "blocked";
      expansion = {
        token: `@${url}`,
        url,
        ok: false,
        skip,
        error: message,
      };
    }
    seen.set(url, expansion);
    if (body) bodies.set(url, body);
    if (opts.cache) opts.cache.set(url, { ...expansion, body });
    order.push(url);
  }

  if (seen.size === 0) return { text, expansions: [] };

  const expansions = order.map((u) => seen.get(u)!).filter(Boolean);
  const blocks: string[] = [];
  for (const ex of expansions) {
    if (ex.ok) {
      const titleAttr = ex.title ? ` title="${escapeAttr(ex.title)}"` : "";
      const truncTag = ex.truncated ? ' truncated="true"' : "";
      const body = bodies.get(ex.url) ?? "";
      blocks.push(`<url href="${ex.url}"${titleAttr}${truncTag}>\n${body}\n</url>`);
    } else {
      const reasonAttr = ex.skip ?? "fetch-error";
      blocks.push(`<url href="${ex.url}" skipped="${reasonAttr}" />`);
    }
  }
  const augmented = `${text}\n\n[Referenced URLs]\n${blocks.join("\n\n")}`;
  return { text: augmented, expansions };
}

/**
 * Strip trailing sentence punctuation from a URL captured at a word
 * boundary. `https://x.com.` → `https://x.com`; `https://x.com/?q=a)` →
 * `https://x.com/?q=a`. Conservative: only strips `.,;:!?` and unmatched
 * close-brackets `)]}>` from the very end. Internal punctuation in path /
 * query is preserved.
 *
 * Returns empty string if everything stripped — caller treats as "no URL."
 */
export function stripUrlTail(raw: string): string {
  let s = raw;
  while (s.length > 0) {
    const last = s[s.length - 1]!;
    if (".,;:!?".includes(last)) {
      s = s.slice(0, -1);
      continue;
    }
    if (")]}>".includes(last)) {
      // Only strip if the matching open bracket isn't elsewhere in the
      // URL — avoids butchering legitimate `(thing)` query fragments.
      const open = ({ ")": "(", "]": "[", "}": "{", ">": "<" } as const)[
        last as ")" | "]" | "}" | ">"
      ];
      if (!s.includes(open)) {
        s = s.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return s;
}

function escapeAttr(s: string): string {
  return s
    .replace(/"/g, "&quot;")
    .replace(/[\r\n]+/g, " ")
    .trim();
}
