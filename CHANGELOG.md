# Changelog

All notable changes to Reasonix. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] — 2026-04-21

**Headline:** 48-run bench data (3 repeats × 8 tasks × 2 modes). Reasonix
now scores **100% pass rate (24/24)** against 96% baseline; cache-hit
delta holds at **+47.7pp** with variance well under the last single-run
numbers.

### Fixed

- **t05 predicate relaxed** (`benchmarks/tau-bench/tasks.ts`). The task
  required "no refund on a processing order" and formerly also required
  status to stay `processing`, penalizing an agent who offered
  cancellation as a helpful alternative. The new predicate passes iff
  no refund row is written AND the order ends in `{processing, cancelled}`
  — either refusal or helpful substitution counts. Cancellation was
  marking reasonix as fail on its single run in v0.1; with this fix
  reasonix now passes every refusal task in every repeat.

### Changed

- **README headline numbers updated** to the 48-run set. Baseline shows
  one failure out of 24 (a `t07_wrong_identity` run where baseline
  skipped identity verification); Reasonix held the guardrail on every
  run.
- **`benchmarks/tau-bench/report.md`** regenerated from the 48-run
  results. Cost estimate vs Claude Sonnet 4.6 stays at ~96% cheaper
  per task.
- **`benchmarks/tau-bench/results.json`** replaced with the 48-run data.

### Tests

- +3 tests pinning the three t05 outcomes (refuse / cancel / illegally
  refund). Suite: **172 passing** (was 169).

---

## [0.2.1] — 2026-04-21

**Headline:** v0.2 grows eyes. `reasonix replay` and `reasonix diff` now
open interactive Ink TUIs by default. The stdout paths still work when
piped, so CI / `less` / markdown-export workflows aren't disturbed.

### Added

- **Interactive `reasonix replay <transcript>`** — Ink TUI with
  per-turn navigation (`j`/`k`/space/arrows, `g`/`G` for jump-to-edge,
  `q` to quit). Sidebar re-renders cumulative cost / cache / prefix
  stability as the cursor moves, so "how did the cache hit rate climb
  over the conversation?" is answered visually instead of in
  aggregate.
- **Interactive `reasonix diff <a> <b>`** — split-pane Ink TUI. Both
  sides scroll together; `n` / `N` jump the cursor to the next / prev
  divergent turn (the whole point of a diff tool). Cursor defaults to
  the first divergence so you skip the "identical setup turns".
- **Shared `RecordView` component** (`src/cli/ui/RecordView.tsx`)
  used by both TUIs — consistent visual grammar (user cyan, assistant
  green with cache badge, tool yellow, error red). Replaces the
  inline renderer in `ReplayApp`.
- **Pure navigation helpers** in `src/diff.ts`:
  `findNextDivergence(pairs, fromIdx)` and
  `findPrevDivergence(pairs, fromIdx)`. Unit-testable without Ink.
  Both guard against out-of-bounds `fromIdx`.
- **Pure replay nav helpers** in `src/replay.ts`:
  `groupRecordsByTurn(records)` and `computeCumulativeStats(pages, upToIdx)`.
  Used by the TUI sidebar; also individually testable.
- **New CLI flags** on both commands:
  - `reasonix replay --print` — force stdout pretty-print (auto when
    stdout isn't a TTY, or when `--head` / `--tail` is passed).
  - `reasonix diff --print` — force stdout table.
  - `reasonix diff --tui` — force Ink TUI even when piped (rare
    escape hatch).

### Changed

- **`reasonix replay` default** is now the TUI. Old stdout behavior
  reachable via `--print` or by piping. Non-TTY detection
  automatically flips to stdout mode, so shell pipelines behave as
  they did in 0.2.0.
- **`reasonix diff` default** picks itself from context:
  - `--md <path>` → write markdown + print summary (unchanged).
  - `--print` or piped stdout → stdout summary table.
  - TTY, no `--md`, no `--print` → TUI.

### Tests

- +10 new tests (`replay.test.ts` +6: `groupRecordsByTurn` +
  `computeCumulativeStats`; `diff.test.ts` +4: divergence navigation).
  Suite: **169 passing** (was 159).

---

## [0.2.0] — 2026-04-21

**Headline:** v0.2 makes the v0.1 cache-hit claim *auditable*. Any reader
can now verify the 94.3% / −42% numbers from committed JSONL transcripts
— no API key required.

### Added

- **`reasonix replay <transcript>`** — pretty-print a past transcript and
  rebuild its full session summary (turns, tool calls, cache hit, cost,
  prefix stability) offline. No API calls.
- **`reasonix diff <a> <b>`** — compare two transcripts: aggregate deltas,
  first divergence (with Levenshtein similarity for text + exact match
  for tool-name / args), prefix-stability story. Optional `--md <path>`
  writes a blog-ready markdown report.
- **`benchmarks/tau-bench/transcripts/`** — committed reference transcripts
  (baseline + reasonix on `t01_address_happy`) so anyone can clone the
  repo and run `reasonix replay` / `diff` immediately, without running
  the bench.
- **Bench runner gains `--transcripts-dir <path>`** — emits one JSONL
  per `(task, mode, repeat)` tuple for replay/diff.
- New library exports: `computeReplayStats`, `replayFromFile`,
  `diffTranscripts`, `renderDiffSummary`, `renderDiffMarkdown`,
  `parseTranscript`, `recordFromLoopEvent`, `writeRecord`.

### Changed

- **Transcript format bumped (backward-compatible)**. Records now carry
  `usage`, `cost`, `model`, `prefixHash` (reasonix only), and `toolArgs`.
  All fields optional on read — v0.1 transcripts still parse (cost/cache
  shown as n/a). A `_meta` line at the top records source/model/task
  metadata.
- **Baseline bench runner now emits per-sub-call transcripts**. Previously
  wrote one aggregated record per user turn, which made diff's
  apples-to-apples "model calls" count off. Now both modes emit at the
  same granularity.
- **Diff rendering label change**: "turns (assistant)" → "model calls",
  with "user turns" as a separate row in the summary table. Removes the
  ambiguity that hit when comparing baseline vs reasonix.
- **Top-level README**: `validated numbers` table now shows the 16-run
  τ-bench-lite results (94.3% cache, −42% cost) and links to the
  committed reference transcripts.
- **Exposed `LoopEvent.toolArgs`** so transcript writers can persist
  *what* the model sent to each tool, not just the result.

### Fixed

- Windows-only entrypoint bug in the bench runner
  (`import.meta.url === file://${argv[1]}`) — replaced with
  `pathToFileURL(argv[1]).href` so `main()` actually runs on Windows.

### Tests

- 17 new tests across `transcript.test.ts` (3), `replay.test.ts` (3),
  and `diff.test.ts` (11). Total suite: 159 passing.

---

## [0.1.0] — 2026-04-21

**Headline:** first reproducible evidence for Pillar 1 (Cache-First Loop).

### Added

- **`benchmarks/tau-bench/`** — τ-bench-lite harness. 8 retail-flavored
  multi-turn tool-use tasks with a DeepSeek V3 user simulator,
  deterministic DB-end-state success predicates (no LLM judge), and a
  cache-hostile naive baseline runner. Schema mirrors Sierra's τ-bench
  so upstream tasks can drop in.
- **`benchmarks/tau-bench/runner.ts`** — orchestrator with
  `--task` / `--mode` / `--repeats` / `--dry` / `--verbose` flags.
- **`benchmarks/tau-bench/report.ts`** — renders results JSON into a
  blog-ready markdown summary with explicit scope caveats.
- **Live bench numbers** published in `benchmarks/tau-bench/report.md`:
  - cache hit: baseline 43.9% → reasonix **94.3%** (+50.3pp)
  - cost/task: baseline $0.00278 → reasonix **$0.00162** (−42%)
  - vs Claude Sonnet 4.6 (token-count estimate): **~96% cheaper**
  - pass rate: 100% (baseline) vs 88% (reasonix; 1 predicate too strict,
    documented)

### Tests

- 8 new tests in `tests/benchmarks.test.ts` covering DB isolation,
  check-predicate satisfiability, and tool guards — all runnable without
  an API key. Total suite at this release: 143 passing.

---

Earlier `0.0.x` versions covered Pillar 1 + Pillar 3 internals, retry
layer, first-run API key prompt, harvest MVP, self-consistency
branching, and session persistence. They're not reflected as individual
entries above because the `0.1.0` bench harness is what first produced
*externally verifiable* evidence for their value.

[0.2.2]: https://github.com/esengine/reasonix/releases/tag/v0.2.2
[0.2.1]: https://github.com/esengine/reasonix/releases/tag/v0.2.1
[0.2.0]: https://github.com/esengine/reasonix/releases/tag/v0.2.0
[0.1.0]: https://github.com/esengine/reasonix/releases/tag/v0.1.0
