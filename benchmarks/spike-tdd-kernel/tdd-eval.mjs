// Exp 3 — does DeepSeek V4 reliably write a failing test FIRST?
// Loads .env, runs N prompts asking for a vitest-style failing test only.
// Scores each response on 4 axes and writes tdd-eval.json + tdd-eval.md.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Load .env manually (no dotenv dep in this repo).
for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

// Build DeepSeek client by importing the compiled dist (avoids tsx dep).
// If dist is stale, fall back to direct fetch — same wire format.
const apiKey = process.env.DEEPSEEK_API_KEY;
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY missing from .env");
  process.exit(1);
}

const SYSTEM = `You are writing a SINGLE failing vitest test. Strict rules:

1. Output ONLY a TypeScript test file — no prose, no markdown fences, no implementation.
2. The test MUST fail right now (the module / function it tests does not exist yet, or has the wrong behavior).
3. Use exactly one top-level \`describe\` and one or more \`it()\` blocks. Do NOT include any function definitions other than the test bodies.
4. Import the module-under-test using its expected final import path. The import will fail to resolve — that is correct, that is the red.
5. Do NOT define stubs or fakes of the function-under-test inline. The test must reference the real (unimported / unimplemented) symbol.
6. End with no trailing markdown.`;

const PROMPTS = [
  // easy (5)
  { id: "e1", level: "easy", task: "A pure function \`slugify(s: string): string\` in src/util/slugify.ts that lowercases, replaces non-alphanumerics with '-', and collapses repeated dashes." },
  { id: "e2", level: "easy", task: "A pure function \`clamp(n: number, lo: number, hi: number): number\` in src/util/clamp.ts that clamps n into [lo, hi]." },
  { id: "e3", level: "easy", task: "A pure function \`hexToRgb(hex: string): {r:number,g:number,b:number} | null\` in src/util/color.ts. Accepts '#abc', '#aabbcc', and 'aabbcc'. Returns null on invalid." },
  { id: "e4", level: "easy", task: "A pure function \`uniqueBy<T,K>(arr: T[], key: (t: T) => K): T[]\` in src/util/uniq.ts preserving first occurrence." },
  { id: "e5", level: "easy", task: "A pure function \`parseDuration(s: string): number\` in src/util/duration.ts. '1500ms' → 1500, '2s' → 2000, '1m' → 60000. Returns NaN on invalid." },

  // medium (3)
  { id: "m1", level: "medium", task: "A class \`RingBuffer<T>\` in src/util/ring.ts with capacity, push(x) (drops oldest when full), toArray() returning oldest-first, and size getter." },
  { id: "m2", level: "medium", task: "A function \`mergeRanges(ranges: Array<[number,number]>): Array<[number,number]>\` in src/util/ranges.ts. Coalesces overlapping/adjacent ranges, returns sorted." },
  { id: "m3", level: "medium", task: "A function \`debounceAsync<T extends any[], R>(fn: (...args: T) => Promise<R>, ms: number): (...args: T) => Promise<R>\` in src/util/debounce.ts. Resolves only the latest call's promise; earlier callers reject with an AbortError-like." },

  // hard (2) — these touch domain types from the repo
  { id: "h1", level: "hard", task: "A function \`extractTestId(file: string, fullName: string, source: string): { id: string, source: 'native' | 'annotation' }\` in src/repair/test-id.ts. If \`source\` contains a '// @reasonix-test-id: <slug>' comment within 3 lines above an it()/test() whose name matches \`fullName\`, return that slug with source='annotation'. Otherwise return \`\${file}::\${fullName}\` with source='native'." },
  { id: "h2", level: "hard", task: "A function \`pairRedGreen(events: Array<{type:string, test_id?:string, status?:string, ts:number}>): Array<{ test_id: string, red_ts: number, green_ts: number }>\` in src/events/pair.ts. For each test_id, find the most recent fail→pass transition and return one entry per test_id. Ignore test_ids that never went green." },
];

async function callModel(prompt) {
  const body = {
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt.task },
    ],
    temperature: 0.0,
    max_tokens: 1500,
    stream: false,
  };
  const t0 = Date.now();
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API ${resp.status}: ${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  const ms = Date.now() - t0;
  const content = data.choices?.[0]?.message?.content ?? "";
  return { content, ms, usage: data.usage };
}

function stripFences(s) {
  return s
    .replace(/^```(?:ts|typescript|tsx|javascript|js)?\s*\n/m, "")
    .replace(/\n```\s*$/m, "")
    .trim();
}

function score(prompt, raw) {
  const code = stripFences(raw);

  // (a) structurally a test file
  const hasDescribe = /\bdescribe\s*\(/.test(code);
  const hasIt = /\b(?:it|test)\s*\(/.test(code);
  const hasImport = /^\s*import\s/m.test(code);
  const compiles_shape = hasDescribe && hasIt && hasImport;

  // (b) does it actually import the target module-under-test?
  const targetMatch = prompt.task.match(/in (src\/[^\s.]+\.ts)/);
  const target = targetMatch ? targetMatch[1].replace(/\.ts$/, "") : null;
  const importsTarget = target
    ? new RegExp(
        `from\\s+["'](?:\\.\\.\\/(?:\\.\\.\\/)?)?(?:src\\/)?${target.replace("src/", "").replace(/\//g, "\\/")}`,
      ).test(code)
    : false;

  // (c) impl leak — does the file define a function/class with the target's name?
  const symbolMatch = prompt.task.match(/(?:function |class )?\\?`(\w+)/);
  const symbol = symbolMatch ? symbolMatch[1] : null;
  const implLeak =
    symbol &&
    new RegExp(
      `(?:^|\\n)(?:export\\s+)?(?:function|class|const)\\s+${symbol}\\b\\s*[(=<{]`,
    ).test(code);

  // (d) at least one stable it() name (no template literals, no Date.now(), no RNG)
  const itNames = [...code.matchAll(/\b(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g)].map(
    (m) => m[1],
  );
  const stableNames = itNames.length > 0 && itNames.every((n) => !/\$\{|\bDate\.|Math\./.test(n));

  // run typescript syntax-check via tsc on a temp file
  let tsOk = false;
  let tsErr = "";
  try {
    const dir = mkdtempSync(join(tmpdir(), "tdd-eval-"));
    const f = join(dir, "candidate.test.ts");
    // Replace the import path so tsc doesn't try to resolve it (we just want syntax + types of literals)
    const stubbed = code.replace(/from\s+["'][^"']+["']/g, 'from "vitest"');
    writeFileSync(f, stubbed);
    const r = spawnSync(
      "npx",
      ["tsc", "--noEmit", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", "--strict", "false", f],
      { encoding: "utf8", shell: true },
    );
    tsOk = r.status === 0 || /Cannot find module 'vitest'/i.test(r.stdout + r.stderr); // tolerate vitest miss
    if (!tsOk) tsErr = (r.stdout + r.stderr).slice(0, 300);
  } catch (e) {
    tsErr = String(e).slice(0, 300);
  }

  const passAll =
    compiles_shape && (importsTarget || target == null) && !implLeak && stableNames && tsOk;

  return {
    compiles_shape,
    importsTarget,
    implLeak: !!implLeak,
    stableNames,
    tsOk,
    tsErr,
    passAll,
    target,
    symbol,
    itNames,
    code,
  };
}

console.log(`Running ${PROMPTS.length} prompts on deepseek-v4-flash …\n`);
const out = [];
let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
for (const p of PROMPTS) {
  process.stdout.write(`  ${p.id} (${p.level}) … `);
  try {
    const { content, ms, usage } = await callModel(p);
    if (usage) {
      totalUsage.prompt_tokens += usage.prompt_tokens ?? 0;
      totalUsage.completion_tokens += usage.completion_tokens ?? 0;
    }
    const s = score(p, content);
    out.push({ ...p, ms, usage, score: s });
    console.log(
      `${ms}ms  shape=${s.compiles_shape ? "Y" : "N"} import=${s.importsTarget ? "Y" : "N"} leak=${s.implLeak ? "Y" : "N"} names=${s.stableNames ? "Y" : "N"} ts=${s.tsOk ? "Y" : "N"} → ${s.passAll ? "PASS" : "fail"}`,
    );
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    out.push({ ...p, error: e.message });
  }
}

const passed = out.filter((r) => r.score?.passAll).length;
const total = out.length;
console.log(`\n=== ${passed}/${total} pass-all (${((passed / total) * 100).toFixed(0)}%) ===`);
console.log(`tokens: ${totalUsage.prompt_tokens} prompt + ${totalUsage.completion_tokens} completion`);

writeFileSync(
  new URL("./tdd-eval.json", import.meta.url),
  JSON.stringify({ passed, total, totalUsage, runs: out }, null, 2),
);
