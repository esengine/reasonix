/**
 * Aider-style SEARCH/REPLACE edit blocks.
 *
 * The model emits blocks in this exact shape, one or more per response:
 *
 *   path/to/file.ts
 *   <<<<<<< SEARCH
 *   exact existing lines (whitespace-sensitive)
 *   =======
 *   replacement lines
 *   >>>>>>> REPLACE
 *
 * We chose this over unified diffs because:
 *   - Models produce it reliably — no line-number drift.
 *   - It tolerates multi-edit responses without ambiguity over which
 *     hunk belongs to which file.
 *   - Aider has years of evidence that this format works even against
 *     weaker models than DeepSeek R1, so it's a conservative pick.
 *
 * The SEARCH text must match the file byte-for-byte. Empty SEARCH is a
 * sentinel for "create new file" — the REPLACE becomes the whole file.
 * If SEARCH doesn't match we refuse the edit and surface the failure;
 * we do NOT guess or fuzzy-match. A wrong silent edit is worse than a
 * missing one — the user can re-ask with the exact current content.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface EditBlock {
  /** Path as written by the model — relative to rootDir, or absolute. */
  path: string;
  /** Literal text to match in the target file. Empty → create new file. */
  search: string;
  /** Replacement text to write in place of `search`. */
  replace: string;
  /** Char offset in the source message where this block started. */
  offset: number;
}

export type ApplyStatus =
  /** Edit landed on disk. */
  | "applied"
  /** New file created (SEARCH was empty and file didn't exist). */
  | "created"
  /** File exists but SEARCH block wasn't found in its content. */
  | "not-found"
  /** File doesn't exist and SEARCH was non-empty (can't create without content). */
  | "file-missing"
  /** Path escapes rootDir — refused on safety grounds. */
  | "path-escape"
  /** fs write / read threw. */
  | "error";

export interface ApplyResult {
  path: string;
  status: ApplyStatus;
  /** Extra detail (e.g. error message) for logs. */
  message?: string;
}

/**
 * One edit block per match. The regex is anchored to the 7-char marker
 * lines because those are visually distinct and unlikely to appear in
 * normal code.
 *
 * Anchored with `^` + `m` flag so the filename has to live on its own
 * line. Keeps us from matching e.g. a JS-import string that happens to
 * contain `<<<<<<< SEARCH` in inner text.
 */
// `\n?` before the =======/REPLACE separators makes the body optional:
// empty SEARCH (new-file sentinel) works without requiring a gratuitous
// empty line, and the same holds for empty REPLACE (file-deletion
// semantics, not yet supported but cheaply representable).
const BLOCK_RE = /^(\S[^\n]*)\n<{7} SEARCH\n([\s\S]*?)\n?={7}\n([\s\S]*?)\n?>{7} REPLACE/gm;

export function parseEditBlocks(text: string): EditBlock[] {
  const out: EditBlock[] = [];
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null = BLOCK_RE.exec(text);
  while (m !== null) {
    out.push({
      path: m[1]!.trim(),
      search: m[2]!,
      replace: m[3]!,
      offset: m.index,
    });
    m = BLOCK_RE.exec(text);
  }
  return out;
}

export function applyEditBlock(block: EditBlock, rootDir: string): ApplyResult {
  const absRoot = resolve(rootDir);
  const absTarget = resolve(absRoot, block.path);
  // Refuse paths that escape rootDir. `resolve` normalizes `..`, so
  // startsWith on the normalized pair is enough.
  if (absTarget !== absRoot && !absTarget.startsWith(`${absRoot}${sep()}`)) {
    return {
      path: block.path,
      status: "path-escape",
      message: `resolved path ${absTarget} is outside rootDir ${absRoot}`,
    };
  }

  const searchEmpty = block.search.length === 0;
  const exists = existsSync(absTarget);

  try {
    if (!exists) {
      if (!searchEmpty) {
        return {
          path: block.path,
          status: "file-missing",
          message: "file does not exist; to create it, use an empty SEARCH block",
        };
      }
      mkdirSync(dirname(absTarget), { recursive: true });
      writeFileSync(absTarget, block.replace, "utf8");
      return { path: block.path, status: "created" };
    }

    const content = readFileSync(absTarget, "utf8");
    if (searchEmpty) {
      return {
        path: block.path,
        status: "not-found",
        message: "empty SEARCH only creates new files — this file already exists",
      };
    }
    const idx = content.indexOf(block.search);
    if (idx === -1) {
      return {
        path: block.path,
        status: "not-found",
        message: "SEARCH text does not match the current file content exactly",
      };
    }
    // Replace only the first occurrence — if the model needs multiple
    // identical edits it should emit multiple blocks (each anchored by
    // more surrounding context). Auto-expanding to replace-all is a
    // footgun when the same string legitimately appears in several
    // unrelated places.
    const replaced = `${content.slice(0, idx)}${block.replace}${content.slice(idx + block.search.length)}`;
    writeFileSync(absTarget, replaced, "utf8");
    return { path: block.path, status: "applied" };
  } catch (err) {
    return { path: block.path, status: "error", message: (err as Error).message };
  }
}

export function applyEditBlocks(blocks: EditBlock[], rootDir: string): ApplyResult[] {
  return blocks.map((b) => applyEditBlock(b, rootDir));
}

/**
 * Build an EditBlock that represents a whole-file overwrite. If the
 * target exists, SEARCH = current content so applyEditBlock replaces
 * the whole thing when committed; if it doesn't, SEARCH is empty (the
 * create-new sentinel). Used by the edit-mode gate when routing a
 * `write_file` tool call through the review queue without executing
 * the write inline.
 */
export function toWholeFileEditBlock(
  path: string,
  content: string,
  rootDir: string,
): EditBlock {
  const abs = resolve(rootDir, path);
  let search = "";
  if (existsSync(abs)) {
    try {
      search = readFileSync(abs, "utf8");
    } catch {
      search = "";
    }
  }
  return { path, search, replace: content, offset: 0 };
}

// ---------- snapshot / restore (for /undo) ----------

export interface EditSnapshot {
  /** Path relative to rootDir, as the block named it. */
  path: string;
  /**
   * File content before the edit batch was applied. `null` means the
   * file didn't exist yet — restoring that means deleting whatever the
   * edit created.
   */
  prevContent: string | null;
}

/**
 * Capture the current state of every file an edit batch is about to
 * touch, so `/undo` can roll back if the user doesn't like the result.
 * De-duplicates by path because one batch can contain multiple blocks
 * for the same file, and we only want one "before" snapshot per file.
 */
export function snapshotBeforeEdits(blocks: EditBlock[], rootDir: string): EditSnapshot[] {
  const absRoot = resolve(rootDir);
  const seen = new Set<string>();
  const snapshots: EditSnapshot[] = [];
  for (const b of blocks) {
    if (seen.has(b.path)) continue;
    seen.add(b.path);
    const abs = resolve(absRoot, b.path);
    if (!existsSync(abs)) {
      snapshots.push({ path: b.path, prevContent: null });
      continue;
    }
    try {
      snapshots.push({ path: b.path, prevContent: readFileSync(abs, "utf8") });
    } catch {
      // Unreadable (permission / binary) — record null so we at least
      // don't pretend the snapshot is authoritative. The restore path
      // will treat null as "delete on undo", which is wrong in that
      // case but the file wasn't ours to begin with.
      snapshots.push({ path: b.path, prevContent: null });
    }
  }
  return snapshots;
}

/**
 * Restore files to their snapshotted state. Snapshots with
 * `prevContent === null` were created by the edit, so undo = delete.
 * Otherwise the prior content is written back, replacing whatever the
 * edit left behind.
 */
export function restoreSnapshots(snapshots: EditSnapshot[], rootDir: string): ApplyResult[] {
  const absRoot = resolve(rootDir);
  return snapshots.map((snap) => {
    const abs = resolve(absRoot, snap.path);
    if (abs !== absRoot && !abs.startsWith(`${absRoot}${sep()}`)) {
      return {
        path: snap.path,
        status: "path-escape",
        message: "snapshot path escapes rootDir — refusing to restore",
      };
    }
    try {
      if (snap.prevContent === null) {
        if (existsSync(abs)) unlinkSync(abs);
        return {
          path: snap.path,
          status: "applied",
          message: "removed (the edit had created it)",
        };
      }
      writeFileSync(abs, snap.prevContent, "utf8");
      return {
        path: snap.path,
        status: "applied",
        message: "restored to pre-edit content",
      };
    } catch (err) {
      return { path: snap.path, status: "error", message: (err as Error).message };
    }
  });
}

/** Platform separator — `\` on Windows, `/` elsewhere. */
function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}
