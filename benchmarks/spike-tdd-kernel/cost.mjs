// Exp 1 — cost: does augmenting tool_result with test_run footers drop cache hit?
//
// Approach: build two synthetic 4-turn agent transcripts, identical except that
// variant B's tool_results carry an extra "[test_run: …]" footer. For each
// variant, send a "warmup" call to seed the prefix cache, then a "hot" call
// with a small tail change. Measure cache hit ratio on the hot call.
//
// Hypothesis: ratios within ±2 pts; both ≥92%.

import { readFileSync, writeFileSync } from "node:fs";

for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const apiKey = process.env.DEEPSEEK_API_KEY;
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";

const SYS = `You are a coding agent working in a TypeScript repository.
You have these tools available: read_file, edit_file, run_command, list_dir.
Reply concisely. Do NOT call any tool in this synthetic transcript — just respond in plain text when asked.`;

// 4-turn synthetic transcript with three tool_result messages.
const transcript = [
  { role: "system", content: SYS },
  { role: "user", content: "Find where the slugify helper is defined and show me its current implementation." },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "c1", type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "src/util" }) } },
    ],
  },
  {
    role: "tool",
    tool_call_id: "c1",
    content: "src/util/clamp.ts\nsrc/util/color.ts\nsrc/util/duration.ts\nsrc/util/ranges.ts\nsrc/util/ring.ts\nsrc/util/slugify.ts\nsrc/util/uniq.ts",
  },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "c2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/util/slugify.ts" }) } },
    ],
  },
  {
    role: "tool",
    tool_call_id: "c2",
    content: `export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}`,
  },
  { role: "user", content: "Now narrow it: collapse repeated dashes too." },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "c3", type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: "src/util/slugify.ts", search: ".replace(/[^a-z0-9]+/g, \"-\")", replace: ".replace(/[^a-z0-9]+/g, \"-\").replace(/-{2,}/g, \"-\")" }) } },
    ],
  },
  // baseline tool_result
  {
    role: "tool",
    tool_call_id: "c3",
    content: "Edit applied: src/util/slugify.ts (1 hunk).",
  },
  { role: "user", content: "Good, now also trim leading/trailing whitespace before the regex pass." },
];

// Variant B: same transcript, but the edit_file tool_result also carries a test_run footer.
// This is the EXACT extra payload the RFC would inject.
const augmentedToolResult = `Edit applied: src/util/slugify.ts (1 hunk).

[test_run] test_id="tests/slugify.test.ts::slugify collapses repeated dashes" status="pass" duration_ms=1873 command="npx vitest --run tests/slugify.test.ts -t \\"collapses repeated dashes\\""
[edit_claim] test_id="tests/slugify.test.ts::slugify collapses repeated dashes" edit_target="src/util/slugify.ts" satisfied=true`;

function variantA() {
  return JSON.parse(JSON.stringify(transcript));
}

function variantB() {
  const t = JSON.parse(JSON.stringify(transcript));
  // augment the edit_file tool result (index 8)
  t[8].content = augmentedToolResult;
  return t;
}

async function call(messages, tag) {
  const t0 = Date.now();
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      temperature: 0,
      max_tokens: 200,
      stream: false,
      // Thinking off so synthetic assistant messages don't need reasoning_content round-trip.
      // Cache mechanic is byte-prefix; thinking on/off doesn't change that.
      extra_body: { thinking: { type: "disabled" } },
    }),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const ms = Date.now() - t0;
  const u = data.usage;
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? 0;
  const ratio = hit + miss > 0 ? hit / (hit + miss) : 0;
  console.log(
    `  [${tag}] prompt=${u.prompt_tokens} hit=${hit} miss=${miss} ratio=${(ratio * 100).toFixed(1)}%  ${ms}ms`,
  );
  return { ms, usage: u, ratio };
}

async function runVariant(name, build) {
  console.log(`\n--- variant ${name} ---`);
  const warmupTail = { role: "user", content: "(warmup ping — just say 'ok')" };
  const realTail = { role: "user", content: "Show me the resulting file." };

  // 1. warmup — seed the cache
  const warm = await call([...build(), warmupTail], `${name}.warmup`);
  // 2. hot — same prefix, different tail
  const hot = await call([...build(), realTail], `${name}.hot`);
  // 3. hot-2 — repeat to confirm cache stickiness
  const hot2 = await call([...build(), realTail], `${name}.hot2`);

  return { warm, hot, hot2 };
}

console.log("Exp 1 — cache hit comparison");
const A = await runVariant("A_baseline", variantA);
const B = await runVariant("B_augmented", variantB);

const summary = {
  A_baseline: { warm: A.warm.ratio, hot: A.hot.ratio, hot2: A.hot2.ratio },
  B_augmented: { warm: B.warm.ratio, hot: B.hot.ratio, hot2: B.hot2.ratio },
  delta_hot: B.hot.ratio - A.hot.ratio,
  delta_hot2: B.hot2.ratio - A.hot2.ratio,
  pass_A_hot: A.hot.ratio >= 0.92,
  pass_B_hot: B.hot.ratio >= 0.92,
};

console.log("\n=== Summary ===");
console.log(JSON.stringify(summary, null, 2));

writeFileSync(
  new URL("./cost-results.json", import.meta.url),
  JSON.stringify({ summary, A, B }, null, 2),
);
