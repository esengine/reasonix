# Exp 4 — `vitest -t` latency on this repo

**Result: PASS.** Median 1.9s, p95 ~5.0s, max 5.1s. Both pass thresholds met (median ≤3s, p95 ≤6s).

## Method

`benchmarks/spike-tdd-kernel/bench-latency.mjs` runs `npx vitest --run <file> -t "<name>"` against 10 sampled test/name pairs across 9 different test files, twice each (cold = first invocation, warm = immediate repeat). Each invocation is a fresh `npx` subprocess. Wall-clock measured around `spawnSync`. Raw data in `latency.json`.

## Numbers

| | median | p95 | max |
|---|---|---|---|
| cold | 1900 ms | 4731 ms | 4815 ms |
| warm | 1888 ms | 4972 ms | 5075 ms |

All 20 invocations exited 0.

## Findings

1. **Cold ≈ warm.** Each `npx vitest --run` boots a fresh worker, so there is no meaningful warm-up benefit. The ~1.9s floor is overwhelmingly framework startup (vite + vitest + tsx transform), not test work. The two slowest tests (`edit-blocks`, `bang`) hit ~5s on both cold and warm, indicating per-test overhead specifically — likely module graph size, not test logic.

2. **Implication for kernel design.** Running N separate `vitest --run -t <id_n>` is N × ~2s. **Batching multiple `test_id`s in one invocation** (`vitest --run -t a -t b -t c`) almost certainly amortises the boot cost. RFC's "auto-run after each edit" should bundle test_ids when an edit pass writes more than one — and a bulk-edit batch should only fire one vitest invocation at the end.

3. **Threshold headroom is thin on slow tests.** A test that already takes 5s warm leaves ~1s for kernel overhead before the user starts noticing. Per-edit auto-run is fine; per-keystroke would not be.

## Decision

Greenlight the latency assumption in the RFC. Update RFC §"Cost analysis" to reflect:
- "+1 test run per edit" → "+1 vitest invocation per edit batch"
- Add note that the kernel should coalesce edits within one model turn into a single `vitest -t a -t b …` call.

## Sample tests used

- `checkpoints.test.ts` (×2)
- `compact-tokens.test.ts` (×2)
- `diff.test.ts`, `edit-blocks.test.ts`, `event-replay.test.ts`, `event-sink-jsonl.test.ts`, `at-mentions.test.ts`, `bang.test.ts`
