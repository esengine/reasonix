# MCP reconnect — empirical cache-prefix spike

Live `deepseek-chat` (DeepSeek prefix cache enabled by default).
System prompt: 1546 chars (~390 tokens). 5 turns each with a small
user message; tool-set varies between turns to simulate the drift
shapes a `/mcp reconnect <name>` would emit.

## Run

```
turn                                      prompt     hit    miss    hit%      ms
--------------------------------------------------------------------------------
1 · cold start (toolset A)                   758     640     118   84.4%    1092
2 · same prefix (toolset A)                  753     640     113   85.0%    1535
3 · drift: ADDED tool (toolset A+)           810     768      42   94.8%    1048
4 · same prefix again (toolset A+)           807     768      39   95.2%    1480
5 · drift: EDITED desc (toolset A')          761     640     121   84.1%     791
```

(Turn 1's "cold" is misleading — the prefix had been seen by the
remote cache from an earlier run within the cache TTL.)

## Findings

DeepSeek's prefix cache works at chunk granularity (consistent with
publicly documented ~128-token chunks). Three concrete lessons:

1. **Append-only drift is nearly free.** Turn 3 adds one tool *at the
   end* of the tool list — every cache chunk before the new tool
   stays valid, only the appended bytes miss. Net: 94.8% hit, even
   higher than the no-drift baseline (because the system prompt +
   whole toolset-A is still cached, and the appended chunk is now
   cached too).
2. **Mid-stream drift loses everything past the divergence.** Turn 5
   edits a description on the *first* tool, so divergence falls
   inside the tools block early. Hit drops to 84.1% — still high
   here only because the system prompt occupies enough chunks before
   the divergence point.
3. **Position of the drift dominates the cost.** A trailing addition
   is essentially zero. An edit near the start of tools is more
   expensive. An edit in the system prompt itself (not tested) would
   wipe the cache to zero — expected, but irrelevant for reconnect
   since we don't change the system prompt on reconnect.

## Implication for RFC #110

The "any drift = full cache miss" framing in the RFC body is too
pessimistic. The real cost of accepting a drifted reconnect depends
on *where* the drift lands:

- Server adds a new tool (most common reconnect drift) → trivial
  cost, accept silently.
- Server changes an existing tool's schema or description → bounded
  cost depending on position, surface a one-line warning.
- Server completely reorders or replaces the tool list → effectively
  full miss, refuse or require `--force`.

This nudges the design call away from blanket "strict default"
toward a **graduated permissive** policy: accept appends silently,
warn on mid-stream edits, refuse on whole-list reorders or removals.

The strict approach can still be the explicit `--strict` flag for
users who need every byte of cache (e.g. high-volume scripted runs).
