# Reasonix tool-use eval (τ-bench-lite)

**Date:** 2026-04-21T14:57:44.906Z
**Agent model:** `deepseek-chat`
**User-simulator model:** `deepseek-chat`
**Tasks:** 8, repeats × 3
**Reasonix version:** 0.2.1

## Summary

| metric | baseline | reasonix | delta |
|---|---:|---:|---:|
| runs | 24 | 24 | — |
| pass rate | 96% | 100% | +4pp |
| cache hit | 46.6% | 94.4% | **+47.7pp** |
| mean cost / task | $0.002599 | $0.001579 | ×0.61 |
| mean turns | 4.4 | 4.6 | — |
| mean tool calls | 3.0 | 2.7 | — |

**Reasonix vs Claude Sonnet 4.6 (estimated, same token counts):**
Claude would cost ~$0.038203 / task, so Reasonix saves ~96.0%.
(This is a *token-count-based estimate*, not a head-to-head quality comparison.)

## Per-task breakdown

| task | mode | pass | turns | tools | cache | cost |
|---|---|:---:|---:|---:|---:|---:|
| t01_address_happy | baseline | ✅ | 3 | 3 | 53.1% | $0.001383 |
| t01_address_happy | reasonix | ✅ | 3 | 3 | 94.4% | $0.000896 |
| t01_address_happy | baseline | ✅ | 3 | 3 | 53.3% | $0.001405 |
| t01_address_happy | reasonix | ✅ | 3 | 2 | 95.0% | $0.000756 |
| t01_address_happy | baseline | ✅ | 3 | 2 | 44.0% | $0.001193 |
| t01_address_happy | reasonix | ✅ | 3 | 2 | 92.6% | $0.000848 |
| t02_address_not_allowed | baseline | ✅ | 8 | 2 | 23.6% | $0.004647 |
| t02_address_not_allowed | reasonix | ✅ | 8 | 4 | 95.6% | $0.003067 |
| t02_address_not_allowed | baseline | ✅ | 8 | 3 | 29.9% | $0.005585 |
| t02_address_not_allowed | reasonix | ✅ | 8 | 2 | 96.2% | $0.002822 |
| t02_address_not_allowed | baseline | ✅ | 8 | 7 | 50.7% | $0.007021 |
| t02_address_not_allowed | reasonix | ✅ | 8 | 3 | 95.8% | $0.003140 |
| t03_cancel_processing | baseline | ✅ | 3 | 3 | 53.3% | $0.001349 |
| t03_cancel_processing | reasonix | ✅ | 3 | 3 | 94.9% | $0.000803 |
| t03_cancel_processing | baseline | ✅ | 2 | 3 | 64.6% | $0.001041 |
| t03_cancel_processing | reasonix | ✅ | 2 | 2 | 93.8% | $0.000563 |
| t03_cancel_processing | baseline | ✅ | 3 | 3 | 53.4% | $0.001332 |
| t03_cancel_processing | reasonix | ✅ | 2 | 2 | 93.8% | $0.000566 |
| t04_refund_delivered | baseline | ✅ | 2 | 2 | 55.9% | $0.001007 |
| t04_refund_delivered | reasonix | ✅ | 2 | 3 | 91.0% | $0.000911 |
| t04_refund_delivered | baseline | ✅ | 3 | 2 | 44.8% | $0.001268 |
| t04_refund_delivered | reasonix | ✅ | 3 | 3 | 93.2% | $0.000941 |
| t04_refund_delivered | baseline | ✅ | 3 | 3 | 53.5% | $0.001469 |
| t04_refund_delivered | reasonix | ✅ | 3 | 3 | 94.4% | $0.000952 |
| t05_refund_not_delivered | baseline | ✅ | 8 | 4 | 41.7% | $0.005369 |
| t05_refund_not_delivered | reasonix | ✅ | 7 | 2 | 96.3% | $0.002212 |
| t05_refund_not_delivered | baseline | ✅ | 8 | 3 | 30.6% | $0.004762 |
| t05_refund_not_delivered | reasonix | ✅ | 8 | 4 | 95.1% | $0.003159 |
| t05_refund_not_delivered | baseline | ✅ | 6 | 2 | 24.8% | $0.003128 |
| t05_refund_not_delivered | reasonix | ✅ | 6 | 2 | 94.7% | $0.001927 |
| t06_multi_order_lookup | baseline | ✅ | 2 | 2 | 52.4% | $0.000913 |
| t06_multi_order_lookup | reasonix | ✅ | 3 | 2 | 92.7% | $0.000988 |
| t06_multi_order_lookup | baseline | ✅ | 3 | 2 | 41.2% | $0.001530 |
| t06_multi_order_lookup | reasonix | ✅ | 3 | 2 | 93.4% | $0.000996 |
| t06_multi_order_lookup | baseline | ✅ | 3 | 4 | 60.9% | $0.001920 |
| t06_multi_order_lookup | reasonix | ✅ | 3 | 2 | 92.2% | $0.000947 |
| t07_wrong_identity | baseline | ❌ | 2 | 2 | 54.9% | $0.000815 |
| t07_wrong_identity | reasonix | ✅ | 8 | 2 | 95.5% | $0.002777 |
| t07_wrong_identity | baseline | ✅ | 8 | 3 | 26.6% | $0.004953 |
| t07_wrong_identity | reasonix | ✅ | 7 | 2 | 95.6% | $0.002356 |
| t07_wrong_identity | baseline | ✅ | 8 | 3 | 24.0% | $0.005210 |
| t07_wrong_identity | reasonix | ✅ | 8 | 2 | 96.3% | $0.002587 |
| t08_address_then_cancel | baseline | ✅ | 3 | 3 | 53.4% | $0.001465 |
| t08_address_then_cancel | reasonix | ✅ | 3 | 4 | 94.6% | $0.001174 |
| t08_address_then_cancel | baseline | ✅ | 3 | 4 | 62.1% | $0.001677 |
| t08_address_then_cancel | reasonix | ✅ | 3 | 5 | 94.1% | $0.001371 |
| t08_address_then_cancel | baseline | ✅ | 3 | 5 | 66.5% | $0.001933 |
| t08_address_then_cancel | reasonix | ✅ | 3 | 4 | 93.5% | $0.001142 |

## Scope & caveats

This is **τ-bench-lite**, not a port of Sierra's upstream τ-bench. Specifically:

- Tasks are hand-authored in the retail domain; the schema mirrors τ-bench
  (stateful tools, LLM user-sim, DB-end-state success predicates), so upstream
  tasks can later be dropped in without harness changes.
- Every pass/fail judgment is a deterministic DB predicate — no LLM judge.
  Refusal tasks pass iff the DB is unchanged.
- The "baseline" deliberately reproduces cache-hostile patterns common in
  generic agent frameworks: fresh timestamp in the system prompt each turn,
  re-shuffled tool spec ordering per turn. It is **not** a benchmark of
  LangChain specifically.
- Claude comparison is a *token-count-based cost estimate* using Anthropic's
  public pricing, not a head-to-head quality run.
- User simulator is DeepSeek V3 at T=0.1. Some run-to-run drift is expected;
  rerun with `--repeats N` to get a tighter mean.

## Reproducing

1. `export DEEPSEEK_API_KEY=sk-...`
2. `npm install`
3. `npx tsx benchmarks/tau-bench/runner.ts --repeats 3`
4. `npx tsx benchmarks/tau-bench/report.ts benchmarks/tau-bench/results-*.json`
