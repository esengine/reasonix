# Spike results

**Stage 0 PASS.** Both experiments validate the load-bearing claim of RFC #87:
the reducer's projection of an event-log slice is byte-identical to the parent's
original prefix at that point, so a fork rebuilt at any past `eventId` hits the
prefix cache the same way the parent did.

## Exp 1 — synthetic round-trip byte equality

Three session shapes, two invariants per shape, 100% pass rate.

| shape           | turns | events | cross-run determinism | message-level append-only |
|-----------------|------:|-------:|:---------------------:|:-------------------------:|
| quick-fix       |     5 |     18 | PASS                  | 5/5                       |
| local-refactor  |    20 |    285 | PASS                  | 20/20                     |
| long-tail-debug |    80 |    522 | PASS                  | 80/80                     |

- **Cross-run determinism**: synthesise the same logical session twice (two
  fresh `Eventizer` instances → fresh timestamps and ids) and the conversation
  projection — `JSON.stringify(replay(events).conversation.messages)` — matches
  byte-for-byte. Confirms event-level non-determinism does not leak into the
  message stream.
- **Message-level append-only**: at every turn boundary, the projection at cut
  N is a strict prefix of the projection at any later cut. Precondition for
  prefix-cache hits across forks.

Reproduce: `npx tsx benchmarks/spike-fork-prefix-rebuild/exp1.ts`

## Exp 2 — real DeepSeek API cache hit on rebuilt fork prefix

Parent session: 4 turns sent to `deepseek-chat` via OpenAI-compatible endpoint.
Fork: rebuild messages from `events[0..just-before-turn-4-user.message]` via
the reducer, append a deliberately *different* trailing user message
(counterfactual fork), send to API, observe cache stats.

| call                    | prompt | hit | miss | ratio  |
|-------------------------|-------:|----:|-----:|-------:|
| parent turn 1           |     37 |   0 |   37 |   0.0% |
| parent turn 2           |    159 | 128 |   31 |  80.5% |
| parent turn 3           |    257 | 128 |  129 |  49.8% |
| parent turn 4           |    396 | 256 |  140 |  64.6% |
| fork (counterfactual)   |    400 | 256 |  144 |  64.0% |

**Result: `parent4.hit === fork.hit === 256` exactly.**

Both requests share the prefix `[system, U1, A1, U2, A2, U3, A3]`. They differ
only in the trailing user message. DeepSeek's prefix cache hits the longest
matching byte-prefix — so identical hit counts mean the rebuilt prefix is
byte-identical to the parent's original prefix at that point. The 4-token
miss delta corresponds to the counterfactual user message being 15 characters
longer than the original turn-4 user message (which would have been used in
parent's continuation).

This is the strongest possible empirical evidence the RFC's cache contract
holds: not "approximately equal" cache hit, but exactly the same number of
cached tokens.

Reproduce: `npx tsx benchmarks/spike-fork-prefix-rebuild/exp2.ts` (requires
`DEEPSEEK_API_KEY` in `.env`).

## What this clears

The RFC's cache contract assumed:

> The reducers replay events deterministically. Any per-turn freshness lives in
> the volatile scratch.

Exp 1 confirms this on synthetic streams across three session shapes. Exp 2
confirms it survives the round-trip through actual DeepSeek prefix caching.
Stage 1 (event schema additions) and Stage 2 (fork-from-eventId CLI plumbing)
are unblocked.

## Out of scope, next round

- Forks that straddle a `SessionCompactedEvent` (compact replaces messages —
  the RFC's "compact barrier" rule applies; needs a dedicated test once
  Stage 1 lands the schema).
- Forks with subagent boundaries inside the slice.
- `--rerun-tools` paths (re-execute tool calls vs replay from log).
- Long-tail sessions past 80 turns where a single API request approaches the
  context limit.
