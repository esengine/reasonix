# Exp 3 — DeepSeek V4 TDD reliability

**Result: PASS.** 8/10 strict, 10/10 once an over-strict scoring bug is corrected. Both thresholds (≥70% strict, ≥50% before redesign) cleared comfortably.

## Method

`benchmarks/spike-tdd-kernel/tdd-eval.mjs` runs 10 prompts across 5 easy / 3 medium / 2 hard difficulty levels against `deepseek-v4-flash` at temperature 0. The system message demands a single failing vitest file with no implementation. Each response is scored on:

- **shape**: contains `describe`, `it`/`test`, and at least one `import`
- **importsTarget**: imports the module-under-test by some path
- **implLeak**: whether the test file defines the function-under-test (regression — the model was supposed to write only the test)
- **stableNames**: every `it()`/`test()` title is a literal string with no template / `Date.now()` / `Math.random()`
- **tsOk**: passes `tsc --noEmit` after replacing the target import with `vitest` (purely a syntax check)

Pass-all requires all five.

Raw runs in `tdd-eval.json` (~5 KB).

## Numbers

```
e1 (easy)   shape=Y import=N* leak=N names=Y ts=Y → fail*
e2 (easy)   shape=Y import=Y  leak=N names=Y ts=Y → PASS
e3 (easy)   shape=Y import=Y  leak=N names=Y ts=Y → PASS
e4 (easy)   shape=Y import=Y  leak=N names=Y ts=Y → PASS
e5 (easy)   shape=Y import=Y  leak=N names=Y ts=Y → PASS
m1 (medium) shape=Y import=Y  leak=N names=Y ts=Y → PASS
m2 (medium) shape=Y import=Y  leak=N names=Y ts=Y → PASS
m3 (medium) shape=Y import=Y  leak=N names=Y ts=Y → PASS
h1 (hard)   shape=Y import=N* leak=N names=Y ts=Y → fail*
h2 (hard)   shape=Y import=Y  leak=N names=Y ts=Y → PASS

8/10 = 80% strict
10/10 = 100% once import-path scoring is corrected (see below)
tokens: 2246 prompt + 5732 completion (≈ $0.001 total)
```

## The two "failures" are scoring bugs

The strict regex required imports of the form `from ".../src/util/slugify"`. The two failing prompts produced these imports:

```
e1: import { slugify } from '../slugify';                      // assumes test is co-located
h1: import { extractTestId } from './src/repair/test-id';      // assumes test is project-root-relative
```

Both **import the correct symbol from a path that points at the right module**. They differ only in *where the test file is assumed to live*, which is a question the prompt didn't answer. In the real flow, the model also picks the test file location, so the import is self-consistent. These should count as PASS.

## What the model got right consistently

- 10/10 imported `vitest` correctly.
- 10/10 wrote one `describe` + multiple `it` blocks, no nested test stubs.
- 10/10 had stable, literal `it()` names — no parametrise leaks, no clocks, no RNG.
- 10/10 did NOT define the target function in the test file (no impl leak).
- 10/10 passed `tsc --noEmit` syntax check.
- Median latency 8.2s, p95 14s. Slower than expected for `v4-flash`, but acceptable given output size (~500 tokens / response).

## What the model got "wrong"

- Underspec: when given no test file location, it guesses one. Reasonable behavior, but the kernel will need to specify (or accept the model's choice and write the file there).
- Hard prompts (h1, h2) took 11–14s vs. easy ~5s. Acceptable.

## Implications for the RFC

1. **Greenfield flow is viable.** The model can reliably author a failing test first when explicitly told to. Open question §1 in RFC #25 can be closed: a structured `author_failing_test` tool is **not** required — a clear system message suffices.

2. **The kernel should specify (or extract) the target test file path.** When `submit_plan` includes a step with `test_id`, it should also include `test_file_path`. The dispatcher uses that to:
   - know where to write the failing test
   - resolve the relative import path the model emits
   - compute the eventual `<rel-path>::<fullName>` id

3. **Strip-and-validate the model output.** Even though shape passed 10/10, the kernel should still:
   - strip markdown fences (the model occasionally wraps in `\`\`\`ts ... \`\`\`` — none of the 10 did, but be defensive)
   - reject any file that defines the target symbol (impl leak) before running it
   - require the test fail with `Error: Cannot find module …` or a real assertion failure (not a SyntaxError)

4. **Latency.** ~8s median per failing-test authoring. For a per-feature TDD step, that's fine. Combined with Exp 4's ~2s vitest run, the red event lands ≤12s after the user kicks off a feature — acceptable UX.

## Decision

Greenlight Exp 3. Combined with Exp 2 + Exp 4, the proposal's three feasibility risks are resolved. **Move to Exp 1.**
