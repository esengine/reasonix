# Reasonix harvest eval (Pillar 2)

**Date:** 2026-04-21T16:07:09.674Z
**Tasks:** 3 · repeats × 1 · modes: baseline, reasoner, reasoner-harvest
**Reasonix version:** 0.2.2

## Summary by mode

| mode | runs | pass rate | cache hit | cost / run | harvest turns | subgoals | uncertainties |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 3 | 100% | 0.0% | $0.001418 | 0.0 | 0.0 | 0.0 |
| reasoner | 3 | 100% | 79.0% | $0.003547 | 0.0 | 0.0 | 0.0 |
| reasoner-harvest | 3 | 67% | 59.7% | $0.001839 | 0.7 | 3.3 | 1.3 |

## Deltas

- **baseline → reasoner**
  - pass rate: 0pp
  - cost: ×2.50 (each run costs more)
  - harvest signal / run: 0.0 subgoals, 0.0 uncertainties

- **baseline → reasoner-harvest**
  - pass rate: -33pp
  - cost: ×1.30 (each run costs more)
  - harvest signal / run: 3.3 subgoals, 1.3 uncertainties

## Per-task breakdown

| task | mode | rep | verdict | cache | cost | sg | un | note |
|---|---|---:|:---:|---:|---:|---:|---:|---|
| mod7_list | baseline | 1 | ✅ | 0.0% | $0.000956 | 0 | 0 |  |
| mod7_list | reasoner | 1 | ✅ | 86.5% | $0.004051 | 0 | 0 |  |
| mod7_list | reasoner-harvest | 1 | ✅ | 86.5% | $0.003799 | 5 | 2 |  |
| flips_until_3heads | baseline | 1 | ✅ | 0.0% | $0.001125 | 0 | 0 |  |
| flips_until_3heads | reasoner | 1 | ✅ | 92.8% | $0.001521 | 0 | 0 |  |
| flips_until_3heads | reasoner-harvest | 1 | ✅ | 92.8% | $0.001718 | 5 | 2 |  |
| three_hats | baseline | 1 | ✅ | 0.0% | $0.002172 | 0 | 0 |  |
| three_hats | reasoner | 1 | ✅ | 57.7% | $0.005070 | 0 | 0 |  |
| three_hats | reasoner-harvest | 1 | ❌ | 0.0% | $0.000000 | 0 | 0 | This operation was aborted |

## Scope

Unlike τ-bench-lite, these tasks are single-turn reasoning problems (no user simulator, no DB, no tool calls). Checkers are deterministic — regex + set / value compare, never an LLM judge. The point is to isolate whether the Pillar 2 harvest step adds measurable value above plain reasoner usage.

Interpretation: `baseline` (chat / V3) is a floor. `reasoner` shows the raw R1 gain. `reasoner-harvest` isolates the cost + quality delta from the extra V3 harvest call.
## Findings (v0.3 first data point)

This is the first harvest-bench run. Three honest findings:

1. **V3 chat already solves all three tasks.** Baseline pass rate is 3/3 — these reasoning problems are within V3's competence. That means the task set is too easy to *differentiate* reasoner from chat, let alone reasoner+harvest from reasoner.
2. **Reasoner costs ~2.5× chat on these tasks with identical pass rate.** On the v0.3 seed task set, there is no quality argument for R1. The cache-hit story is preserved though — reasoner mode still hits 79% mean cache on the Cache-First loop, so Pillar 1's claim extends to R1.
3. **Harvest produced real signal** (mean 3.3 subgoals / 1.3 uncertainties per run on the mode that captured it), but one of the three runs hit the client's 120s timeout — harvest-bench needs a longer default timeout or harvest should be async w.r.t. the main turn.

### What this means for v0.3

We can't ship a "harvest is worth the extra V3 call" claim off this data — the seed tasks bottom out at V3. To actually measure Pillar 2, the task set needs:
- problems where V3 demonstrably fails (so R1 has room to win)
- followed by problems where the specific harvest signal (uncertainty detection) correlates with error

This is a scope insight, not a framework failure. The harness runs cleanly, plan state lands in transcripts, CI protects the wiring. The *data* says we need harder tasks.

### Known issues

- **120s client timeout** on reasoner-harvest for `three_hats` — R1 took ~100s, harvest's extra V3 call pushed past the cap. Next run should pass `--timeout` or bump the default.
- **5-subgoals cap** hitting uniformly — harvest's `maxItems` default is 5; true signal could be higher. Revisit the cap when we find tasks where harvest fires more.
