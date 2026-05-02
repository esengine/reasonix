/** Classifies a tool-list drift across an MCP reconnect. Drives the policy in `/mcp reconnect`. */

import type { ToolSpec } from "../types.js";

/** Ordered by "cache cost" — `identity` and `append` are nearly free; `reorder` is catastrophic. */
export type DriftKind = "identity" | "append" | "edit" | "reorder" | "remove";

export interface DriftReport {
  kind: DriftKind;
  /** Tool names added by the new spec (relative to `before`). */
  added: string[];
  /** Tool names removed by the new spec (gone from `after`). */
  removed: string[];
  /** Tool names whose name + position match but whose serialized content changed. */
  edited: string[];
}

export function classifyToolListDrift(
  before: readonly ToolSpec[],
  after: readonly ToolSpec[],
): DriftReport {
  const beforeNames = before.map(nameOf);
  const afterNames = after.map(nameOf);
  const beforeSet = new Set(beforeNames);
  const afterSet = new Set(afterNames);

  const added = afterNames.filter((n) => !beforeSet.has(n));
  const removed = beforeNames.filter((n) => !afterSet.has(n));

  const edited: string[] = [];
  // Same-position-same-name slots whose serialized content differs.
  const sharedLen = Math.min(before.length, after.length);
  for (let i = 0; i < sharedLen; i++) {
    if (beforeNames[i] === afterNames[i] && hash(before[i]!) !== hash(after[i]!)) {
      edited.push(beforeNames[i]!);
    }
  }

  // Identity: same length, same names in order, same content.
  if (
    before.length === after.length &&
    edited.length === 0 &&
    beforeNames.every((n, i) => n === afterNames[i])
  ) {
    return { kind: "identity", added: [], removed: [], edited: [] };
  }

  // Remove anywhere → catastrophic regardless of other changes.
  if (removed.length > 0) {
    return { kind: "remove", added, removed, edited };
  }

  // Append: every before-tool stays put with identical content, new ones tacked on the end.
  if (
    after.length > before.length &&
    beforeNames.every((n, i) => n === afterNames[i] && hash(before[i]!) === hash(after[i]!))
  ) {
    return { kind: "append", added, removed: [], edited: [] };
  }

  // Same name set as before? Then positions or content changed.
  const sameNameSet =
    beforeSet.size === afterSet.size && [...beforeSet].every((n) => afterSet.has(n));
  if (sameNameSet) {
    const positionsMatch = beforeNames.every((n, i) => n === afterNames[i]);
    if (positionsMatch) {
      // Names + positions stable, only content edited in place.
      return { kind: "edit", added: [], removed: [], edited };
    }
    // Same set, different order — cache-wise as bad as a structural change.
    return { kind: "reorder", added: [], removed: [], edited };
  }

  // Additions present but NOT clean appends (e.g. inserted in the middle, or
  // appended-but-existing-tools-also-edited). Treat as reorder for safety —
  // the divergence point is no longer the tail of the list.
  return { kind: "reorder", added, removed: [], edited };
}

function nameOf(spec: ToolSpec): string {
  return spec.function?.name ?? "";
}

function hash(spec: ToolSpec): string {
  return JSON.stringify(spec);
}
