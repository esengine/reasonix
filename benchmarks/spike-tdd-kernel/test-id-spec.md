# Exp 2 — `test_id` stability spec

**Result: PASS (with hybrid).** Adopt vitest-native id (`<rel-path>::<fullName>`) as the default, with an optional annotation override for users who care about rename stability.

## Schemes evaluated

### A. vitest-native — `<relative-path>::<fullName>`

Example: `tests/bang.test.ts::detectBangCommand returns the command body for a \`!\`-prefixed input`

Verified against the JSON reporter (`npx vitest --reporter=json`); `fullName` is the documented `describe` chain joined with the leaf title and is what `-t "<fullName>"` matches against.

| event | stable? |
|---|---|
| edit test **body** (logic, asserts) | yes |
| rename `it()` title | **no** — id changes |
| rename outer `describe()` | **no** — id changes |
| move file | **no** — path changes |
| reorder `describe` blocks | yes |
| `it.each` parametrise: add row | yes for existing rows; new id appears |
| `it.each` parametrise: change a row's args | id changes for that case |

Critical failures: 3 (rename it / rename describe / move file).

### B. content hash — sha256 of test body

| event | stable? |
|---|---|
| edit test body | **no** — id changes on any whitespace edit |
| rename it/describe | yes |
| move file | yes |
| parametrise | yes (body unchanged) |

Critical failure: 1, but it's the worst possible one. Tests evolve while red — adding asserts, narrowing scope. A scheme that invalidates `test_id` on every body edit makes `edit_claim` impossible to track across the red→green journey. **Reject.**

### C. user annotation — `// @reasonix-test-id: foo`

| event | stable? |
|---|---|
| edit body / rename / move | yes |
| parametrise | ambiguous — one id, N runs |
| greenfield | requires model to invent + uniqueness-check |
| existing 96 test files | zero have it; brownfield bootstrap is awkward |

Critical failures: 2 (parametrise ambiguity, brownfield bootstrap). Strong on rename, weak on adoption.

## Decision: hybrid (A as default, C as opt-in override)

Default `test_id` = `<rel-path>::<fullName>`.
If the test source contains `// @reasonix-test-id: <slug>` directly above the `it(`/`test(`, that slug overrides the default.

```ts
// @reasonix-test-id: bang.parses-leading-bang
it('returns the command body for a `!`-prefixed input', () => { … });
```

This handles the failure modes of A:
- **Rename it/describe**: a user who anticipates renames adds the annotation once. Without it, kernel treats rename as a new test (correct — the old red is gone, so should be the old claim).
- **Move file**: same — annotation makes the id survive moves.
- **Brownfield**: zero churn for existing 96 files; they use the default.
- **Greenfield**: model uses the default unless the user requests stability. `reasonix doctor` could surface a warning when a `test_id` would be lost.

### How the dispatcher resolves it

When extracting `test_id` from a `test_run` event, the kernel:
1. Parses `--reporter=json` output → `{file, fullName}`.
2. Reads the test source (already in workspace).
3. If an annotation comment within 3 lines above the matched `it(` exists, use the slug.
4. Else use `<rel-path>::<fullName>`.

This is deterministic and replayable from `events.jsonl` alone (the source at the time of the event is captured by the workspace snapshot).

## Implications for the RFC

Update RFC §"New event types":

```ts
type TestRunEvent = {
  type: 'test_run';
  test_id: string;           // <rel-path>::<fullName>  OR  user annotation slug
  test_id_source: 'native' | 'annotation';   // for debugging / migration
  status: 'pass' | 'fail';
  command: string;
  duration_ms: number;
  ts: number;
};
```

Add §"`test_id` resolution" subsection citing this spec.

## Out of scope (defer)

- Cross-runner support (jest, mocha). Reasonix workspaces today are predominantly vitest; ship vitest-only first.
- Refactor-safe id (e.g., AST-based fingerprint resilient to whitespace + rename). Possible v2.
