# Spike — fork prefix rebuild

Tracks RFC #87 (Forkable sessions). Validates the load-bearing claim before any kernel
work: **a session reconstructed from `events.jsonl` via reducers + `ImmutablePrefix.build`
produces a byte-prefix that matches the original turn's `prefixHash`** — i.e. a fork
served from cache, not billed at miss-rate.

## What the kernel already proves

`tests/event-replay.test.ts:23` — round-trips synthetic LoopEvents through
`Eventizer → events.jsonl → readEventLogFile → replay()` and asserts the resulting
`ConversationView.messages` matches expectations. The conversation projection is
deterministic.

What's NOT yet proven: that feeding those projected messages back through
`ImmutablePrefix.build()` yields a byte-prefix whose hash equals the
`ModelTurnStartedEvent.prefixHash` recorded at the original turn. The hash equality
is what cache-hit on fork depends on; everything else is decoration.

## Experiments

### Exp 1 — synthetic round-trip hash equality (cheap, runs first)

Generate three synthetic event streams matching the parent shapes called out in the
RFC cost section:

| shape | turns | tool density | prefix size | log size |
|-------|-------|--------------|-------------|----------|
| local-refactor | 20 | high (3-5 tools / turn) | small | medium |
| long-tail-debug | 80 | medium (1-2 / turn) | small | large |
| quick-fix | 5 | low (0-1 / turn) | small | small |

For each generated stream:
1. Record `prefixHash` at every `ModelTurnStartedEvent` during initial generation.
2. After completion, for each eventId in the stream:
   - Slice events to `[0..eventId)`.
   - Run `replay()` reducers → `ConversationView.messages`.
   - Pass `messages` through `ImmutablePrefix.build()` with the same system / tools
     pinned at session open.
   - Recompute hash. Compare against the recorded `prefixHash`.

**Pass criterion:** ≥95% match across all three shapes. Below 90% fails the RFC.

### Exp 2 — replay against a real session log (only if Exp 1 passes)

Capture one user-driven session (~30-50 turns) under instrumented chat. Run the same
slice-and-rehash sweep against the recorded events.jsonl. Report:

- match ratio per turn position (early / mid / late)
- which event types correlate with hash divergence (if any)
- specific cases where divergence happens (per-turn timestamp leak, scratch bleed,
  schema drift between session-open and current code)

### Exp 3 — compact barrier behavior

Construct a stream containing a `SessionCompactedEvent`. Verify:
- Rebuild before compact: hash matches pre-compact `prefixHash`.
- Rebuild straddling compact: harness raises (per the cache contract — Q3 in the RFC).
- Rebuild after compact: hash matches post-compact `prefixHash`, with the
  `replacementMessages` being authoritative.

## Out of scope

- Running an actual fork end-to-end (requires Stage 2-3 wiring; this spike validates
  the precondition only).
- Tool-result re-execution (`--rerun-tools` semantics — tested at Stage 5).
- Any UI work.

## Status

Scaffolded. `harness.mjs` and `results.md` land in follow-up commits on this branch
once experiments run.
