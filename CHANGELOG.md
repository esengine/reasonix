# Changelog

All notable changes to Reasonix. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/esengine/reasonix/releases/tag/v0.2.0
[0.1.0]: https://github.com/esengine/reasonix/releases/tag/v0.1.0
