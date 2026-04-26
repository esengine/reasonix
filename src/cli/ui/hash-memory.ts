/**
 * Hash-mode (`#note`) prefix parsing — instant project memory write.
 *
 * A `#` at the start of the user's input means "append this note to the
 * project's REASONIX.md so future sessions see it pinned in the prefix."
 * Same idea as Claude Code's `#` prefix — faster than going through a
 * `/memory remember ...` slash for a one-liner like "always use pnpm".
 *
 * Trigger shape:
 *   - `#` followed by zero-or-more spaces, then a non-empty body
 *   - NOT `##` / `###` / etc. — those stay markdown headings to the model
 *   - `\#foo` escape → not a memory write, leading backslash stripped before
 *     submission so the model sees `#foo` literally
 *
 * Destination: `<rootDir>/REASONIX.md`. The file is appended to (created
 * if absent), so each `#note` adds one bullet at the bottom. The user can
 * reorganize manually whenever they want; we don't try to parse section
 * structure.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_MEMORY_FILE } from "../../project-memory.js";

const NEW_FILE_HEADER = `# Reasonix project memory

Notes the user pinned via the \`#\` prompt prefix. The whole file is
loaded into the immutable system prefix every session — keep it terse.

`;

/**
 * Result of `detectHashMemory`.
 *
 *   - `kind: "memory"` — input is a `#`-prefixed note; `note` is the body
 *     ready to append. Caller should consume the input (don't submit).
 *   - `kind: "escape"` — input started with `\#`; `text` is the de-escaped
 *     prompt (`#foo`) that should be submitted to the model normally.
 *   - returning `null` means the input is unrelated to hash memory.
 */
export type HashMemoryParse = { kind: "memory"; note: string } | { kind: "escape"; text: string };

/**
 * Classify a hash-prefixed input. See module docstring for the trigger
 * rules. Returns `null` when the input has nothing to do with hash mode.
 *
 * The function is pure — no filesystem touch — so it's trivially testable
 * and can run before any I/O decision in handleSubmit.
 */
export function detectHashMemory(text: string): HashMemoryParse | null {
  if (text.startsWith("\\#")) {
    return { kind: "escape", text: text.slice(1) };
  }
  if (!text.startsWith("#")) return null;
  // Markdown headings of level 2+ pass through to the model unchanged.
  // Only a single leading `#` (level-1 heading shape) is ambiguous; we
  // resolve that ambiguity in favor of memory write and document the
  // `\#` escape for users who want a literal H1 in the prompt.
  if (text.startsWith("##")) return null;
  const body = text.slice(1).trim();
  if (!body) return null;
  return { kind: "memory", note: body };
}

export interface AppendProjectMemoryResult {
  /** Absolute path written to. */
  path: string;
  /** True iff REASONIX.md did not exist before this call. */
  created: boolean;
}

/**
 * Append `note` as a single bullet to `<rootDir>/REASONIX.md`. Creates
 * the file with a short header when absent. Inserts a leading newline
 * if the existing file doesn't end with one, so bullets don't collide
 * with the previous section's last line.
 */
export function appendProjectMemory(rootDir: string, note: string): AppendProjectMemoryResult {
  const path = join(rootDir, PROJECT_MEMORY_FILE);
  const trimmed = note.trim();
  if (!trimmed) throw new Error("note body cannot be empty");
  const bullet = `- ${trimmed}\n`;
  if (!existsSync(path)) {
    writeFileSync(path, `${NEW_FILE_HEADER}${bullet}`, "utf8");
    return { path, created: true };
  }
  let prefix = "";
  try {
    const existing = readFileSync(path, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
  } catch {
    // Unreadable but exists — let appendFileSync surface the real error.
  }
  appendFileSync(path, `${prefix}${bullet}`, "utf8");
  return { path, created: false };
}
