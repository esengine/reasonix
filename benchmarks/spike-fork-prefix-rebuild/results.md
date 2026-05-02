# Exp 1 — results

**PASS.** Both invariants hold at 100% across all three synthetic shapes. Stage 1
(schema work for forkable sessions) is unblocked.

## What was measured

For each session shape, the harness validates two properties the fork primitive
relies on:

1. **Cross-run determinism.** Synthesise the same logical session twice (two
   independent `Eventizer` instances, fresh timestamps) and compare the
   conversation projection — `JSON.stringify(replay(events).conversation.messages)`.
   Must match byte-for-byte. Confirms event-level non-determinism (timestamps,
   ids) does not leak into the projected message stream.
2. **Append-only at the message level.** At every turn boundary in the event
   log, slice events to that point, project messages. The projection at boundary
   N must be a strict prefix of the projection at boundary N+k. Confirms a fork
   rebuilt at boundary N produces a `messages[]` that the parent's later state
   would still recognise as its own prefix — the precondition for prefix-cache
   hits when the fork is sent to the API.

Invariant 1 is the lower bar (purity of the eventizer/reducer pipeline).
Invariant 2 is the load-bearing one for fork's economic claim.

## Numbers

| shape           | turns | events | determinism | slice/rebuild parity |
|-----------------|------:|-------:|:-----------:|:--------------------:|
| quick-fix       |     5 |     18 | PASS        | 5/5                  |
| local-refactor  |    20 |    285 | PASS        | 20/20                |
| long-tail-debug |    80 |    522 | PASS        | 80/80                |

Reproduce: `npx tsx benchmarks/spike-fork-prefix-rebuild/exp1.ts`

## Why this clears Stage 1

The RFC's cache contract assumes:

> The reducers replay events deterministically. Any per-turn freshness lives in
> the volatile scratch.

Exp 1 confirms both halves on synthetic data. No timestamp, id, or eventizer
counter leaks into `ConversationView.messages`; replays of identical input
sequences produce byte-identical message arrays; and the message stream is
append-only at every turn boundary, matching the kernel's append-only log
contract.

What remains for Stage 0 is **Exp 2** — same sweep against a real recorded
session. Exp 1 catches reducer / eventizer bugs cheaply; Exp 2 catches the
production-only failure modes (mid-session compact, retry/repair side-paths,
streaming partials, scratch bleed) that synthesis won't simulate.

Stage 1 (schema additions for `parent` + `fork.claim`) can begin in parallel
with Exp 2 — the schema work doesn't block on real-session results, and a
failure in Exp 2 would be caught before Stage 3 (the fork CLI).

## Out of scope for this experiment

- The session-fixed prefix (`ImmutablePrefix.fingerprint`) is trivially
  reproducible from session config and is not exercised here.
- The cache-stability of the byte stream sent to DeepSeek is a downstream
  consequence of (1) + (2) plus serialisation determinism — the latter is
  guaranteed by `JSON.stringify` on plain objects with stable key insertion
  order, which we already rely on for the live cache hit path.
