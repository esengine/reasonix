/** Nested .gitignore evaluation — shared by the at-mention picker walker and the semantic chunker. */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

export interface GitignoreLayer {
  /** Absolute dir the .gitignore lives in. Patterns evaluate relative to this. */
  dirAbs: string;
  ig: Ignore;
}

export async function loadGitignoreAt(dirAbs: string): Promise<Ignore | null> {
  try {
    return ignore().add(await readFile(path.join(dirAbs, ".gitignore"), "utf8"));
  } catch {
    return null;
  }
}

export function loadGitignoreAtSync(dirAbs: string): Ignore | null {
  try {
    return ignore().add(readFileSync(path.join(dirAbs, ".gitignore"), "utf8"));
  } catch {
    return null;
  }
}

/** True if any layer — outermost to innermost — ignores this path. */
export function ignoredByLayers(
  layers: readonly GitignoreLayer[],
  abs: string,
  isDir: boolean,
): boolean {
  for (const layer of layers) {
    const rel = path.relative(layer.dirAbs, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) continue;
    if (layer.ig.ignores(isDir ? `${rel}/` : rel)) return true;
  }
  return false;
}
