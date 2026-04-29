#!/usr/bin/env node
// One-shot smoke: walk the repo with default + .gitignore, print bucket counts.

import { resolveIndexConfig } from "../src/index/config.ts";
import { walkChunks } from "../src/index/semantic/chunker.ts";

const root = process.cwd();
const buckets = {
  defaultDir: 0,
  defaultFile: 0,
  binaryExt: 0,
  binaryContent: 0,
  tooLarge: 0,
  gitignore: 0,
  pattern: 0,
  readError: 0,
};
const includedFiles = new Set();

const t0 = Date.now();
const patternHits = [];
for await (const chunk of walkChunks(root, {
  config: resolveIndexConfig({ excludePatterns: ["**/dashboard/**", "**/*.test.ts"] }),
  onSkip: (p, reason) => {
    buckets[reason]++;
    if (reason === "pattern" && patternHits.length < 5) patternHits.push(p);
  },
})) {
  includedFiles.add(chunk.path);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

console.log(`walked ${root} in ${elapsed}s`);
console.log(`included ${includedFiles.size} files`);
console.log("skip buckets:");
for (const [k, v] of Object.entries(buckets)) {
  if (v > 0) console.log(`  ${k}: ${v}`);
}
if (patternHits.length > 0) {
  console.log("pattern sample:");
  for (const p of patternHits) console.log(`  ${p}`);
}
