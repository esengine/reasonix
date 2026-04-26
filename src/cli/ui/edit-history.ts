import { formatAllBlockDiffs } from "../../code/diff-preview.js";
import type { ApplyResult, EditBlock, EditSnapshot } from "../../code/edit-blocks.js";

/**
 * One batch of edits that actually landed on disk — durable enough for
 * `/undo`, `/history`, and `/show` within a session. Not persisted
 * across restarts: restoring pre-apply content from a process that
 * crashed last week is git's job, not ours.
 */
export interface EditHistoryEntry {
  /** Sequence number within the session, stable for `/show <id>`. */
  id: number;
  /** Epoch ms when the entry was opened (first edit landed). */
  at: number;
  /**
   * Short tag for what produced the batch — "auto" (auto-mode tool
   * call), "auto-text" (auto-mode text SEARCH/REPLACE at turn end),
   * "review-apply" (user-approved modal edit or /apply flush).
   */
  source: string;
  /** Edit blocks included in this batch, in arrival order. */
  blocks: EditBlock[];
  /** Per-block outcome — some may be "not-found" if SEARCH drifted. */
  results: ApplyResult[];
  /**
   * First-snapshot-per-path wins: this is what `/undo` restores to.
   * Deduped so multi-edit turns still roll back to pre-turn state.
   */
  snapshots: EditSnapshot[];
  /**
   * Paths within this entry that have already been reverted (via
   * `/undo <id>`, `/undo <id> <path>`, or the newest-non-undone /undo
   * shortcut). Per-path instead of entry-level so a batch can be
   * partially undone — user reverts src/foo.ts out of a 3-file batch
   * without rolling back the other two.
   */
  undoneFiles: Set<string>;
}

/** True when every path in the entry has been undone. */
export function isEntryFullyUndone(e: EditHistoryEntry): boolean {
  return e.snapshots.length > 0 && e.snapshots.every((s) => e.undoneFiles.has(s.path));
}

/** Per-entry three-state status label for display. */
export function entryStatus(e: EditHistoryEntry): "applied" | "UNDONE" | "PARTIAL" {
  if (e.undoneFiles.size === 0) return "applied";
  if (isEntryFullyUndone(e)) return "UNDONE";
  return "PARTIAL";
}

/**
 * Render a batch of SEARCH/REPLACE application results as one
 * human-scannable info line per edit. Prefixes denote status so the
 * line reads well even without color (e.g. when piped to a log file
 * or stripped for screenshots):
 *   ✓ applied  src/foo.ts
 *   ✓ created  src/new.ts
 *   ✗ not-found  src/bar.ts (SEARCH text does not match…)
 */
export function formatEditResults(results: ApplyResult[]): string {
  const lines = results.map((r) => {
    const mark = r.status === "applied" || r.status === "created" ? "✓" : "✗";
    const detail = r.message ? ` (${r.message})` : "";
    return `  ${mark} ${r.status.padEnd(11)} ${r.path}${detail}`;
  });
  const ok = results.filter((r) => r.status === "applied" || r.status === "created").length;
  const total = results.length;
  const header = `▸ edit blocks: ${ok}/${total} applied — /undo to roll back, or \`git diff\` to review`;
  return [header, ...lines].join("\n");
}

/**
 * Pending-edits preview shown after each assistant turn that proposed
 * changes. Per-block path header + ±line-count, then a unified-diff-
 * style preview (context trimmed to 2 lines each side, total capped
 * at 20 lines per block). Users can eyeball what's about to land
 * BEFORE pressing `y` — the old summary-only view was a common
 * mistake surface.
 *
 * Each block gets a `[N]` label so users can target a subset via
 * `/apply 1` / `/apply 1,3-4` / `/discard 2` instead of being forced
 * into all-or-nothing.
 */
export function formatPendingPreview(blocks: EditBlock[]): string {
  const partial = blocks.length > 1 ? "  ·  /apply N or 1,3-4 for partial" : "";
  const header = `▸ ${blocks.length} pending edit block(s) — /apply (or y) to commit · /discard (or n) to drop${partial}`;
  const diffLines = formatAllBlockDiffs(blocks, { numbered: blocks.length > 1 });
  return [header, ...diffLines].join("\n");
}

/**
 * Parse a `/apply <N>` / `/discard <N>` argument into a deduplicated,
 * sorted list of 1-based indices. Accepts:
 *   - single value: `"3"`         → [3]
 *   - comma list:   `"1,3,5"`     → [1, 3, 5]
 *   - range:        `"2-4"`        → [2, 3, 4]
 *   - mixed:        `"1,3-5,7"`    → [1, 3, 4, 5, 7]
 *   - whitespace + trailing commas tolerated.
 *
 * Bounds-checked against `max` (the count of pending blocks); any
 * out-of-range or malformed token returns `{ error }` so the caller
 * can surface a usage hint instead of silently applying the wrong
 * subset. Empty input returns `{ ok: [] }` so callers can detect
 * "user passed no indices" and treat that as the all-blocks default.
 */
export function parseEditIndices(raw: string, max: number): { ok: number[] } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: [] };
  if (max <= 0) return { error: "no pending edits to address" };
  const seen = new Set<number>();
  const tokens = trimmed
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: [] };
  for (const tok of tokens) {
    const range = tok.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = Number.parseInt(range[1] ?? "", 10);
      const b = Number.parseInt(range[2] ?? "", 10);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1) {
        return { error: `invalid range: "${tok}"` };
      }
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi > max) return { error: `index ${hi} out of range (max ${max})` };
      for (let i = lo; i <= hi; i++) seen.add(i);
      continue;
    }
    if (!/^\d+$/.test(tok)) return { error: `invalid index: "${tok}"` };
    const n = Number.parseInt(tok, 10);
    if (!Number.isFinite(n) || n < 1) return { error: `invalid index: "${tok}"` };
    if (n > max) return { error: `index ${n} out of range (max ${max})` };
    seen.add(n);
  }
  return { ok: [...seen].sort((a, b) => a - b) };
}

/**
 * Partition `edits` into the subset addressed by `indices1Based` and
 * everything else (preserves original order). Pure helper so the
 * pending-edits queue can be sliced from the slash handler in App.tsx
 * without any React-state plumbing in the test path.
 */
export function partitionEdits<T>(
  edits: readonly T[],
  indices1Based: readonly number[],
): { selected: T[]; remaining: T[] } {
  const picked = new Set(indices1Based);
  const selected: T[] = [];
  const remaining: T[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (picked.has(i + 1)) selected.push(edits[i] as T);
    else remaining.push(edits[i] as T);
  }
  return { selected, remaining };
}

/**
 * Per-file rows for the multi-level `/undo` output, without the
 * single-batch header (the caller prepends its own).
 */
export function formatUndoRows(results: ApplyResult[]): string[] {
  return results.map((r) => {
    const mark = r.status === "applied" ? "✓" : "✗";
    const detail = r.message ? ` (${r.message})` : "";
    return `  ${mark} ${r.path}${detail}`;
  });
}

export function describeRepair(repair: {
  scavenged: number;
  truncationsFixed: number;
  stormsBroken: number;
}): string {
  const parts: string[] = [];
  if (repair.scavenged) parts.push(`scavenged ${repair.scavenged}`);
  if (repair.truncationsFixed) parts.push(`repaired ${repair.truncationsFixed} truncation`);
  if (repair.stormsBroken) parts.push(`broke ${repair.stormsBroken} storm`);
  return parts.length ? `[repair] ${parts.join(", ")}` : "";
}
