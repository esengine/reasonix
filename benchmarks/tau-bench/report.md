# Reasonix tool-use eval (τ-bench-lite)

**Date:** 2026-04-29T16:34:53.893Z
**Agent model:** `deepseek-chat`
**User-simulator model:** `deepseek-chat`
**Tasks:** 8, repeats × 3
**Reasonix version:** 0.16.0

## Summary

| metric | baseline | reasonix | delta |
|---|---:|---:|---:|
| runs | 24 | 24 | — |
| pass rate | 100% | 100% | +0pp |
| cache hit | 32.8% | 90.2% | **+57.4pp** |
| mean cost / task | $0.000992 | $0.000593 | ×0.60 |
| mean turns | 4.8 | 4.3 | — |
| mean tool calls | 2.7 | 2.7 | — |

**Reasonix vs Claude Sonnet 4.6 (estimated, same token counts):**
Claude would cost ~$0.039998 / task, so Reasonix saves ~98.1%.
(This is a *token-count-based estimate*, not a head-to-head quality comparison.)

## Per-task breakdown

| task | mode | pass | turns | tools | cache | cost |
|---|---|:---:|---:|---:|---:|---:|
| t01_address_happy | baseline | ✅ | 3 | 3 | 47.9% | $0.000579 |
| t01_address_happy | reasonix | ✅ | 2 | 3 | 88.6% | $0.000329 |
| t01_address_happy | baseline | ✅ | 3 | 3 | 46.4% | $0.000577 |
| t01_address_happy | reasonix | ✅ | 3 | 3 | 91.0% | $0.000383 |
| t01_address_happy | baseline | ✅ | 3 | 3 | 38.7% | $0.000538 |
| t01_address_happy | reasonix | ✅ | 3 | 3 | 91.4% | $0.000381 |
| t02_address_not_allowed | baseline | ✅ | 8 | 2 | 6.6% | $0.001809 |
| t02_address_not_allowed | reasonix | ✅ | 8 | 3 | 91.9% | $0.001170 |
| t02_address_not_allowed | baseline | ✅ | 8 | 2 | 7.0% | $0.001644 |
| t02_address_not_allowed | reasonix | ✅ | 8 | 2 | 90.0% | $0.001021 |
| t02_address_not_allowed | baseline | ✅ | 8 | 2 | 12.5% | $0.001788 |
| t02_address_not_allowed | reasonix | ✅ | 7 | 2 | 90.6% | $0.000891 |
| t03_cancel_processing | baseline | ✅ | 2 | 3 | 59.4% | $0.000412 |
| t03_cancel_processing | reasonix | ✅ | 2 | 3 | 86.3% | $0.000321 |
| t03_cancel_processing | baseline | ✅ | 2 | 3 | 59.6% | $0.000409 |
| t03_cancel_processing | reasonix | ✅ | 3 | 3 | 90.6% | $0.000360 |
| t03_cancel_processing | baseline | ✅ | 2 | 3 | 60.0% | $0.000408 |
| t03_cancel_processing | reasonix | ✅ | 2 | 3 | 93.2% | $0.000291 |
| t04_refund_delivered | baseline | ✅ | 3 | 3 | 49.2% | $0.000598 |
| t04_refund_delivered | reasonix | ✅ | 3 | 3 | 93.5% | $0.000379 |
| t04_refund_delivered | baseline | ✅ | 3 | 3 | 47.6% | $0.000599 |
| t04_refund_delivered | reasonix | ✅ | 2 | 3 | 91.1% | $0.000320 |
| t04_refund_delivered | baseline | ✅ | 3 | 3 | 48.7% | $0.000608 |
| t04_refund_delivered | reasonix | ✅ | 2 | 3 | 93.5% | $0.000335 |
| t05_refund_not_delivered | baseline | ✅ | 8 | 2 | 7.1% | $0.001631 |
| t05_refund_not_delivered | reasonix | ✅ | 7 | 2 | 89.0% | $0.000990 |
| t05_refund_not_delivered | baseline | ✅ | 8 | 2 | 7.0% | $0.001686 |
| t05_refund_not_delivered | reasonix | ✅ | 8 | 3 | 93.3% | $0.001294 |
| t05_refund_not_delivered | baseline | ✅ | 6 | 3 | 22.3% | $0.001295 |
| t05_refund_not_delivered | reasonix | ✅ | 7 | 2 | 89.7% | $0.000878 |
| t06_multi_order_lookup | baseline | ✅ | 4 | 2 | 26.8% | $0.000726 |
| t06_multi_order_lookup | reasonix | ✅ | 4 | 2 | 87.5% | $0.000478 |
| t06_multi_order_lookup | baseline | ✅ | 4 | 2 | 25.5% | $0.000798 |
| t06_multi_order_lookup | reasonix | ✅ | 3 | 2 | 84.9% | $0.000332 |
| t06_multi_order_lookup | baseline | ✅ | 4 | 2 | 28.1% | $0.000748 |
| t06_multi_order_lookup | reasonix | ✅ | 3 | 2 | 88.0% | $0.000398 |
| t07_wrong_identity | baseline | ✅ | 8 | 2 | 12.0% | $0.001686 |
| t07_wrong_identity | reasonix | ✅ | 8 | 2 | 88.7% | $0.001066 |
| t07_wrong_identity | baseline | ✅ | 8 | 2 | 11.7% | $0.001734 |
| t07_wrong_identity | reasonix | ✅ | 4 | 2 | 88.1% | $0.000573 |
| t07_wrong_identity | baseline | ✅ | 8 | 2 | 12.5% | $0.001629 |
| t07_wrong_identity | reasonix | ✅ | 6 | 2 | 87.7% | $0.000843 |
| t08_address_then_cancel | baseline | ✅ | 3 | 4 | 48.6% | $0.000629 |
| t08_address_then_cancel | reasonix | ✅ | 2 | 3 | 94.1% | $0.000307 |
| t08_address_then_cancel | baseline | ✅ | 3 | 4 | 49.4% | $0.000603 |
| t08_address_then_cancel | reasonix | ✅ | 3 | 4 | 89.7% | $0.000468 |
| t08_address_then_cancel | baseline | ✅ | 3 | 4 | 52.7% | $0.000677 |
| t08_address_then_cancel | reasonix | ✅ | 3 | 4 | 92.8% | $0.000434 |

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
