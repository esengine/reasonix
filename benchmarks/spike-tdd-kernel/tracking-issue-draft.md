# [draft, do not post yet] tracking: kernel red-green

> Local draft for the tracking issue to open after RFC #25 FCP closes.
> File path: `benchmarks/spike-tdd-kernel/tracking-issue-draft.md` — delete after the real issue is filed.

---

**Title:** `tracking: kernel red-green (RFC #25)`
**Labels:** `enhancement`, `tracking`

---

## Summary

Land the kernel-level red-green TDD invariant proposed in #25. All work behind `REASONIX_STRICT_TDD=1` (default off until stage 3 lands and bakes for one minor release).

Spike validation: all four feasibility experiments green ([summary](#issuecomment-4358477014), artifacts in `benchmarks/spike-tdd-kernel/`).

## Touch points (discovered during spike)

| File | Change |
|---|---|
| `src/core/events.ts:190` | Add `TestRunEvent` and `EditClaimEvent` to the `Event` union. |
| `src/core/test-id.ts` (new) | `extractTestId(file, fullName, source) → { id, source: 'native' \| 'annotation' }`. |
| `src/tools/plan-types.ts:3` | `PlanStep` gains optional `test_id?: string` and `test_file_path?: string`. |
| `src/tools/filesystem.ts:518` | `edit_file` registration wraps in a dispatcher gate when flag is on. |
| `src/loop.ts` | Per-turn `test_id` coalescing buffer; flush via single `vitest -t a -t b -t c` at end-of-turn. |
| `src/cli/commands/doctor.ts` | Warn when a plan step has `test_id` without `test_file_path`. |
| `reasonix.config.ts` schema | `test_command_for(test_id)` resolver for non-vitest runners. |

## Stages

Each stage lands as its own PR. No stage ships strict-by-default until stage 3 + a minor-release soak.

### Stage 1 — events + writer (no enforcement)

- [ ] Add `TestRunEvent` / `EditClaimEvent` to `src/core/events.ts`.
- [ ] Implement `extractTestId` per spec in `benchmarks/spike-tdd-kernel/test-id-spec.md`.
- [ ] Wire writers into the existing JSONL sink (`src/adapters/event-sink-jsonl.ts`).
- [ ] Reducer: `pairRedGreen(events) → Array<{test_id, red_ts, green_ts}>` for downstream tooling.
- [ ] CLI: `reasonix events red-green` lists pairs.
- [ ] Tests: event round-trip, `extractTestId` against the test-id spec's matrix.

**Acceptance:** `events.jsonl` contains `test_run` / `edit_claim` lines after a manual run, but no behavior change to `edit_file` dispatch.

### Stage 2 — dispatcher gate (still flag-gated)

- [ ] `edit_file` (in `src/tools/filesystem.ts`) consults the event log when `REASONIX_STRICT_TDD=1`. Refuses when the invariants in RFC #25 §"Kernel invariant" don't hold.
- [ ] Per-turn coalescing buffer in `src/loop.ts`. End-of-turn flushes via single `vitest -t …` invocation. Output → `test_run` events; offending edits revert; emit `repair` event for storm-breaker.
- [ ] `/refactor` mode flag — when active, dispatcher uses `npm run verify` (or config equivalent) at exit instead of per-test gating.
- [ ] Tests: integration covering green path, red revert, multi-edit batch, `/refactor` bypass.

**Acceptance:** With `REASONIX_STRICT_TDD=1`, the kernel correctly enforces red→green on a recorded multi-turn fixture session.

### Stage 3 — plan integration + UI

- [ ] `PlanStep` adds `test_id?` + `test_file_path?` (`src/tools/plan-types.ts`).
- [ ] `submit_plan` validates: if any step has `test_id`, `test_file_path` is required.
- [ ] `reasonix doctor`: warns on plans missing `test_file_path`; warns on first session in an untested codebase, suggests `/refactor` default.
- [ ] TUI: red/green dots per plan step.
- [ ] Tests: doctor output, plan-step validation, TUI snapshot for the dots.

**Acceptance:** `/plan` for a feature requiring a new test correctly drives the model through red → edit → green; the TUI dots reflect each step's status live.

## Default-on rollout

- After stage 3 lands, ship a minor release with `REASONIX_STRICT_TDD=1` *not* on by default. Soak for one release.
- One release later: flip default-on. Add `REASONIX_STRICT_TDD=0` opt-out for users who need the legacy behavior.
- Keep the opt-out for at least two more minor releases before considering removal.

## Out of scope here

- Cross-runner support (jest, mocha) — vitest only at first. Tracked separately if requested.
- Coverage gating.
- Branch-and-select alternatives at the test level.

## References

- RFC #25
- Spike artifacts: `benchmarks/spike-tdd-kernel/{latency,test-id-spec,tdd-eval,cost-results}.md`
- Reproducible bench scripts: `benchmarks/spike-tdd-kernel/{bench-latency,tdd-eval,cost}.mjs`
