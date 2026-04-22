/**
 * Project memory — a user-authored `REASONIX.md` in the project root
 * that gets pinned into the immutable-prefix system prompt.
 *
 * Design notes:
 *
 *   - The file lands in `ImmutablePrefix.system`, so the whole memory
 *     block is hashed into the cache prefix fingerprint. Editing the
 *     file invalidates the prefix; unchanged memory across sessions
 *     keeps the DeepSeek prefix cache warm. That matches Pillar 1 —
 *     memory is a deliberate, stable prefix, not per-turn drift.
 *   - Only one source: the working-root `REASONIX.md`. No parent walk,
 *     no `~/.reasonix/REASONIX.md`, no CLAUDE.md fallback. User-global
 *     memory can come later; for v1 one file == one mental model.
 *   - Truncated at 8 000 chars (≈ 2k tokens). `.gitignore` gets 2 000
 *     because it's a constraint dump; memory gets more headroom because
 *     it's deliberate instructions.
 *   - Opt-out via `REASONIX_MEMORY=off|false|0`. No CLI flag — memory
 *     is a file, `rm REASONIX.md` is the other opt-out.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_MEMORY_FILE = "REASONIX.md";
export const PROJECT_MEMORY_MAX_CHARS = 8000;

export interface ProjectMemory {
  /** Absolute path the memory was read from. */
  path: string;
  /** Post-truncation content (may include a "… (truncated N chars)" marker). */
  content: string;
  /** Original byte length before truncation. */
  originalChars: number;
  /** True iff `originalChars > PROJECT_MEMORY_MAX_CHARS`. */
  truncated: boolean;
}

/**
 * Read `REASONIX.md` from `rootDir`. Returns `null` when the file is
 * missing, unreadable, or empty (whitespace-only counts as empty — an
 * empty memory file shouldn't perturb the cache prefix).
 */
export function readProjectMemory(rootDir: string): ProjectMemory | null {
  const path = join(rootDir, PROJECT_MEMORY_FILE);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const originalChars = trimmed.length;
  const truncated = originalChars > PROJECT_MEMORY_MAX_CHARS;
  const content = truncated
    ? `${trimmed.slice(0, PROJECT_MEMORY_MAX_CHARS)}\n… (truncated ${
        originalChars - PROJECT_MEMORY_MAX_CHARS
      } chars)`
    : trimmed;
  return { path, content, originalChars, truncated };
}

/**
 * Resolve whether project memory should be read. Default: on.
 * `REASONIX_MEMORY=off|false|0` turns it off (CI, reproducing issues,
 * intentional offline runs).
 */
export function memoryEnabled(): boolean {
  const env = process.env.REASONIX_MEMORY;
  if (env === "off" || env === "false" || env === "0") return false;
  return true;
}

/**
 * Return `basePrompt` with the project's `REASONIX.md` appended as a
 * "Project memory" section. No-op when the file is absent, empty, or
 * memory is disabled via env.
 *
 * The appended block is deterministic — identical input ⇒ identical
 * output — so every session that opens against the same memory file
 * gets the same prefix hash.
 */
export function applyProjectMemory(basePrompt: string, rootDir: string): string {
  if (!memoryEnabled()) return basePrompt;
  const mem = readProjectMemory(rootDir);
  if (!mem) return basePrompt;
  return `${basePrompt}

# Project memory (REASONIX.md)

The user pinned these notes about this project — treat them as authoritative context for every turn:

\`\`\`
${mem.content}
\`\`\`
`;
}
