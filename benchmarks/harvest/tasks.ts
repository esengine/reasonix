/** Seed reasoning tasks for harvest-bench — single-turn Q/A with deterministic checkers. */

import type { HarvestTask } from "./types.js";

const CONCISE_SYSTEM = `You are a precise reasoner. Think carefully, then state your final answer on a clearly-labeled line starting with "Answer:".`;

/** Parse non-negative integers; expands "2-4" → 2,3,4; strips LaTeX decorations first. */
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

/** Positive n ≤ 100 such that n^2 + n + 1 ≡ 0 (mod 7). */
const MOD7_EXPECTED: number[] = (() => {
  const out: number[] = [];
  for (let n = 1; n <= 100; n++) {
    if ((n * n + n + 1) % 7 === 0) out.push(n);
  }
  return out;
})();

/** Single-integer checker — first plausible int from the last "Answer:" line, exact equality. */
function checkSingleInt(expected: number) {
  return (reply: string) => {
    const answerLine = extractAnswerLine(reply);
    const nums = extractIntegers(answerLine);
    if (nums.length === 0) return { verdict: "fail" as const, note: "no number in Answer line" };
    const n = nums[0]!;
    if (n === expected) return { verdict: "pass" as const };
    return { verdict: "fail" as const, note: `got ${n}, expected ${expected}` };
  };
}

export const TASKS: HarvestTask[] = [
  {
    id: "mod7_list",
    description:
      "Number theory — find all positive n ≤ 100 with n^2+n+1 ≡ 0 (mod 7). 29-element set. Classic R1 scratch-work territory.",
    systemPrompt: CONCISE_SYSTEM,
    prompt:
      'Find all positive integers n with n ≤ 100 such that n^2 + n + 1 is divisible by 7. Briefly justify, then end with the full list on a line starting with "Answer:".',
    check: (reply) => {
      const answerLine = extractAnswerLine(reply);
      const found = new Set(extractIntegers(answerLine).filter((n) => n >= 1 && n <= 100));
      const expected = new Set(MOD7_EXPECTED);
      if (found.size === 0) {
        return { verdict: "fail", note: "no integers extracted from Answer line" };
      }
      // Exact set equality — both containment directions.
      for (const n of expected)
        if (!found.has(n)) return { verdict: "fail", note: `missing n=${n}` };
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
      'A fair coin is flipped repeatedly until you see 3 heads in a row. What is the expected number of total flips? Give a single integer on a line starting with "Answer:".',
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

  {
    id: "pseudoprime_base2",
    description:
      "Number theory — smallest composite n > 1 such that 2^n ≡ 2 (mod n). This is the smallest Fermat pseudoprime to base 2. Answer: 341 (= 11·31). V3 frequently answers 561 (Carmichael / wrong base-2 property) or 9 (not actually a pseudoprime to base 2, verifying the model isn't computing). R1 usually gets this right.",
    systemPrompt: CONCISE_SYSTEM,
    prompt:
      'Find the smallest composite integer n > 1 such that 2^n is congruent to 2 modulo n (i.e., n is a Fermat pseudoprime to base 2). Briefly justify, then give a single integer on a line starting with "Answer:".',
    check: checkSingleInt(341),
  },

  {
    id: "derangements_d7",
    description:
      "Combinatorics — number of derangements of 7 elements. Answer: 1854 (D_7 = 7! · (1 − 1/1! + 1/2! − 1/3! + … ± 1/7!) = 5040 · 0.367857… = 1854). V3 sometimes approximates via n!/e and rounds wrong, or confuses with D_6=265 or D_8=14833. R1's explicit recurrence D_n = (n-1)(D_{n-1}+D_{n-2}) avoids the mistake.",
    systemPrompt: CONCISE_SYSTEM,
    prompt:
      'How many permutations of {1, 2, 3, 4, 5, 6, 7} have no fixed points? (This is D_7, the derangement number.) Briefly justify, then give a single integer on a line starting with "Answer:".',
    check: checkSingleInt(1854),
  },

  {
    id: "euler_quadratic_break",
    description:
      "Number theory — smallest nonneg integer n where n^2 + n + 41 is NOT prime. Euler's prime-generating polynomial famously produces primes for n = 0..39 and first fails at n = 40 (40²+40+41 = 1681 = 41²). V3 often confuses this with the related n²-n+41 (first fails at 41) or cites the wrong threshold. R1 checks small n systematically.",
    systemPrompt: CONCISE_SYSTEM,
    prompt:
      'Consider the polynomial f(n) = n^2 + n + 41 for n = 0, 1, 2, …. What is the smallest nonneg integer n at which f(n) fails to be prime? Briefly justify (including the value of f(n) at that point), then give just the integer n on a line starting with "Answer:".',
    check: checkSingleInt(40),
  },
];
