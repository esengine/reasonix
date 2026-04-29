/**
 * Per-workspace edit checkpoints — Cursor-style "snapshot the files,
 * restore later" mechanism. Replaces the auto-commit feature that was
 * proposed and rejected on git-pollution grounds: instead of writing
 * every edit batch to git, we write opt-in named snapshots to a
 * dot-folder that lives outside the user's repo entirely.
 *
 * Storage layout:
 *   ~/.reasonix/sessions/<sanitized-root>/checkpoints/index.json
 *   ~/.reasonix/sessions/<sanitized-root>/checkpoints/<id>.json
 *
 * Each `<id>.json` is a complete file-content snapshot:
 *   { id, name, createdAt, files: [{ path, content }] }
 *
 * `index.json` is a small lookup so `/checkpoint list` doesn't have
 * to load every snapshot off disk to enumerate them.
 *
 * Why one file per checkpoint instead of jsonl: deletion + selective
 * restore are common operations; rewriting a 50MB jsonl every time the
 * user runs `/checkpoint forget bad-attempt` is wasteful. Per-file
 * also means a corrupt snapshot only loses ONE checkpoint, not the
 * whole history.
 *
 * Why NOT git: see `feedback_internal_checkpoints_over_git.md` in
 * memory. Three reasons in one line: pollutes user's history, fights
 * with hooks, fails in non-git dirs.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/** One file's state at the time of snapshot. `content === null` → didn't exist. */
export interface CheckpointFile {
  path: string;
  content: string | null;
}

export interface Checkpoint {
  id: string;
  /** User-given name, or `auto-<reason>` for system-created snapshots. */
  name: string;
  /** Absolute workspace root the snapshot belongs to. */
  rootDir: string;
  createdAt: number;
  source: "manual" | "auto-session-start" | "auto-pre-restore";
  files: CheckpointFile[];
  /** Total bytes of file content captured (sum of `content?.length`). */
  bytes: number;
}

export interface CheckpointMeta {
  id: string;
  name: string;
  createdAt: number;
  source: Checkpoint["source"];
  fileCount: number;
  bytes: number;
}

/** Sanitize a directory path into a safe filesystem name for the store. */
function sanitizeRoot(rootDir: string): string {
  return resolve(rootDir)
    .replace(/[\\/:]+/g, "_")
    .replace(/^_+/, "");
}

function storeRoot(rootDir: string): string {
  return join(homedir(), ".reasonix", "sessions", sanitizeRoot(rootDir), "checkpoints");
}

function indexPath(rootDir: string): string {
  return join(storeRoot(rootDir), "index.json");
}

function snapshotPath(rootDir: string, id: string): string {
  return join(storeRoot(rootDir), `${id}.json`);
}

/** Load the index of checkpoint metadata for a workspace. Empty when missing. */
export function listCheckpoints(rootDir: string): CheckpointMeta[] {
  const path = indexPath(rootDir);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: filter out malformed entries rather than throwing on
    // a single bad row. A stale entry is annoying; a thrown listCheckpoints
    // would break /checkpoint list entirely.
    return parsed.filter(
      (m): m is CheckpointMeta =>
        typeof m === "object" &&
        m !== null &&
        typeof m.id === "string" &&
        typeof m.name === "string" &&
        typeof m.createdAt === "number" &&
        typeof m.source === "string" &&
        typeof m.fileCount === "number" &&
        typeof m.bytes === "number",
    );
  } catch {
    return [];
  }
}

function writeIndex(rootDir: string, items: CheckpointMeta[]): void {
  const path = indexPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(items, null, 2), "utf8");
}

/** Read a single checkpoint by id. Returns null when missing or corrupt. */
export function loadCheckpoint(rootDir: string, id: string): Checkpoint | null {
  const path = snapshotPath(rootDir, id);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.files)) {
      return parsed as Checkpoint;
    }
    return null;
  } catch {
    return null;
  }
}

export interface CreateCheckpointOptions {
  rootDir: string;
  name: string;
  source?: Checkpoint["source"];
  /**
   * Repo-relative paths to snapshot. Caller decides what's "interesting"
   * — typically the union of (touched-this-session ∪ pending-edits ∪
   * a user-supplied path list). Empty list → empty snapshot, which is
   * legal for "session-start baseline" use cases.
   */
  paths: readonly string[];
}

/**
 * Create a checkpoint by capturing each path's current on-disk content.
 * Files that don't exist are recorded with `content: null` so a
 * subsequent restore knows to delete them. Returns the saved metadata.
 *
 * IDs are timestamp-based + a 4-char suffix to keep them collision-free
 * even when the user fires `/checkpoint name1` and `/checkpoint name2`
 * within the same millisecond (rare in practice but cheap to handle).
 */
export function createCheckpoint(opts: CreateCheckpointOptions): CheckpointMeta {
  const absRoot = resolve(opts.rootDir);
  const id = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const files: CheckpointFile[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  for (const p of opts.paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    const abs = resolve(absRoot, p);
    // Path-escape guard. A snapshot of `../../../etc/passwd` is not
    // something we want — refuse silently rather than abort the whole
    // checkpoint.
    if (abs !== absRoot && !abs.startsWith(`${absRoot}${sep}`)) continue;
    const rel = relative(absRoot, abs).split(sep).join("/");
    if (existsSync(abs)) {
      try {
        const content = readFileSync(abs, "utf8");
        files.push({ path: rel, content });
        bytes += content.length;
      } catch {
        // Unreadable (binary, perms) — record as null so restore knows
        // to delete on revert. Wrong for binary files but consistent.
        files.push({ path: rel, content: null });
      }
    } else {
      files.push({ path: rel, content: null });
    }
  }

  const checkpoint: Checkpoint = {
    id,
    name: opts.name,
    rootDir: absRoot,
    createdAt: Date.now(),
    source: opts.source ?? "manual",
    files,
    bytes,
  };
  const cpPath = snapshotPath(absRoot, id);
  mkdirSync(dirname(cpPath), { recursive: true });
  writeFileSync(cpPath, JSON.stringify(checkpoint), "utf8");

  const meta: CheckpointMeta = {
    id,
    name: opts.name,
    createdAt: checkpoint.createdAt,
    source: checkpoint.source,
    fileCount: files.length,
    bytes,
  };
  const items = listCheckpoints(absRoot);
  items.push(meta);
  writeIndex(absRoot, items);
  return meta;
}

/**
 * Look up a checkpoint by id, or by name (most-recent wins on
 * collision). Returns null when nothing matches.
 */
export function findCheckpoint(rootDir: string, idOrName: string): CheckpointMeta | null {
  const items = listCheckpoints(rootDir);
  // Prefer exact id match, then most-recent name match.
  const byId = items.find((m) => m.id === idOrName);
  if (byId) return byId;
  const byName = [...items].reverse().find((m) => m.name === idOrName);
  return byName ?? null;
}

export interface RestoreResult {
  /** Files we wrote back to disk. */
  restored: string[];
  /** Files we removed (snapshot had `content: null`, file existed). */
  removed: string[];
  /** Files we couldn't touch (errors), with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Restore a checkpoint. Returns a per-file report so the caller can
 * surface what landed and what didn't. Path-escape is double-checked
 * against the live `rootDir`, which may differ from the snapshot's
 * (e.g. user moved the project).
 */
export function restoreCheckpoint(rootDir: string, id: string): RestoreResult {
  const cp = loadCheckpoint(rootDir, id);
  const absRoot = resolve(rootDir);
  const result: RestoreResult = { restored: [], removed: [], skipped: [] };
  if (!cp) {
    result.skipped.push({ path: "(checkpoint)", reason: `not found: ${id}` });
    return result;
  }
  for (const f of cp.files) {
    const abs = resolve(absRoot, f.path);
    if (abs !== absRoot && !abs.startsWith(`${absRoot}${sep}`)) {
      result.skipped.push({ path: f.path, reason: "path escapes rootDir" });
      continue;
    }
    try {
      if (f.content === null) {
        if (existsSync(abs)) {
          rmSync(abs);
          result.removed.push(f.path);
        }
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content, "utf8");
        result.restored.push(f.path);
      }
    } catch (err) {
      result.skipped.push({ path: f.path, reason: (err as Error).message });
    }
  }
  return result;
}

/**
 * Delete a checkpoint by id. Returns true iff the snapshot file +
 * index entry were both removed (or already absent in the case of a
 * partial-write left behind from a crash).
 */
export function deleteCheckpoint(rootDir: string, id: string): boolean {
  const cpPath = snapshotPath(rootDir, id);
  let removed = false;
  if (existsSync(cpPath)) {
    try {
      rmSync(cpPath);
      removed = true;
    } catch {
      return false;
    }
  }
  const items = listCheckpoints(rootDir);
  const next = items.filter((m) => m.id !== id);
  if (next.length !== items.length) {
    writeIndex(rootDir, next);
    removed = true;
  }
  return removed;
}

/** Format ms-timestamp diff as human-readable relative age. */
export function fmtAgo(ms: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
