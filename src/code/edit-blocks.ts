/** SEARCH must match byte-for-byte; empty SEARCH = create new file. No fuzzy match — silent wrong edit beats a missing one. */

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

// `^` + `m` keeps a JS string containing `<<<<<<< SEARCH` from matching as a real block.
// `\n?` makes empty SEARCH/REPLACE bodies legal (new-file / future delete sentinels).
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
    const le = lineEndingOf(content);
    const adaptedSearch = block.search.replace(/\r?\n/g, le);
    const adaptedReplace = block.replace.replace(/\r?\n/g, le);
    const idx = content.indexOf(adaptedSearch);
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
    const replaced = `${content.slice(0, idx)}${adaptedReplace}${content.slice(idx + adaptedSearch.length)}`;
    writeFileSync(absTarget, replaced, "utf8");
    return { path: block.path, status: "applied" };
  } catch (err) {
    return { path: block.path, status: "error", message: (err as Error).message };
  }
}

export function applyEditBlocks(blocks: EditBlock[], rootDir: string): ApplyResult[] {
  return blocks.map((b) => applyEditBlock(b, rootDir));
}

export function toWholeFileEditBlock(path: string, content: string, rootDir: string): EditBlock {
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

export interface EditSnapshot {
  /** Path relative to rootDir, as the block named it. */
  path: string;
  /** `null` = file didn't exist; restore means delete. */
  prevContent: string | null;
}

/** De-duped by path — one "before" snapshot per file even with multiple blocks. */
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

function lineEndingOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
