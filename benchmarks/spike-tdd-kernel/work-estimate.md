# Staged work estimate — kernel red-green (RFC #25)

> Local-only estimate, paired with `tracking-issue-draft.md`. Numbers are wall-clock for one focused day, not "ideal" hours.

## Total

~4–5 days of actual coding across all three stages. Then ~2 minor releases of soak before flipping default-on.

| Stage | Code (LoC) | Tests (LoC) | Wall time | Risk |
|---|---|---|---|---|
| 1. events + writer | ~300 | ~150 | 0.5 day | low |
| 2. dispatcher gate | ~600 | ~400 | 2–3 days | **high** |
| 3. plan + UI | ~250 | ~120 | 1 day | medium |

## Stage 1 — events + writer (0.5 day)

Almost entirely additive, no behavior change.

**Changes:**
- `src/core/events.ts:190` — extend `Event` union with `TestRunEvent` + `EditClaimEvent`.
- `src/core/test-id.ts` (new, ~50 LoC) — `extractTestId(file, fullName, source)` per `test-id-spec.md`.
- `src/core/reducers/red-green.ts` (new, ~30 LoC) — `pairRedGreen(events)` reducer.
- `src/cli/commands/events.ts` — add `red-green` subcommand listing pairs.
- `src/adapters/event-sink-jsonl.ts` — already generic over `Event`, no edits required.

**Tests:**
- Round-trip: append a `test_run` event, replay through reducer.
- `extractTestId` matrix: 8 cases (rename, move, parametrise, annotation override, etc.).

**Risk:** low. Pattern matches existing event additions in v0.14.

## Stage 2 — dispatcher gate (2–3 days, **the load-bearing one**)

This is where most of the actual integration risk lives.

**Changes:**
- `src/tools/filesystem.ts:518` — `edit_file` registration wraps in a gate. When `REASONIX_STRICT_TDD=1`:
  1. Look up most recent `test_run` for `test_id` from in-memory event list (cheaper than re-reading jsonl).
  2. Verify a matching `edit_claim` followed it.
  3. On dispatch refusal, throw a structured error the model can read.
- `src/loop.ts` — per-turn coalescing buffer:
  - When `edit_file` succeeds, push `{test_id, test_file_path}` to a turn-scoped Set.
  - At end-of-turn (just before the next assistant call), spawn one `vitest --run -t a -t b -t c` covering all collected ids.
  - Parse `--reporter=json` output, emit one `test_run` event per id.
  - On any red, revert the offending edits via the existing checkpoint mechanism (`src/checkpoints.ts`), emit a `repair` event so the storm-breaker engages.
- `/refactor` mode — session flag in `LoopState`. When true, gate is bypassed; on session exit, run `npm run verify` (or `reasonix.config.ts`'s `verify_command`).
- `reasonix.config.ts` schema — add `verify_command` and `test_command_for(test_id)`.

**Tests:**
- Integration on a synthetic session fixture: green path, red revert, multi-edit batch, `/refactor` bypass, edit before any test_id (refused).
- Mock vitest spawner so tests don't depend on actual vitest runs.

**Risk: high.** Specific concerns:
- **Loop coordination.** End-of-turn flush has to play nice with: abort controller (`_turnAbort`), /pro escalation (mid-turn model swap), storm-breaker (`src/repair/storm.ts`), thinking-mode round-trip (reasoning_content preservation). Any one of these can desynchronise the buffer.
- **Vitest spawn hang.** Need timeout + kill + emit a `test_run` event with `status='fail'` and a tagged failure reason. Otherwise a stuck test hangs the whole agent.
- **Cross-platform paths.** Vitest's `fullName` should be POSIX-normalised before becoming part of `test_id`; spike runs were on Windows but didn't stress this.
- **Revert semantics.** If batch had 3 edits and 1 went red, only that file reverts; others stay. Existing `Checkpoint` is per-file, but the index (`src/checkpoints.ts`) needs a partial-restore code path.

**Mitigation:** land stage 2 in two PRs — first the gate + buffer behind a new flag (no auto-run), then the auto-run + revert. Validates the synchronisation before adding the spawner.

## Stage 3 — plan + UI (1 day)

**Changes:**
- `src/tools/plan-types.ts:3` — `PlanStep` gains `test_id?` + `test_file_path?`.
- `src/tools/plan-core.ts` — `submit_plan` validation: any step with `test_id` must have `test_file_path`.
- `src/cli/commands/doctor.ts` — warn when plan has `test_id` but missing `test_file_path`; warn on first session in an untested codebase, suggest `/refactor` default.
- TUI plan card — render red/green dots per step (need to inspect `src/cli/ui/cards/PlanCard*` to see how steps render today).

**Tests:**
- Plan validation: rejects step with `test_id` missing `test_file_path`.
- Doctor output: snapshot of warning lines.
- TUI snapshot for a 3-step plan with mixed red/green/pending dots.

**Risk: medium.** TUI rendering is the unknown — depends on whether the current plan card has slots for status badges, or if the layout needs widening.

## Default-on rollout (calendar, not work)

- After stage 3 lands: minor release with flag *off* by default.
- Two minor releases of soak — collect any hangs / false-refusals via telemetry, fix in patches.
- Flip default-on; keep `REASONIX_STRICT_TDD=0` opt-out for two more minor releases.

## Cross-cutting risks not pinned to a stage

1. **Untested codebases.** `reasonix doctor` should detect (no `tests/` dir, no `vitest.config.*`) and refuse to enable strict mode at all on first run. Otherwise the flag is unusable.
2. **Greenfield test-file location.** Spike Exp 3 showed the model picks reasonable but inconsistent paths when none is specified. The plan-step `test_file_path` field is the fix, but a user editing a single file with no plan still has the gap. Stage 2 should refuse `edit_file` when strict + no `test_file_path` is in scope.
3. **MCP-served edit tools.** Reasonix supports MCP-hosted tools (`src/mcp.ts`). If an MCP server exposes its own write/edit tool, the kernel gate doesn't apply. Stage 2 should at minimum log a warning; longer-term, MCP write tools could opt into the same gate via a hook.
