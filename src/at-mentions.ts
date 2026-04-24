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

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Caps match tool-result dispatch truncation (0.5.2). */
export const DEFAULT_AT_MENTION_MAX_BYTES = 64 * 1024;

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
