import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const samples = [
  ["tests/checkpoints.test.ts", "snapshots existing files with their content"],
  ["tests/checkpoints.test.ts", "matches by exact id"],
  ["tests/compact-tokens.test.ts", "leaves small tool messages alone"],
  ["tests/compact-tokens.test.ts", "shrinks tool messages that exceed the token budget"],
  ["tests/diff.test.ts", null],
  ["tests/edit-blocks.test.ts", null],
  ["tests/event-replay.test.ts", null],
  ["tests/event-sink-jsonl.test.ts", null],
  ["tests/at-mentions.test.ts", null],
  ["tests/bang.test.ts", null],
];

function pickFirstIt(file) {
  const src = readFileSync(file, "utf8");
  const m = src.match(/^\s*(?:it|test)\(["']([^"']+)["']/m);
  return m ? m[1] : null;
}

function runOnce(file, name) {
  const args = ["vitest", "--run", file];
  if (name) args.push("-t", name);
  const t0 = Date.now();
  const res = spawnSync("npx", args, { encoding: "utf8", shell: true });
  const ms = Date.now() - t0;
  return { ms, ok: res.status === 0, stderr: res.stderr.slice(-400) };
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * p)];
}

const results = [];
console.log("Sampling test names where missing…");
for (const s of samples) {
  if (!s[1]) {
    s[1] = pickFirstIt(s[0]);
    console.log(`  ${s[0]} → "${s[1]}"`);
  }
}

console.log("\nCold run (each test, first time):");
const cold = [];
for (const [file, name] of samples) {
  const r = runOnce(file, name);
  cold.push(r.ms);
  console.log(`  ${file} -t "${name?.slice(0, 40)}…" → ${r.ms}ms  ok=${r.ok}`);
  results.push({ phase: "cold", file, name, ...r });
}

console.log("\nWarm run (immediate repeat):");
const warm = [];
for (const [file, name] of samples) {
  const r = runOnce(file, name);
  warm.push(r.ms);
  console.log(`  ${file} -t "${name?.slice(0, 40)}…" → ${r.ms}ms  ok=${r.ok}`);
  results.push({ phase: "warm", file, name, ...r });
}

const summary = {
  cold: { median: pct(cold, 0.5), p95: pct(cold, 0.95), max: Math.max(...cold) },
  warm: { median: pct(warm, 0.5), p95: pct(warm, 0.95), max: Math.max(...warm) },
};

console.log("\n=== Summary ===");
console.log(JSON.stringify(summary, null, 2));

writeFileSync(
  new URL("./latency.json", import.meta.url),
  JSON.stringify({ summary, runs: results }, null, 2),
);
