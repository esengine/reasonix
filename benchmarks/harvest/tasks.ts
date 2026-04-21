/**
 * Seed reasoning tasks for the harvest eval harness.
 *
 * Each task has:
 *   - a minimal system prompt (so the comparison is about the model, not
 *     the prompt)
 *   - a single user question
 *   - a deterministic checker (regex + set/value compare)
 *
 * When adding a new task, prefer problems where:
 *   - the answer has a clean shape (a number, a small set, a yes/no +
 *     explanation) — easier to check
 *   - reasoning actually matters (so harvest has signal to extract);
 *     trivia questions are out of scope
 *   - there's a known-good answer; judgment calls are out of scope
 */

import type { HarvestTask } from "./types.js";

const CONCISE_SYSTEM = `You are a precise reasoner. Think carefully, then state your final answer on a clearly-labeled line starting with "Answer:".`;

/**
 * Parse all non-negative integers out of a string. Handles commas,
 * ranges written as "2-4" (expands to 2,3,4), and ignores numbers that
 * look like formula references (e.g. "n^2", "mod 7") by only accepting
 * integers after we strip common LaTeX decorations.
 */
function extractIntegers(text: string): number[] {
  // Strip LaTeX delimiters so n_1 / n^2 / \{ ... \} don't confuse us.
  const cleaned = text
    .replace(/\\[a-zA-Z]+/g, " ") // \frac, \mod etc.
    .replace(/[{}\\]/g, " ")
    .replace(/[_^]\d+/g, " "); // subscript/superscript numbers
  // Expand ranges: "2-4" → "2,3,4" (only for small gaps)
  const rangeExpanded = cleaned.replace(/(\d+)\s*[-–]\s*(\d+)/g, (_, a, b) => {
    const lo = Number.parseInt(a, 10);
    const hi = Number.parseInt(b, 10);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo > 50) return `${a} ${b}`;
    const out: number[] = [];
    for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) out.push(i);
    return out.join(" ");
  });
  const matches = rangeExpanded.match(/-?\d+/g) ?? [];
  return matches.map((m) => Number.parseInt(m, 10)).filter((n) => Number.isFinite(n));
}

/** Extract content after the last "Answer:" label (case-insensitive). */
function extractAnswerLine(text: string): string {
  const matches = [...text.matchAll(/answer\s*[:：]\s*([^\n]+)/gi)];
  if (matches.length === 0) return text;
  return matches[matches.length - 1]![1]!.trim();
}

// ---------- expected answers ----------

/** Positive n ≤ 100 such that n^2 + n + 1 ≡ 0 (mod 7). */
const MOD7_EXPECTED: number[] = (() => {
  const out: number[] = [];
  for (let n = 1; n <= 100; n++) {
    if ((n * n + n + 1) % 7 === 0) out.push(n);
  }
  return out;
})();

// ---------- tasks ----------

export const TASKS: HarvestTask[] = [
  {
    id: "mod7_list",
    description:
      "Number theory — find all positive n ≤ 100 with n^2+n+1 ≡ 0 (mod 7). 29-element set. Classic R1 scratch-work territory.",
    systemPrompt: CONCISE_SYSTEM,
    prompt:
      "Find all positive integers n with n ≤ 100 such that n^2 + n + 1 is divisible by 7. Briefly justify, then end with the full list on a line starting with \"Answer:\".",
    check: (reply) => {
      const answerLine = extractAnswerLine(reply);
      const found = new Set(extractIntegers(answerLine).filter((n) => n >= 1 && n <= 100));
      const expected = new Set(MOD7_EXPECTED);
      if (found.size === 0) {
        return { verdict: "fail", note: "no integers extracted from Answer line" };
      }
      // Exact set equality — both containment directions.
      for (const n of expected) if (!found.has(n)) return { verdict: "fail", note: `missing n=${n}` };
      for (const n of found) if (!expected.has(n)) return { verdict: "fail", note: `extra n=${n}` };
      return { verdict: "pass" };
    },
  },

  {
    id: "flips_until_3heads",
    description:
      "Probability — expected coin flips until 3 consecutive heads. Answer: 14. Tests whether R1 derives via recurrence or via memorized result.",
    systemPrompt: CONCISE_SYSTEM,
    prompt:
      "A fair coin is flipped repeatedly until you see 3 heads in a row. What is the expected number of total flips? Give a single integer on a line starting with \"Answer:\".",
    check: (reply) => {
      const answerLine = extractAnswerLine(reply);
      const nums = extractIntegers(answerLine);
      if (nums.length === 0) return { verdict: "fail", note: "no number in Answer line" };
      // Accept the first sensible number — sometimes agents write "Answer: 14 flips".
      const n = nums[0]!;
      if (n === 14) return { verdict: "pass" };
      return { verdict: "fail", note: `got ${n}, expected 14` };
    },
  },

  {
    id: "three_hats",
    description:
      "Logic — three people wear red/blue hats, at least one red, they're asked in order. First two say no, third says yes. What color? Answer: red (deducible because if third were blue, the first two could see one red + one unknown and wouldn't have said no on their full first round, for most configurations the third can only be certain if red).",
    systemPrompt: CONCISE_SYSTEM,
    prompt:
      'Three people wear hats that are each red or blue. They are told at least one hat is red. Each can see the other two hats but not their own. They are asked in order: "Do you know your hat color?" The first two answer no. The third answers yes. What color is the third person\'s hat? Give a one-word answer on a line starting with "Answer:".',
    check: (reply) => {
      const answerLine = extractAnswerLine(reply).toLowerCase();
      // Accept "red" as a standalone word (not "redirected" etc).
      if (/\bred\b/.test(answerLine) && !/\bblue\b/.test(answerLine)) {
        return { verdict: "pass" };
      }
      if (/\bblue\b/.test(answerLine)) return { verdict: "fail", note: "answered blue" };
      return { verdict: "fail", note: "no clear color in Answer line" };
    },
  },
];
