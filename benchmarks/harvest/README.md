# Harvest eval harness (Pillar 2)

Measures Pillar 2 (R1 Thought Harvesting) the same way `tau-bench/`
measures Pillar 1 (Cache-First Loop): isolate one variable, produce
numbers anyone can reproduce.

## What's different from τ-bench-lite?

Deliberately different task shape:

| | τ-bench-lite | harvest-bench |
|---|---|---|
| task style | multi-turn tool-use | single-turn reasoning |
| user simulator | yes (LLM) | no |
| DB state | yes | no |
| checker | DB-predicate | regex + set/value compare |
| target | Pillar 1 | Pillar 2 |
| model | deepseek-chat (default) | deepseek-reasoner (only R1 has `reasoning_content` for harvest to work on) |

The two harnesses answer different questions:

- **τ-bench-lite**: *"Does Cache-First actually cut cost on real tool-use
  workflows?"* (yes — 47.7pp cache, −39% cost on 48-run data.)
- **harvest-bench**: *"Does the extra V3 harvest call add measurable
  value above plain R1?"* (TBD — run it to find out.)

## Modes

Three modes isolate one variable each:

| mode | model | harvest | what it measures |
|---|---|---|---|
| `baseline` | deepseek-chat | off | floor reference — V3 at its best |
| `reasoner` | deepseek-reasoner | off | raw R1 gain over V3 on reasoning |
| `reasoner-harvest` | deepseek-reasoner | on | R1 + the extra V3 harvest call |

Deltas:

- `baseline → reasoner` answers "is R1 worth the price on these
  problems?"
- `reasoner → reasoner-harvest` answers "is the harvest call worth
  its incremental cost?"

## Quickstart

```bash
# Dry-run — no API, smoke-test the wiring
npx tsx benchmarks/harvest/runner.ts --dry

# Full run (live DeepSeek, costs ~$0.10-0.30 for 3 tasks × 3 modes × 1 repeat)
export DEEPSEEK_API_KEY=sk-...
npx tsx benchmarks/harvest/runner.ts

# Tighter run with 3 repeats (costs ~$0.30-1.00)
npx tsx benchmarks/harvest/runner.ts --repeats 3

# One task only (iterating on a checker)
npx tsx benchmarks/harvest/runner.ts --task mod7_list --mode reasoner-harvest

# Per-run transcripts so you can reasonix replay / diff them
npx tsx benchmarks/harvest/runner.ts --repeats 3 --transcripts-dir transcripts/

# Render report
npx tsx benchmarks/harvest/report.ts benchmarks/harvest/results-*.json
```

## Tasks (v0.3 seed)

| id | shape | why |
|---|---|---|
| `mod7_list` | number theory, 29-element list | R1 often tries enumeration first, then reaches for modular arithmetic — clean rejectedPaths signal |
| `flips_until_3heads` | probability, single integer | classic recurrence; R1 either derives or recalls, harvest should see hypotheses diverge |
| `three_hats` | logic puzzle, one-word answer | pure deduction chain, tests harvest's ability to extract the nested reasoning |

Adding a new task: see `tasks.ts`. Any checker that's deterministic is
fair game — extract numeric/list/text with regex, compare with set
equality or string matching.

## Non-goals

- **No LLM-as-judge.** Brittle and expensive; defeats the point of a
  reproducible bench. If a checker is too hard to write deterministically,
  the task doesn't belong here.
- **No tool-use tasks.** Those live in `tau-bench/`. Different story.
- **No multi-turn.** v0.3 harness is single-turn Q/A. Multi-turn reasoning
  eval is separate scope.
- **No benchmark-data cherry-picking.** When results come in, we publish
  them whether they validate Pillar 2 or not. "harvest didn't help on
  these 3 tasks" is still useful information.
