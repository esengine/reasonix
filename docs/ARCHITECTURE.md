# Reasonix Architecture

## Design philosophy

Reasonix is **opinionated, not general**. Every abstraction is justified by a
DeepSeek-specific behavior or economic property. If it's generic, we don't
ship it.

## The three pillars

### Pillar 1 — Cache-First Loop

**Problem.** DeepSeek bills cached input at ~10% of the miss rate. Automatic
prefix caching activates only when the *exact* byte prefix of the previous
request matches. Most agent loops reorder, rewrite, or inject fresh
timestamps each turn — cache hit rate in practice: <20%.

**Solution.** Partition the context into three regions:

```
┌─────────────────────────────────────────┐
│ IMMUTABLE PREFIX                        │ ← fixed for session
│   system + tool_specs + few_shots        │   cache hit candidate
├─────────────────────────────────────────┤
│ APPEND-ONLY LOG                         │ ← grows monotonically
│   [assistant₁][tool₁][assistant₂]...    │   preserves prefix of prior turns
├─────────────────────────────────────────┤
│ VOLATILE SCRATCH                        │ ← reset each turn
│   R1 thought, transient plan state      │   never sent upstream
└─────────────────────────────────────────┘
```

**Invariants:**
1. Prefix is computed once per session, hashed, and pinned.
2. Log entries are serialized in append order; no rewrites.
3. Scratch is distilled via Pillar 2 before any information from it is folded
   into the log.

**Metric.** `prompt_cache_hit_tokens / (hit + miss)` exposed per-turn and
aggregated per-session. This is the user-visible proof of Pillar 1's value.

### Pillar 2 — R1 Thought Harvesting *(v0.0.3, opt-in)*

**Problem.** R1 emits extensive `reasoning_content`. DeepSeek's own docs
recommend *not* feeding it back to the next turn. Most frameworks display it
to the user and discard. The planning signal inside is lost.

**Solution.** A two-stage process:

```
R1 output → Harvester (V3, cheap) → TypedPlanState
                                     ├─ subgoals: string[]
                                     ├─ hypotheses: string[]
                                     ├─ uncertainties: string[]
                                     └─ rejectedPaths: string[]
```

The harvester is a cheap V3 call with a strict JSON schema. Output is
validated at runtime. The typed state is queryable by the orchestrator — e.g.
"if `uncertainties.length > 2`, trigger branch sampling."

### Branch-and-Select *(v0.0.5, opt-in, builds on Pillar 2)*

**Why now.** DeepSeek is cheap enough that running N=3 R1 samples is still
cheaper than a single Claude call. What was research luxury (self-consistency
sampling) becomes a practical default.

**How.** When `--branch N` (or `{ branch: N }` in code) is passed:

1. The turn is forced non-streaming (N samples must complete before we can
   compare).
2. `runBranches` fires N `client.chat` calls in parallel, spreading
   temperatures across `[0, 1]` to diversify reasoning paths.
3. Each sample's `reasoning_content` is piped through Pillar 2's harvest.
4. The default selector picks the sample with the fewest `uncertainties`;
   ties are broken by shorter answer length (Occam).
5. The loop emits a `branch_summary` alongside the winning `assistant_final`.

**Cost.** 3× R1 on a hard math problem ≈ \$0.02 — still dominates Claude on
cost/quality for agentic work.

### Pillar 3 — Tool-Call Repair *(v0.0.1 ships complete)*

**Problem.** Empirical DeepSeek failure modes:
- Tool-call JSON emitted inside `<think>`, missing from the final message.
- Arguments dropped when schema has >10 params or deeply nested objects.
- Same tool called repeatedly with identical args (call-storm).
- Truncated JSON due to `max_tokens` hit mid-structure.

**Solution.** Four passes:

1. **`flatten`** — schemas with >10 leaf params or depth >2 are auto-detected
   on `ToolRegistry.register()` and presented to the model in dot-notation
   form. `dispatch()` re-nests the args before calling the user's `fn`.
   Opt out with `new ToolRegistry({ autoFlatten: false })`.
2. **`scavenge`** — regex + JSON parser sweeps `reasoning_content` for any tool
   call the model forgot to emit in `tool_calls`.
3. **`truncation`** — detect unbalanced JSON and repair by closing braces or
   requesting a continuation completion.
4. **`storm`** — identical `(tool, args)` tuple within a sliding window →
   suppress the call, inject a reflection turn.

## Module layout

```
src/
├── client.ts          # httpx-equivalent DeepSeek client (fetch + SSE)
├── loop.ts            # Pillar 1: Cache-First Loop (async iterator)
├── harvest.ts         # Pillar 2 stub (v0.0.1 surface only)
├── repair/
│   ├── index.ts       # Pillar 3 pipeline
│   ├── scavenge.ts
│   ├── flatten.ts
│   ├── truncation.ts
│   └── storm.ts
├── tools.ts           # Tool registry + dispatch
├── memory.ts          # Prefix / Log / Scratch primitives
├── telemetry.ts       # Cost & cache-hit accounting
├── types.ts           # Shared type definitions
├── index.ts           # Library barrel export
└── cli/
    ├── index.ts       # commander entry
    ├── commands/      # chat, run, stats, version
    └── ui/            # Ink React components (App, StatsPanel, EventLog, PromptInput)
```

## Roadmap

- **v0.0.1** — Pillar 1 end-to-end, Pillar 3 complete, Ink TUI, τ-bench scaffold.
- **v0.0.2** — First-run key prompt, saved to `~/.reasonix/config.json`.
- **v0.0.3** — Pillar 2 MVP (opt-in harvest), retry layer, TextInput fix.
- **v0.0.4** — Schema flatten auto-applied in ToolRegistry (closes Pillar 3).
- **v0.0.5** — Self-consistency branching (`--branch N`) driven by Pillar 2
  plan-state uncertainty count.
- **v0.0.6** — Named session persistence (`--session <name>`), JSONL log
  stored under `~/.reasonix/sessions/`, restored into the append-only log
  on resume.
- **v0.1** — τ-bench numbers published, streaming polish, transcript replay.
- **v0.2** — Self-consistency / branch-budget sampling driven by plan state.
- **v0.3** — MCP client, session persistence.

## Explicit non-goals

- Multi-agent orchestration.
- RAG / vector retrieval.
- Support for non-DeepSeek backends.
- Web UI / SaaS.
