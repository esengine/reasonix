# Changelog

All notable changes to Reasonix. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- feat(code): `--system-append` / `--system-append-file` CLI options append user instructions to the code system prompt without replacing the default prompt. Both can be used together (inline first, then file contents). File read errors surface with their OS error code.

## [0.17.1] — 2026-04-29

**Headline:** Fix a render crash in the dashboard's Editor that triggered
when toggling Edit / Split / Preview on a markdown file. Mixing the
CodeMirror-managed DOM with sibling `dangerouslySetInnerHTML` while the
host element changed shape across modes confused Preact's reconciler
(`Failed to execute 'insertBefore' on 'Node'`).

- fix(dashboard): Editor mode toggle no longer restructures the DOM.
  CM container and markdown preview are now always rendered at the same
  vnode positions; `data-mode` on a single `.editor-stage` wrapper
  drives visibility via CSS. CM stays mounted across mode switches and
  is poked with `requestMeasure()` when it becomes visible again.

## [0.17.0] — 2026-04-29

**Headline:** `reasonix index` is now config-driven — what gets walked
is defined entirely by `~/.reasonix/config.json` (with sensible
defaults), `.gitignore` is honoured by default, and the dashboard
Semantic tab gains a Settings card to view, edit, and dry-walk-preview
the rules without leaving the browser. The previous behaviour
hardcoded skip lists in `chunker.ts` and duplicated them in
`directory_tree`; both now read from a single shared source.

- feat(index): new `index` block in `ReasonixConfig` (`excludeDirs`,
  `excludeFiles`, `excludeExts`, `excludePatterns`, `respectGitignore`,
  `maxFileBytes`). Any field present fully replaces its default; absent
  fields keep the default.
- feat(index): nested `.gitignore` honoured by default — each
  subdirectory's rules apply scoped to that subdir, so `pkg-a/.gitignore`
  doesn't leak into `pkg-b/`.
- feat(index): glob excludes via `picomatch` syntax in
  `excludePatterns` (e.g. `**/*.gen.ts`, `vendor/**`, with `!negation`
  supported).
- feat(cli): `reasonix index` success line now prints a per-reason
  skip breakdown (`gitignore: A · pattern: B · defaultDir: C · …`) so
  users see what was filtered and why.
- feat(dashboard): Semantic tab gains a collapsible **Excludes** card
  with editable lists, gitignore toggle, max-file-size input, **Save**
  / **Reset** / **Preview** buttons, and a per-reason sample drilldown
  in the Preview panel.
- feat(server): `GET /api/index-config` returns user/resolved/defaults;
  `POST /api/index-config` persists; `POST /api/index-config/preview`
  dry-walks the project root with a draft config and returns sample
  paths + skip buckets.
- refactor(tools): `directory_tree` now reuses
  `DEFAULT_INDEX_EXCLUDES` from `src/index/config.ts` instead of its
  own copy of the dir/binary lists; the two were already drifting.
- deps: `picomatch ^4`, `ignore ^7`, `@types/picomatch ^4`.

## [0.16.1] — 2026-04-29

**Headline:** Fix a tool-loop regression on `deepseek-chat` introduced
by DeepSeek's V4 rollout. The model now returns non-empty
`reasoning_content` even with `extra_body.thinking.type = "disabled"`,
and the API rejects round-trips that drop the field
("reasoning_content in the thinking mode must be passed back to the
API"). Reasonix's whitelist-by-model in `assistantMessage()` was too
narrow — it stamped reasoning_content only for `deepseek-reasoner` /
`deepseek-v4-flash` / `deepseek-v4-pro`. Caught by re-running τ-bench
on v0.16.0: 24/24 reasonix runs were failing.

- fix(loop): `assistantMessage()` now preserves `reasoning_content`
  whenever the producer emitted non-empty content, regardless of the
  model name. The whitelist still applies to synthetic messages
  (empty stamp for thinking-mode endpoints) so non-thinking sessions
  stay clean.
- test(loop): regression case in `loop-r1-reasoning.test.ts` —
  deepseek-chat returning non-empty `reasoning_content` round-trips
  the field on the next request.
- bench(tau): full re-run on the fix — 100% pass · 90.2% cache hit
  (vs 32.8% baseline) · $0.000593 / task. Mean cost is ~62% lower
  than the 0.2.1 snapshot, mostly from DeepSeek's price moves.

## [0.16.0] — 2026-04-29

**Headline:** Mouse drag in the log now selects text directly, with the
log auto-scrolling when the drag hits the viewport edge. Releasing the
button copies the selection to the system clipboard via OSC 52 plus a
tempfile fallback for terminals that don't honor it. The whole flow
stays inside the alt-screen TUI — no more `/copy` dance to dump the
log to main buffer.

- feat(ui): app-owned mouse selection. Plain drag paints a reverse-
  video highlight across the selected rows; the selection follows
  scroll naturally because rows are tracked in absolute log-row
  coordinates, not viewport-relative. Dragging past the top or bottom
  edge of the content area starts a 60ms-tick auto-scroll that keeps
  extending the selection while the cursor stays at the edge.
  Releasing copies the plain-text rendering via OSC 52 (system
  clipboard) plus a `<tmpdir>/reasonix-clip-<ts>.txt` fallback for
  terminals or remote sessions that drop OSC 52. Shift+drag still
  bypasses tracking so the terminal's native selection remains
  available for visible-only copies.
- feat(infra): `stdin-reader` now surfaces `mouseDrag` (SGR button 32)
  and `mouseRelease` (tail `m`) events; previously dropped silently.
  `alt-screen` switches from mode 1000 (press/release only) to mode
  1002 (button-event tracking with drag motion).
- feat(ui): `log-frame` extends `AtomViewport` with `firstRowAbs` so
  the keystroke layer can map mouse coordinates back to absolute log
  rows. New `extractSelection(atoms, sel)` walks the cell grid and
  produces UTF-8 text honoring 2-wide chars (CJK / emoji) with ANSI
  styling stripped.
- chore(ui): `/copy` slash command, the `copyMode` lifecycle, the
  alt-screen exit + main-buffer dump, and the `setMouseTracking` /
  `isMouseTrackingOn` helpers all removed. The new flow doesn't need
  to leave alt-screen, doesn't pollute main scrollback, and doesn't
  have the "two histories stacked" bug the dump approach kept hitting.

## [0.15.0] — 2026-04-29

**Headline:** Event-log sidecar lands as a real kernel artifact and
gets its first consumer — `replay()` reads `events.jsonl` and runs
the same pure reducers `apply()` does in-process. First external
PR merged: deny-with-context, pressing Tab on a tool-confirm modal
lets the user type *why* they're refusing, forwarded to the model
verbatim. Comment policy now enforced by `tests/comment-policy.test.ts`
under `npm run verify`; companion sweep dropped 6.3k LoC of
module-essay docstrings, banner separators, and incident-history
narrative across 148 source files.

- feat(core): `events.jsonl` sidecar — every kernel `Event` is
  appended to `<session>.events.jsonl` next to the legacy
  `LoopEvent` log. Append-only, durable, no behavior change for
  in-process consumers. Unblocks the v0.14 architecture migration:
  any view (CLI, dashboard, replay) can now reconstruct state from
  the sidecar without the loop running.
- feat(core): `replay()` reads the sidecar and runs the same pure
  reducers as in-process `apply()`. First proof that the projection
  layer is genuinely deterministic — `replay(events)` matches
  `apply(...)` for the conversation / budget / plan / workspace /
  capabilities / status / session-meta views.
- feat(cli): `reasonix events <name>` — inspect any session's event
  stream from the command line. Filters by event variant
  (`reasonix events ToolCallStarted`), tail mode, JSON output for
  piping into `jq`. Plus a kernel sweep removing the dead-comment
  layer that accumulated during the LoopEvent → Event transition.
- feat(ui): deny-with-context (PR #1, by @wviana). On any tool-confirm
  modal (`ShellConfirm`, `WorkspaceConfirm`, edit review), pressing
  Tab on the Deny option opens inline editing — type a reason, Enter
  submits. The reason is appended to the synthetic `I denied
  running …` message so the model knows *why* and can adjust course
  instead of plowing ahead. Edit-review path uses a dedicated
  `DenyContextInput` modal (n hotkey opens the reason input, Esc
  returns to the diff). Bracketed-paste support in the inline editor
  so multi-line context can be pasted in one go.
- chore(ui): removed obsolete `/mouse` slash command and the
  misleading "drag to select & copy" prompt hint — both predated
  `/copy` and gave wrong guidance now that the proper flow is
  alt-screen-exit + scrollback dump.
- chore(comments): `tests/comment-policy.test.ts` pins six rules
  derived from `CLAUDE.md`: ≤2-line module headers, no Phase-N
  narrative, no version refs in comments, no incident history
  (`user reported`, `screenshot showed`, `fix for #N`), no banner
  separators (`// ─── helpers ───`), ≤3-line block comments. Runs
  under `npm run verify`, which is the pre-push gate. Companion
  sweep: 116 module-essay headers compressed to one line, 577
  over-long block comments distilled or deleted, 44 banner separators
  stripped. Net −6,367 LoC of dead-weight comments across 148 files;
  zero behavior change, full lint/typecheck/test green.

## [0.14.0] — 2026-04-29

**Headline:** Two real bug fixes (post-shell-confirm session lockup,
post-workspace-switch ENOENT on edit_file), a new `/copy` mode for
copying across multi-screen log content, an always-on context-pressure
footer above the prompt, and width-aware chrome that stops dropping
pills when there's clearly room. Plus a quiet refactor: shared UI
primitives, dead-code purge in StatsPanel.

- fix(loop): streaming-abort path now resets `_turnAbort` before
  returning. Without this, a queued-submit triggered by App.tsx
  (ShellConfirm "run once" → `loop.abort()` + `setQueuedSubmit`)
  produced a spurious `aborted at iter 0/64 — stopped without
  producing a summary` the moment the synthetic message reached
  the loop, locking the session until the user `/retry`'d.
- fix(tui): `edit_file` interceptor now reads the workspace root via
  `currentRootDirRef` instead of capturing `currentRootDir` in a
  stale closure. Workspace switch (`change_workspace` → modal approve)
  rebound `read_file` / `run_command` to the new root but left the
  interceptor pointing at the old one — `edit_file` wrote to the
  old path while `read_file` looked in the new one, surfacing as a
  mysterious ENOENT for a file the model had just successfully edited.
- feat(tui): `/copy` exits the alt-screen, dumps the rendered log to
  the main screen, and listens for any keystroke to restore. Native
  terminal scrollback + drag-select work on the dump — solves the
  "can't copy text that scrolled past the viewport" problem alt-screen
  introduced. Re-entering alt-screen and bumping React state forces
  Ink to redraw the TUI cleanly. Multiple enter/exit cycles per
  session; React tree, event log, model session, prompt draft all
  preserved across the toggle.
- feat(tui): always-on context-pressure footer above the prompt —
  `ctx ▰▰▰▱▱▱▱▱▱▱▱▱▱▱  14K/977K · 1%  ·  sys 5.8K  ·  tools 6.1K  ·  log 0`.
  Single-row layout matches the chrome bar's `▰▱` visual language.
  Width-aware shed for the breakdown segments (input → log → tools →
  sys). `/context` toggles visibility (default on); the rich
  4-color stacked breakdown is still pushed to scrollback for
  headless / replay surfaces that don't carry the toggle callback.
- feat(tui): chrome bar pill rendering switches from preemptive
  `narrow = cols < 120` to width-aware greedy shed. Optional pills
  (balance > cache > session > update) drop in priority order only
  when `string-width` math says they won't fit — at 100 cols all
  five render where the old code dropped three. Cache pill is now
  default-on (cold-start dim treatment instead of hiding).
- refactor(ui): `Bar`, `formatTokens`, `ChromeRule`, `ContextCell`
  promoted to `src/cli/ui/primitives.tsx` (were duplicated 2-3× across
  `StatsPanel` / `ChromeBar` / `EventLog` / `log-frame`). `CtxBreakdownBlock`
  + `computeCtxBreakdown` extracted to `src/cli/ui/ctx-breakdown.tsx`
  so `/context` and the footer share the same compute path. `StatsPanel`
  shrunk from 769 → ~280 lines (dead helpers from the chrome
  redesign era removed).
- feat(core): v0.14 architecture scaffold — `src/core/events.ts`
  (25-variant Event union + 7 view types), `src/core/reducers.ts`
  (pure projections + `apply` / `replay` combinators), `src/ports/*.ts`
  (6 ports: ModelClient, ToolHost, EventSink, MemoryStore, HookRunner,
  CheckpointStore). Types only; zero behavior change. 19 reducer tests
  pin the conversation / budget / plan / workspace / capabilities /
  status / session-meta projections and prove `replay()` determinism.

## [0.13.5] — 2026-04-29

**Headline:** TUI overhaul. Chrome reverts to native Ink Box +
flexGrow (Phase 6a's Frame-compiler chrome was clipping pills on
Windows Terminal / ConPTY). Vertical scrollbar replaced with a
`[↑ N%]` chrome pill + horizontal mini-bar in the bottom hint —
column-aligned scrollbars are unreliable while some log atoms
still render through legacy ReactElements. Streaming gains the
design's `responding ░▒▓█▓▒░░░░` marquee and a `▌` cursor blink
at end-of-body.

- chrome: `ChromeBar` uses native flex; preset pill (`[auto]` /
  `[flash]` / `[pro]`) replaces edit-mode pill (edit mode still
  surfaces via `ModeStatusBar`); CNY balance renders as `w ¥8.50`;
  cost pill includes inline budget when set.
- streaming: full body text streams in (was 140-char tail) with a
  blinking primary-color cursor; `responding` row shows a 12-cell
  marching wave (`░▒▓█▓▒`) at 120ms ticks. Matches
  `design/tui-redesign-ink.html`.
- scroll: vertical `ScrollBar` removed; chrome shows `[↑ N%]` when
  scrolled, `BottomHint` shows `↑ N · ▕──●──▏ X% · ↓ M · End`.
- frame: `src/frame/width.ts` delegates to the `string-width`
  package; hand-rolled width tables removed.
- chore: project `CLAUDE.md` codifies code/comment conventions
  (terse comments, no Phase-N essays, libraries over hand-rolled
  unicode math).

## [0.12.15] — 2026-04-28

**Headline:** Every user-facing string that still said
`fast / smart / max` is now `auto / flash / pro` — the canonical
names presets have used since the autoEscalate split. CLI flags
(`chat --preset`, `run --preset`), `/help`'s preset table,
`/preset`'s argHint and completer, the slash handler's `usage:`
line, and the `code` command description all updated.

Old `config.json` files keep working: `resolvePreset` still maps
`fast → flash·effort=high`, `smart → auto`, `max → pro`. What
changed is the interactive surface — `/preset fast` now prints
usage instead of silently doing the right thing, so the in-chat
vocabulary matches what's documented.

## [0.12.14] — 2026-04-28

**Headline:** Three TUI confirmations the dashboard couldn't see —
`change_workspace`, plan checkpoints, plan revisions — now mirror to
the web modal layer with the same Switch/Deny/Continue/Revise/Stop/
Accept/Reject choices the terminal exposes. Plus: a deferred-dispatch
fix for parallel tool calls that was silently writing files into the
old workspace, and the in-flight row finally tells you _what tool_ is
running, not just "waiting".

### Loop — workspace-switch parallel-batch fix

When DeepSeek emits `change_workspace + write_file` in one assistant
message, every call dispatched in sequence — write_file fired against
the OLD sandbox before the user had a chance to approve the modal,
silently dropping the new file in the wrong project. Every subsequent
call in the same batch now gets a synthetic "deferred — re-issue on
your next turn" result; tool_call ↔ tool pairing stays valid for
DeepSeek's next-turn validator. Test in `tests/loop.test.ts` locks it.

### Server / context

- `ActiveModal` gains three new shapes: `workspace`, `checkpoint`,
  `revision`. `getActiveModal` returns them so a freshly-connected
  client paints the right modal mid-prompt.
- `DashboardContext` adds `resolveWorkspaceConfirm`,
  `resolveCheckpointConfirm` (with optional `text` for revise-with-
  feedback in one shot), and `resolveReviseConfirm`.
- `/api/modal/resolve` accepts the three new `kind`s with their
  per-shape choice validation. 503 when a resolver isn't wired.

### App.tsx wiring

- `pendingWorkspace`, `pendingCheckpoint`, `pendingRevision` each
  broadcast `modal-up`/`modal-down` SSE events.
- Web's "revise + feedback in one shot" path bypasses the TUI's
  staged-input two-step by accepting an explicit snap override on
  `handleCheckpointReviseSubmit` — no more setStagedX → re-render →
  ref-mirror microtask race.

### Dashboard SPA

- New `WorkspaceModal`, `CheckpointModal`, `RevisionModal` Preact
  components. Modal switch dispatches them by `modal.kind`.
- In-flight row now shows the active tool + key args (path / command
  truncated to 80 chars / char count) once `tool_start` fires —
  `write_file → /path/to/foo (12,345 ch)` instead of "waiting…".
- Tool-start no longer pushes a placeholder info row. The InFlightRow
  carries the live state; the result card replaces it on `tool`.
- ErrorBoundary stops auto-recovering after 3 catches and renders a
  manual "Try again" button — no more silent flickering loop.
- `.modal-cmd` gets `overflow-x: auto` + `max-height: 240px` so a
  pathological multi-kilobyte command can't push the rest of the
  panel offscreen.

## [0.12.13] — 2026-04-28

**Fix:** the chat feed kept yanking the user back to the bottom
during streaming — wheel-up didn't stick. Two bugs stacked:

1. The scroll listener attached to `document.querySelector(".chat-feed")`
   on first mount, but the `.chat-feed` div was conditionally
   rendered (only when at least one message existed). On a fresh
   session the listener never attached, so the "is the user
   scrolled away?" flag was never flipped to `false`.
2. Even after the listener attached, the auto-scroll effect's
   own `el.scrollTop = el.scrollHeight` write fires a `scroll`
   event that re-snaps the flag back to `true`. Manual wheel
   scrolls were racing the next streaming delta's auto-snap.

Both fixed:

- `.chat-feed` is now always rendered (the empty-state copy
  moved inside it). A `feedRef` ref attaches the scroll
  listener on first paint.
- A new `autoScrollInFlight` ref gates the listener: events
  observed during a programmatic scroll write are ignored, so
  only genuine user wheel/drag flips the auto-scroll guard.

## [0.12.12] — 2026-04-28

**Headline:** Indexing from the dashboard now actually wires up
`semantic_search` for the running session — no more "build the
index, restart, build again" dance — and a dismissible Chat
banner steers users to the Semantic panel when no index exists.

### Loop / prefix

- `ImmutablePrefix` gains an `addTool(spec)` method that pushes a
  new tool spec onto the live prefix. The class name is now a
  half-truth (toolSpecs is exposed via getter, backed by a mutable
  array) but the rationale is documented inline: a one-time cache
  miss is cheaper than asking users to restart the session.
- New `DashboardContext.addToolToPrefix(spec)` callback. Wired
  from `App.tsx` to `loop.prefix.addTool`.

### Server

- `runIndex` (the dashboard's buildIndex wrapper) calls
  `registerSemanticSearchTool(ctx.tools, …)` after a successful
  build, then `ctx.addToolToPrefix(spec)` so the model sees
  `semantic_search` from the next turn. Failures are non-fatal —
  the index is still on disk, the next session bootstrap picks
  it up.
- `/api/overview` returns `semanticIndexExists` (`true`/`false`/
  `null`) so the Chat panel can render the banner without an
  extra round-trip.

### Dashboard — Chat panel

- New top-of-Chat banner: `≈ Semantic search isn't enabled for
  this project — Build it →` with a dismiss `×`. Visible only
  when `semanticIndexExists === false` and not previously
  dismissed (state in `localStorage` as `rx.semanticBannerDismissed`).
- Click "Build it →" fires `appBus.dispatchEvent("navigate-tab")`
  with `tabId: "semantic"` — the existing nav handler picks it up.

## [0.12.11] — 2026-04-28

**Headline:** Tell users what to do when Ollama isn't installed
yet. The 0.12.9 Semantic panel just said "not reachable" with a
generic copy-this-command blurb — the new flow distinguishes
"binary missing" from "daemon down" from "model not pulled" and
offers a one-click action for each level it can resolve.

### Server

- `GET /api/semantic` now returns the full `checkOllamaStatus`
  payload — `binaryFound`, `daemonRunning`, `modelPulled`,
  `modelName`, `installedModels` — instead of the raw probe.
- New endpoints:
  - `POST /api/semantic/ollama/start` — runs `startOllamaDaemon`
    (15s timeout). Returns `{ ready, pid }`.
  - `POST /api/semantic/ollama/pull` — fire-and-forget
    `pullOllamaModel`. Per-model `PULLS` map tracks status +
    last log line; `/api/semantic` includes it as `pull`.

### Dashboard — Semantic panel

Tri-state Ollama section:
- **No binary** → red "not installed" pill + Install Ollama
  card with macOS / Windows / Linux install instructions. We
  deliberately don't run package managers for the user.
- **Binary, daemon down** → yellow "daemon down" pill + "Start
  daemon" button (calls `ollama/start`).
- **Daemon up, model missing** → "not pulled" pill + "Pull
  <model>" button. Live status row during the pull (latest
  ollama output line, elapsed seconds, success/error pill).
- **Everything ready** → green pill, Index buttons enable.

Polling speeds up to 1.2s while a pull or build job is running.

## [0.12.10] — 2026-04-28

**Headline:** Move the in-flight indicator out of the top-left
corner and put the live counters next to it. Previously the
spinner appeared above the message stream — far from where the
user's eyes already were (input + status bar) — and the only
moving signal during a turn was the streaming text itself.

### Chat panel

- New **InFlightRow** rendered just above the ChatStatusBar
  whenever a turn is in flight. Format:
  `⠋ thinking · 2.3s · reasoning 1,204 ch · out 0 ch · [Abort]`
- Phase auto-flips between `thinking` (only reasoning growing),
  `streaming` (text growing), and `waiting` (neither — model is
  thinking with no token output yet, e.g. before the first
  delta arrives).
- Elapsed seconds tick every 500ms via a per-turn interval so
  the user sees motion even when the model is in a long pause
  between deltas.
- Character counts come from the existing `streaming` state — no
  new wire fields, just rendering data we already have.
- Top "turn in flight" row is gone; only `statusLine` notices
  still render up there when not busy.

## [0.12.9] — 2026-04-28

**Headline:** Semantic indexing without leaving the session.
Previously you had to exit the TUI, run `reasonix index`, wait,
then re-enter — every change. Now there's a Semantic panel in
the dashboard that drives `buildIndex` in the background and
shows live progress.

### Server

- `src/server/api/semantic.ts` — new endpoint set:
  - `GET  /api/semantic`        → Ollama probe + index existence
                                   + current job snapshot
  - `POST /api/semantic/start`  → kick off `buildIndex({ rebuild })`
                                   fire-and-forget, returns 202
  - `POST /api/semantic/stop`   → flag job as aborting (advisory;
                                   `buildIndex` doesn't honor a
                                   signal yet, lands when it does)
- Per-root `JobRecord` map (module-scoped) tracks phase
  (scan/embed/write/done/error) + counters (filesScanned,
  chunksTotal, chunksDone, …) updated via `onProgress`.

### Dashboard

- New **Semantic** sidebar tab. Polls `/api/semantic` every 1.2s
  while a job is running, every 5s when idle.
- Surfaces Ollama daemon reachability + listed models, current
  index existence, and the live job: phase pill, file/chunk
  counters, percentage progress bar, elapsed seconds, last
  result on completion, error text on failure.
- Buttons: **Index (incremental)**, **Rebuild (wipe + full)**,
  **Stop**. Disabled appropriately when Ollama isn't reachable
  or another job is running. Inline guidance on missing daemon.
- Standalone `reasonix dashboard` mode shows a polite "code-mode
  required" empty state — no project root, nothing to index.

## [0.12.8] — 2026-04-28

**Fix:** the dashboard row in 0.12.7 collapsed the URL and
description onto one Box; on terminals that hide the OSC 8
escape, Ink's text-width measurement counted the escape bytes
as visible characters and the description wrapped through the
middle of the URL. Split into two stacked rows:

```
◇ web   open the dashboard in a browser (chat · files · stats · settings)
        http://127.0.0.1:NNNN/?token=…
```

URL still wrapped in the OSC 8 hyperlink — but it's the only
content on its row, so a width miscount can't clobber anything.

## [0.12.7] — 2026-04-28

**Headline:** Dashboard discoverability. Most users had no idea
`/dashboard` existed — the URL is now visible from the first turn,
on its own row in the status panel, with a one-line description of
what the dashboard actually offers. Clickable in OSC-8-aware
terminals (iTerm2, WezTerm, Windows Terminal, VS Code, recent
gnome-terminal); copy-pasteable everywhere else.

### TUI

- Auto-launch the embedded dashboard when `reasonix code` /
  `reasonix chat` mount. Failures are silent (a missing dashboard
  never blocks the TUI), tear-down still happens on unmount /
  `/dashboard stop`.
- `--no-dashboard` opts out per-session (CI, hardened
  environments, anyone allergic to a localhost listener).
- New status-panel row:
  `◇ web   http://127.0.0.1:NNNN/?token=…   open the dashboard
  in a browser (chat · files · stats · settings)`
  rendered between the header and the metrics so it never fights
  for space.
- URL wrapped in an OSC 8 hyperlink — Cmd/Ctrl-click in any
  terminal that supports the escape; bare text otherwise.
- `App` gains a `noDashboard` prop, `StatsPanel` a `dashboardUrl`
  prop. Both threaded through `chatCommand` / `codeCommand`.

## [0.12.6] — 2026-04-28

**Headline:** Bigger fixes for the things you actually look at:
the edit-review modal is now a real side-by-side diff, the
sidebar collapses to icons, and the call-storm breaker stops
mistaking legitimate read → edit → verify cycles for storms.

### Edit review modal

- Two-column **side-by-side diff** ("before" left, "after" right)
  with hljs syntax highlighting per the file's language. Adjacent
  removed/added line runs pair into rows so the change reads
  cleanly across the gutter.
- Red tint + `−` marker on the removed side; green tint + `+` on
  the added side; context lines render unchanged.
- Modal payload (`{ kind: "edit-review" }`) gained `search` and
  `replace` fields holding the full block contents — the old
  truncated `preview` string stays alongside for older clients.
  `src/cli/ui/App.tsx` and `src/server/context.ts` updated.

### Sidebar — icon-only collapse

- New `◀ collapse` button at the bottom of the sidebar shrinks
  it from 220px → 52px and hides every label, leaving just the
  glyphs. `▶ expand` brings labels back. Choice persists in
  `localStorage` (`rx.sidebarCollapsed`).
- Tabs in the collapsed state center the glyph and keep the
  primary-color active indicator.

### Call-storm breaker — false-positive fix

The `read → edit → verify → edit → verify` pattern was tripping
the storm protection (3 identical `read_file` calls within the
window). The fix sources its "did this call mutate state?"
signal from the existing ToolRegistry — each tool already
declares `readOnly` / `readOnlyCheck` for plan-mode gating, so
no new flag was added. The breaker now:

- Tags every buffer entry as read-only or mutating based on the
  predicate the loop wires in (`def.readOnly === true`, with
  `readOnlyCheck` taking precedence on the actual args).
- On a mutating call, drops prior read-only entries from the
  window — a re-read after `edit_file` is fresh, not a repeat.
- Keeps mutator entries alongside, so a model looping on
  identical `edit_file` calls still trips on the threshold.

`StormBreaker(window, threshold, isMutating?)` is the public
shape; `ToolCallRepair` accepts an `isMutating` predicate.
Without one (older callers, isolated tests) every call counts —
back-compat preserved. Three new storm tests cover the cases.

## [0.12.5] — 2026-04-28

**Headline:** Stop loading CodeMirror from a CDN, fix the legacy
preset migration that broke 2 CI tests, and replace the markdown
preview toggle with a proper Edit / Split / Preview tri-state.

### Editor — local CodeMirror bundle

- `scripts/bundle-codemirror.mjs` — esbuild-based bundler that
  pulls every `@codemirror/*` package from `node_modules` and
  produces `dashboard/codemirror.js` (~937 KB minified ESM).
- `npm run build:cm` rebuilds it. Output is committed so a fresh
  `npm install` doesn't have to run esbuild.
- `dashboard/app.js` now does `import("/assets/codemirror.js")`
  instead of 21 `import("https://esm.sh/...")` calls. One copy of
  every package = no Tag identity issues, no transitive-version
  drift between cold loads.
- `serveAsset` learns to serve `codemirror.js`. `package.json`
  ships the bundle in `files`. Biome ignores the minified file.
- `@codemirror/*` + `esbuild` added to devDependencies — they
  feed the bundler, they don't end up in the runtime install.

### Editor — markdown view modes

- Replaced the `Preview`/`Edit` boolean with a three-state
  segmented control: **Edit** (source only, default), **Split**
  (source on the left, rendered on the right, with a divider),
  **Preview** (rendered only). Buttons live in the editor bar
  and are markdown-only — non-md tabs hide the group entirely.
- The CodeMirror remount effect now keys on `viewMode`, so
  flipping between Edit and Split doesn't leave a stale view.

### Preset rework — CI fix

`resolvePreset` was collapsing every legacy name (`fast`, `smart`,
`max`) to `auto`, which made two `tests/resolve.test.ts` cases
fail because they assert the legacy mapping that older config
files depend on. Restored the original semantics:
- `fast` → flash with `effort: high` (no auto-escalate)
- `smart` → auto (flash + max + auto-escalate)
- `max` → pro
Anything else still collapses to auto. Suite back to 1568 / 1568.

## [0.12.4] — 2026-04-28

**Headline:** The two real editor problems that 0.12.2/3 didn't
actually fix: highlighting was still missing for every language,
and the new markdown preview produced a half-rendered page where
the bottom got dumped into a `<pre>`.

### Editor

- **Pin `@lezer/highlight` + `@lezer/common` in the esm.sh
  `?deps=` list.** The silent-no-highlights failure was caused by
  duplicated `@lezer/highlight` instances across CodeMirror
  packages: `tags.keyword` etc. are JS objects compared by
  identity, so when the language pack and the theme each loaded
  their own copy, the parser produced tags the theme didn't
  recognize, and all coloring quietly went away. Pinning common
  + highlight forces every package to share one set.
- **Separate `Marked` instance for the markdown preview
  (`previewMarked`).** The chat renderer is loaded with custom
  `code` handling for SEARCH/REPLACE diffs and edit:foo/path
  fence syntax — that ran on every preview too, occasionally
  swallowing the rest of the document into one `<pre>` block on
  certain inputs. Preview now uses a vanilla marked + a slim
  hljs-only `code` override.

## [0.12.3] — 2026-04-28

**Headline:** Editor as a first-class sidebar tab. The drawer was
the only way in, which meant you had to start a chat and click a
file path before you could browse anything. Now there's a sidebar
entry that opens the file tree directly.

### Editor

- New **Editor** tab in the sidebar (after Chat). Mounts the
  `EditorPanel` full-width inside `.main` — same file tree,
  tabs, CodeMirror — no drawer chrome.
- `.main` gets a `main-editor` modifier when the editor tab is
  active, dropping the 28×36 panel padding and letting the
  editor fill the viewport.
- The chat drawer entry point still works (clicking a path in a
  tool card slides the drawer in over the current tab). Drawer
  and sidebar Editor are separate instances; their tab state
  doesn't share yet — revisit if it becomes annoying.

## [0.12.2] — 2026-04-28

**Headline:** Editor polish pass. Tabs at the top span the full
editor width like VS Code, syntax highlighting actually shows up,
the gutter/line numbers match the dark theme, autocomplete pops
on every keystroke instead of waiting for a manual trigger.

### Editor

- **Tabs on top, full width** — moved out of `.editor-main` and
  into a sibling `.editor-tabs` that sits above the side+main
  body row. Active tab gets a primary-color top border and the
  editor's own background, so it visually merges into the code
  surface (VS Code pattern). The file panel can collapse and the
  tab bar stays put.
- **Highlighting works** — `oneDark` already ships its own
  HighlightStyle; the existing `defaultHighlightStyle` wrap was
  fine but ordered before `oneDark`, so it didn't cover languages
  oneDark misses. Reordered to fall back AFTER oneDark and added
  `highlightActiveLineGutter` so the active row stands out in the
  gutter too.
- **Gutter restyled** — `.cm-gutters` gets a darker `#21252b`
  background, line numbers use the muted `#495162` for inactive
  rows and `#abb2bf` for the active row, with a 40px min-width
  and 16px right-padding. Fold gutter ships alongside (click the
  arrow next to a brace to fold).
- **Autocomplete** — `autocompletion({ activateOnTyping: true,
  closeOnBlur: true, maxRenderedOptions: 30 })` so suggestions
  pop while you type. Added `completionKeymap` so Tab/Enter pick
  the highlighted entry. Popup styled to the dark palette.
- **Tab close ergonomics** — close button has a fixed 18px box
  so the tab doesn't jump width when the dirty dot toggles.

All edits in `dashboard/app.js` `EditorPanel` + `dashboard/app.css`.

## [0.12.1] — 2026-04-28

**Headline:** Editor v2 — VS Code-style file tree, collapsible file
panel, wider drawer. The 0.12.0 editor opened on the right at 50%
with a flat alphabetical file list; on a normal-width window that
felt cramped and the file list scrolled forever.

### Editor

- **File tree** — flat path list collapses into a recursive folder
  tree. Folders sort first, files alphabetically; click `▶` to
  expand, `▼` to collapse. The expanded set lives in panel state so
  it survives drawer close/reopen within a session.
- **Collapsible side panel** — `◀` button at the top of the file
  panel hides everything except a thin `▶` button that brings it
  back. Editor area gets the full drawer width when files are out
  of the way.
- **Wider drawer** — `.editor-drawer-host.open` bumped from 50% →
  65% (min-width 360 → 420) so the editor breathes.
- **Filter still flat** — when the search box has text, the tree
  view collapses to the existing flat filtered list (paths are
  more useful than indented names when you're searching).

No backend changes. All edits in `dashboard/app.js` `EditorPanel`
+ `dashboard/app.css`.

## [0.12.0] — 2026-04-28

**Headline:** Web dashboard. A top-tier local control plane that lives
alongside the TUI — chat, files, MCP, skills, hooks, settings, all on
one URL. Plus auto/flash/pro preset rework so model commitment is
something you actually understand.

### Web dashboard (`/dashboard` slash)

A full-screen browser app, embedded HTTP server, 12 panels, modal
mirroring back to the live TUI. 127.0.0.1 only, ephemeral token in
the URL, CSRF on every mutation.

**Foundation (v0.12 base)**
- HTTP server in `src/server/` — Node native `http`, zero new deps
- Token + CSRF auth, audit log per mutation
- Preact 10 + HTM SPA (no build step), CSS lifted from `src/cli/ui/theme.ts`
- 12 panels, all functional: Chat / Overview / Usage / Sessions /
  Plans / Tools / Permissions / System / MCP / Skills / Memory /
  Hooks / Settings

**Chat parity (v0.13a)**
- POST `/submit` routes through `handleSubmit` so slash commands,
  `!cmd`, `@path` work identically; SSE `/events` streams loop
  events live; `/abort` mirrors Esc; `/messages` snapshots the
  log; `/modal/resolve` lets web pick a ShellConfirm /
  ChoiceConfirm / PlanConfirm / EditConfirm — either surface
  resolves, the other's modal disappears
- Web: marked.js + highlight.js 38-language pack, GFM tables,
  custom diff renderer for SEARCH/REPLACE blocks (red `-` / green
  `+`) and unified diffs, kind-specific tool cards (edit_file,
  read_file, write_file, run_command), markdown-styled assistant
  messages with reasoning blockquote, blinking cursor while
  streaming, scroll lock when user reads above bottom, custom
  scrollbars in brand palette

**Observability (v0.13b)**
- Sessions browser — list / read any saved session
- Plans archive — replay archived plans with risk pills
- Usage time-series chart (uPlot) — daily cost / cache-saved / turns
- System health — disk usage, version check, jobs

**Mutation surface (v0.14)**
- MCP — list bridged servers + add/remove specs to config
- Skills — list, edit body, create new, delete
- Memory — REASONIX.md + global / project private memory editor
- Hooks — settings.json hook block editor + reload
- Settings — API key (write-only), base URL, preset, effort, search

**Polish (v0.15)**
- Mobile responsive: sidebar collapses to drawer with hamburger,
  metric grid drops to 2 columns, header stacks vertically
- Animations: fade-in for messages, slide-in for modals + toasts,
  `prefers-reduced-motion` respected
- Toast system (top-right, auto-dismiss)
- Global error overlay — `window.error` + `unhandledrejection` +
  Preact ErrorBoundary all funnel into a full-screen card with
  copy-details + "Report on GitHub" prefilled-issue button

**Editor drawer (post-v0.15)**
- Click any path in chat tool cards → CodeMirror 6 drawer slides
  in from the right (50% width, full-screen on mobile)
- Multi-tab, dirty flag, Cmd/Ctrl+S save, syntax highlighting in
  14 languages, gitignore-aware file picker
- Drawer state persists across sidebar tab switches

**Live status bar (in Chat)**
- model · ctx token gauge · cache hit % · turn cost · session
  cost · DeepSeek balance — 2.5s poll, mirrors TUI StatsPanel

**Live mode pickers (in Chat)**
- Edit mode (review/auto/yolo) — instant
- Effort (high/max) — applies next turn, also flippable from `/effort`
- Preset (auto/flash/pro) — applies next turn via `applyPresetLive`
- New / Clear conversation buttons (route through `/new` and `/clear`)

### Preset rework — auto / flash / pro

**Headline:** old `fast / smart / max` collapsed into model-commitment
vocabulary that actually says what it does.

- **`auto`** — flash baseline, auto-escalates to pro on
  `<<<NEEDS_PRO>>>` markers or after 3+ tool failure signals.
  The default — covers ~96% of turns at flash cost.
- **`flash`** — flash always. No auto-escalation. `/pro` still
  works for one-shot manual escalation.
- **`pro`** — pro always. No downgrade. ~3× flash at the 5/31
  discount window, ~12× outside it.

`autoEscalate: boolean` added to the loop (constructor + reconfigure)
gates both auto-escalation paths (NEEDS_PRO marker scavenge +
failure-count threshold). `flash` and `pro` presets pass `false`,
locking the running session to one model.

Legacy `fast / smart / max` names: still parse from existing
config files but collapse to `auto` — simpler than mapping the old
semantics onto the new vocabulary, user re-picks if they want flash
or pro explicitly.

`applyPresetLive` callback in `DashboardContext` flips the live
loop's model + autoEscalate + reasoningEffort the moment the user
clicks a preset in the web Chat picker — no session restart.

### Other

- `cacheSavingsUsd(model, hitTokens)` in `src/telemetry.ts` — USD
  the prompt cache shaved off the bill (miss-price minus hit-price
  for cached tokens). Surfaced in `reasonix stats` dashboard +
  `/api/usage` rolled buckets + the Usage chart.
- Built-in shell allowlist (`BUILTIN_ALLOWLIST`) re-exported for
  the dashboard's Permissions panel listing.
- `removeProjectShellAllowed` + `clearProjectShellAllowed` in
  `src/config.ts`.
- StreamableHttpTransport (MCP 2025-03-26) — already shipped in
  0.11.3 but documented here for completeness; this release adds
  the Mcp panel UI on top.
- `DashboardEvent` + `ActiveModal` types exported from
  `src/server/context.ts` for downstream tooling.

### Tests

1568 vitest tests pass. New test files: `tests/server-dashboard.test.ts`
(40 tests covering auth/CSRF, every endpoint shape, SSE round-trip,
mid-modal mutations).

## [0.11.3] — 2026-04-27

**Headline:** Two long-deferred items land — `/permissions` makes the
shell allowlist auditable and editable from inside the TUI, and
Streamable HTTP MCP transport (2025-03-26 spec) clears the last debt
from the v0.3 deferred queue.

### Added

- **`/permissions`** — list / add / remove / clear the shell
  allowlist without leaving the session. Bare `/permissions` shows
  the current edit mode (review / auto / yolo with a yolo-bypasses-
  allowlist banner), the per-project entries with 1-based indices,
  and the read-only builtin list grouped by leading verb. Subcommands:
  `/permissions add <prefix>` (multi-token OK), `/permissions remove
  <prefix-or-N>` (literal match or list index), `/permissions clear
  confirm`. Refuses to add a prefix that's already in the builtin
  list (no redundant project entry) and refuses to remove a builtin
  (read-only). Mutating subcommands require code mode. `perms`
  registered as alias.
- **`removeProjectShellAllowed` + `clearProjectShellAllowed`**
  exported from `src/config.ts`. The remove helper does literal-
  prefix match (not prefix-of-prefix), so dropping `git` doesn't
  accidentally remove `git push origin main` if both were stored.
- **MCP Streamable HTTP transport (2025-03-26 spec)** —
  `src/mcp/streamable-http.ts` implements the new single-endpoint
  protocol. POSTs JSON-RPC frames, handles all three response shapes
  (202 Accepted for notifications, `application/json` for single
  responses, `text/event-stream` for multi-frame streams covering
  progress + response). Captures `Mcp-Session-Id` from the first
  response that hands one out and echoes it on every subsequent
  request; surfaces 404-with-session as a "session expired" error
  so callers know to reinitialize. Long-lived GET stream for
  unsolicited server-initiated frames is deliberately deferred —
  POST-only handles full request/response/notification traffic
  for every server we'd realistically point at today.
- **Spec parser** — `streamable+http(s)://` prefix routes to the
  new transport (`{ transport: "streamable-http", url, name }`).
  Plain `http(s)://` still routes to SSE (2024-11-05) so existing
  `--mcp` config entries keep working without surprise upgrades.
  Wired through `chat.tsx`, `run.ts`, and `reasonix mcp inspect`.
  Public API gains `StreamableHttpTransport` + the
  `StreamableHttpMcpSpec` type re-export.

### Tests

- `tests/permissions-slash.test.ts` — 16 tests covering listing,
  add, remove (by prefix and by 1-based index), clear, mode banner,
  builtin-collision rejection, codeRoot guard, alias.
- `tests/config.test.ts` — 6 new tests for `removeProjectShellAllowed`
  / `clearProjectShellAllowed` (literal-only matching, scoping per
  project, idempotent counts).
- `tests/mcp-streamable-http.test.ts` — 8 tests against an in-process
  `http.Server` fake that speaks the 2025-03-26 wire shape: JSON
  response delivery, 202 ack as no-op, session-id capture+echo,
  multi-frame SSE ordering (progress → response), full McpClient
  initialize → tools/list round-trip, 404+session = "expired",
  500-as-error from `send()`, `close()` unblocks idle iterators.
- `tests/mcp-spec.test.ts` — 4 tests for the new prefix parsing.

1521 tests pass (+24). Lint / typecheck / build clean.

## [0.11.2] — 2026-04-27

**Headline:** `/init` synthesizes a baseline REASONIX.md so a new
project starts with context instead of cold. Closes the gap with
Claude Code's `/init`, scoped to the structure REASONIX expects.

### Added

- **`/init`** — model-driven REASONIX.md generator. The slash
  emits a structured user-turn prompt (via the `resubmit` channel)
  that hard-constrains the model to a fact-only document with
  Stack / Layout / Commands / Conventions / Watch out for sections,
  capped at 80 lines / 3KB so REASONIX.md doesn't bloat the system
  prompt every launch. Reuses the existing filesystem tools (no new
  pipeline) and the result lands as a pending edit in the normal
  review queue, so the user audits before it hits disk. Refuses to
  overwrite an existing REASONIX.md without `/init force`. Removes
  the friction of having to hand-author a project memory file.

## [0.11.1] — 2026-04-27

**Headline:** Workspace-switching, end to end. Four real-use bugs
that all hit the same scenario — `Esc` poisoned the next turn,
Chinese-Windows shell errors came back as mojibake, the markdown
renderer ate `\TEST` out of `F:\TEST1`, and the model had no idea
how to change directories. Plus two new ways to do it: `/cwd <path>`
the user types, and `change_workspace` the model calls (always
gated on an explicit confirmation modal — no auto-switching).

### Fixed

- **`Esc` poisoned the next turn.** The loop's user-Esc abort branch
  processed the cancel correctly but left `_turnAbort` in an aborted
  state on its way out. The carry-abort logic at `step()` entry then
  re-aborted at iter 0 on every subsequent turn, so the user typed
  a fresh prompt and saw "stopped without producing a summary"
  before any model call ran. The session was effectively dead until
  restart. Fix: reset `_turnAbort` to a fresh controller before
  returning from the abort branch — the across-turn race that the
  carry logic guards against still works because a new `abort()`
  fired between turns aborts the new controller. Regression test
  added (`tests/loop.test.ts`).
- **Mojibake on Chinese / Japanese / Korean Windows shell errors.**
  `runCommand` decoded child output as UTF-8 incrementally per
  chunk. Two failure modes:
  1. `cmd.exe`'s OWN error messages (e.g. "'sed' is not recognized
     as an internal or external command") come from a localized
     resource DLL and ignore `chcp 65001`, so on Chinese Windows
     the bytes are CP936/GBK and decoded as UTF-8 produced
     unreadable garbage.
  2. Multi-byte sequences could split across chunk boundaries and
     corrupt before the second half arrived.
  Fix: collect raw `Buffer[]` chunks and decode once at close via
  a new `smartDecodeOutput` — strict UTF-8 first; on Windows fall
  back to GB18030 (GBK superset) when UTF-8 rejects the bytes;
  last resort lossy UTF-8 keeps the structural exit-code marker
  intact. PowerShell's existing `injectPowerShellUtf8` prelude
  still covers the PS path; this fixes the path where the model
  invokes a native EXE directly (`run_command sed …`).
- **Markdown renderer ate `\TEST` out of `F:\TEST1`.** `stripMath`'s
  catch-all LaTeX command stripper (`\\[a-zA-Z]+` → `""`) deleted any
  backslash-followed-by-letters sequence — fine for an invented
  `\textbf{…}` the model emitted, catastrophic for Windows paths in
  prose. `F:\TEST1` rendered as `F:1`. Fix: gate the entire
  `stripMath` pipeline on a math-marker pre-check (`$`, `\(`, `\[`,
  known LaTeX commands, `^{…}`/`_{…}`, Pandoc super/subscripts). When
  none are present we return the string untouched. Mixed inputs (a
  path AND real math in the same message) still run the pipeline —
  math correctness wins over path preservation in that rare collision.
- **Model didn't know `/cwd` existed.** When asked to switch to a
  project on another drive, the model fumbled with `pwd`,
  `cd /d F:\TEST1`, and `2>&1` shell tricks (none of which work —
  `cd` doesn't carry across `run_command` calls and `2>&1` is rejected
  as a shell operator by design). The code-mode system prompt now has
  a "When the user wants to switch project / working directory"
  section telling the model to surface `/cwd <path>` once and stop,
  instead of trying to do it itself.

### Added

- **`change_workspace` tool** — model-callable workspace switching,
  gated on a confirmation modal. The tool fn validates the target,
  resolves it (absolute / `~`-expanded / relative-to-launch-cwd), then
  always throws a `WorkspaceConfirmationError` with the absolute
  path. App.tsx detects the marker and mounts a Switch / Deny modal;
  on approval it calls the same `applyCwdChange` path that drives
  `/cwd` (re-registers filesystem / shell / memory tools, reloads
  hooks, syncs the loop's hookCwd). On denial the model gets a
  synthetic "user refused, continue without it" message. No
  "always allow" option — workspace switches are per-target by
  nature. The code-mode system prompt now tells the model to call
  this tool (rather than fumble with `cd /d`) when the user asks
  to change projects, and to STOP after the call instead of chaining
  more tools before the user has confirmed.
- **`/cwd <path>`** — switch the session's working directory mid-
  session. Validates the target (must exist, must be a directory),
  expands `~`, then atomically: updates the hook cwd, memory root,
  project shell allowlist, `@file` mention root, and re-registers
  filesystem / shell / memory / `run_skill` tools against the new
  path so file reads, edits, and shell commands all land in the
  new sandbox. MCP servers stay anchored to the original cwd
  (their stdio child was spawned with the launch root and there's
  no standard reconnect handshake) — the slash output flags this
  explicitly when MCP servers are present. The system prompt's
  gitignore-aware project tour is also frozen at launch so the
  prefix cache stays valid; the slash output notes it for users
  switching to a structurally different project.

## [0.11.0] — 2026-04-27

**Headline:** Local semantic search lands as an opt-in pillar — Ollama-
backed embedding index, `reasonix index` CLI with progress spinner, a
`/semantic` slash for status, and bilingual (zh/en) prompts. Plus a
trio of subagent abort races that made `Esc` silently fail to stop a
running subagent.

### Added — Pillar 5: local semantic search

- **`reasonix index`** — new CLI command that walks the project, line-
  windows source files, embeds via Ollama (`nomic-embed-text` by
  default, ~274 MB once), and persists a JSONL index at
  `.reasonix/semantic/`. Incremental by default (mtime-based), with
  `--rebuild` for a full wipe. Per-chunk failures are logged + skipped
  so one bad file doesn't kill a 30-minute build.
- **Preflight prompts** — detects missing Ollama binary / daemon /
  model and offers to start `ollama serve` or `ollama pull <model>`
  with `[Y/n]` confirms. `--yes` for scripts. Non-TTY exits cleanly
  with a remediation hint.
- **TTY progress spinner** — Braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` ticks every
  120ms via `setInterval`, INDEPENDENT of progress events. Builds
  that take 30+ seconds never look hung. Non-TTY mode keeps phase
  lines + heartbeats for parseable CI logs.
- **Chunker safety** — `maxChunkChars` cap (default 4000 ≈ 1000
  tokens) with line-boundary splitting for oversized windows and
  hard-truncation for single overlong lines. Fixes Ollama 500 "the
  input length exceeds the context length" on minified / dense files.
- **`semantic_search` tool** — registered in `reasonix code` only when
  an index exists. Tool description is now directive ("FIRST CHOICE
  for descriptive queries"); the code-mode system prompt grows a
  `# Search routing` fragment when the tool is registered, telling
  the model to prefer semantic_search for intent-style questions
  and fall back to grep for exact tokens.
- **`/semantic` slash** — shows status (built? Ollama installed?
  daemon up?) plus how-to-enable hints. Fire-and-forget pattern, same
  as `/kill` — sync placeholder, async post via `ctx.postInfo`.
- **Bilingual UI** — `src/index/semantic/i18n.ts` with EN/ZH dicts
  for every preflight + `/semantic` + progress label. Locale
  detection: `REASONIX_LANG` override → `LANG`/`LC_ALL`/`LC_MESSAGES`
  (Unix) → `Intl.DateTimeFormat` (Windows fallback) → `en`. Tool
  descriptions and CLI `--help` stay English on purpose (model-facing
  text aligns with training distribution; commander's --help is
  registered once at boot).
- **Startup is silent** — no auto-prompt on `reasonix code` launch.
  If an index exists, the tool registers; otherwise the bootstrap
  is a no-op. Discovery happens via `/semantic` when the user is
  curious, or via the explicit `reasonix index` command.

### Fixed — subagent `Esc` abort races

- **`addEventListener("abort", …)` doesn't replay aborts** — DOM
  semantics: an already-aborted signal won't fire the abort event
  again, so a parent that aborted before `spawnSubagent` attached
  its listener silently lost the cancel. Sync-check `.aborted` at
  attach and forward immediately to `childLoop.abort()`.
- **`step()` was overwriting aborted state** — at the top of
  `step()` we reassign `_turnAbort = new AbortController()`. If
  `loop.abort()` had been called BEFORE `step()` ran, the prior
  aborted controller was discarded and the fresh one started clean.
  Carry the aborted bit forward so the iter-0 check still bails.
- **`forcedSummary` was treated as success** — when the loop aborted
  it yielded a synthetic `assistant_final` with `forcedSummary: true`
  and content `"[aborted by user (Esc) — no summary produced.]"`.
  The subagent stuffed that into `final` and returned `success: true`,
  so `/skill` cheerfully reported "subagent finished" with the abort
  message as the answer. Now `forcedSummary` routes to `errorMessage`
  → `success: false` → caller renders the error.

### Added — docs / website

- **GitHub Pages site under `docs/`** — bilingual landing page (auto-
  detect via `navigator.language`, manual EN/中文 toggle, persisted
  per-browser), brand-gradient dark theme, hero terminal animation
  that mirrors the real TUI rendering primitives (◇/◆ role glyphs,
  yellow tool pills, rounded cyan EditBlockRow with `- old` red /
  `+ new` green diff lines, info-row pending/applied status).
- **`README.zh-CN.md`** — full Chinese mirror of `README.md`. Both
  READMEs now carry a language switcher header at the top.

### Tests (+27, 1441 → 1468)

- `tests/semantic-chunker.test.ts` — line-window splitting, overlap,
  forward-slash path normalization, NUL-byte sniff; the new
  `chunkText` cap behavior (multi-line split + hard-truncate-overlong-
  line + idempotent passthrough).
- `tests/semantic-store.test.ts` — JSONL roundtrip, cosine ranking,
  minScore threshold, dim-mismatch refusal, model-mismatch refusal,
  remove + wipe, fileMtimes.
- `tests/semantic-embed-tolerant.test.ts` — `embedAll` returns
  `Array<Float32Array | null>` on per-chunk error (mocked Ollama 500),
  abort still throws globally, all-fail surface, progress fires once
  per chunk regardless of outcome.
- `tests/semantic-i18n.test.ts` — locale detection precedence,
  override env var, placeholder substitution, ZH dict.
- `tests/semantic-bootstrap.test.ts` — registers when index exists,
  silent skip otherwise (no startup prompt).
- `tests/semantic-slash.test.ts` — `/semantic` status renderer,
  enabled / not-built / Chinese-locale paths.
- `tests/semantic-launcher.test.ts` — `findOllamaBinary` contract.
- `tests/code-prompt.test.ts` — search-routing fragment is absent by
  default and present + ordered before .gitignore when the flag is on.
- `tests/subagent.test.ts` — regression: parent signal already aborted
  at dispatch time (race we previously dropped on the floor).

### Refactored

- **`src/code/prompt.ts`** — `codeSystemPrompt(rootDir, opts?)` grew
  a `hasSemanticSearch` flag; the routing fragment is appended only
  when the tool is actually registered. Cache prefix stays stable per
  session because the flag is captured at launch.

## [0.6.0] — 2026-04-24

**Headline:** Cost control becomes a first-class pillar. Default flips
flash-first, `v4-pro` is opt-in, tool results auto-compact between
turns, and the TUI grows per-turn cost visibility + a `/pro`
one-shot upgrade. Month-over-month cost on an active coding project
drops ~6–10× in practice.

### ⚠ Breaking (behavior, not API)

- **Default model is now `deepseek-v4-flash`**, not `deepseek-v4-pro`.
  `reasonix code`, `reasonix chat`, and subagents all land on flash
  by default. Users who need the frontier tier:
  `/preset max`, `/pro`, or `--model deepseek-v4-pro` on CLI.
- **Preset defaults changed**. None of the three presets auto-enable
  `branch` or `harvest` anymore — both were hidden multipliers. The
  new matrix:
  | preset | model | effort | harvest | branch |
  |---|---|---|---|---|
  | fast | v4-flash | high | off | 1 |
  | smart (default) | v4-flash | max | off | 1 |
  | max | v4-pro | max | off | 1 |
  Users who want branching still get it via `/branch N`; users who
  want harvest still get it via `/harvest on`. Neither is implicit.
- **Default preset is now `smart` (was `fast`).** Flash + full
  thinking budget is the best price/quality point for coding.
- **`deepseek-chat` / `deepseek-reasoner` aliases scheduled for
  removal.** Still accepted (they map to flash non-thinking /
  thinking), but every user-facing surface (`/models`, setup wizard,
  `--help`) now advertises `v4-flash` / `v4-pro` only.

### Added — Cost control (Pillar 4)

- **`/pro` single-turn arming** — queue v4-pro for just the next
  turn; auto-disarms after. Separate from `/preset max` (persistent)
  so "this one task is hard" doesn't require a preset round-trip.
  Status bar shows `⇧ pro armed` in yellow while queued, `⇧ pro
  escalated` in red while the turn is actually running on pro.
- **Failure-triggered auto-escalation** — the loop tracks
  `edit_file` SEARCH-not-found errors + ToolCallRepair fires per
  turn. 3+ signals flip the rest of the turn to `v4-pro` with a
  visible warning row. Counter resets at every turn start. No
  silent cost surprises.
- **Model self-report escalation (`<<<NEEDS_PRO>>>`)** — system
  prompt teaches the model that when a task CLEARLY exceeds flash's
  capability (complex architecture, subtle correctness, genuine
  design trade-offs), emit the marker as the first line of its
  response. The loop aborts that call, retries this turn on pro,
  one shot. Guarded against infinite retry (pro never self-
  escalates) and streaming output is buffered so the marker never
  flickers on-screen before the retry fires.
- **Turn-end auto-compaction** — every tool result over 3000 tokens
  gets shrunk to a cap at turn end. Biggest win for long sessions:
  a 12KB `read_file` output stops re-paying its cost on every
  future prompt. The proactive in-turn threshold also dropped from
  60% → 40% so the reactive 80% path rarely fires.
- **Forced-summary + truncation-repair auxiliary calls hard-route to
  flash+effort=high** regardless of the main-turn tier. No reason to
  pay pro rates for "paraphrase these tool results into prose" or
  "close this truncated JSON."
- **Subagent default flipped to `v4-flash` + `effort=high`**. Skill
  frontmatter `model:` / `effort:` remain the per-skill override.
- **StatsPanel cost badges** — per-turn cost alongside session total.
  Colored thresholds: turn green under $0.05, yellow $0.05–0.20,
  red ≥$0.20; session same scale ×10.

### Added — UX

- **Plan body now flows into scrollback**, not inside the modal.
  `submit_plan` pushes a dedicated `role: "plan"` row into the
  Static log (rendered via the full markdown pipeline, never
  truncated); the PlanConfirm modal below shrinks to a tight
  approve/refine/cancel picker. Long plans are fully readable via
  terminal scrollback.
- **Shared prompt fragments** — `TUI_FORMATTING_RULES` and
  `NEGATIVE_CLAIM_RULE` live once in `src/prompt-fragments.ts`,
  embedded into every system prompt (main code, default chat,
  subagent, built-in skills). Three near-identical copies
  collapsed; subagents gain the "don't assert absence without
  checking" guardrail they previously lacked.

### Fixed

- **`run_skill` accepts decorated names.** The Skills index wrote
  entries like `- 🧬 explore`, and models copied the whole thing
  verbatim into `run_skill({name:"🧬 explore"})`. The index now
  uses a trailing `[🧬 subagent]` tag after the name, and
  `run_skill` normalizes inputs by stripping bracketed tags +
  leading emoji before lookup. Handles `"🧬 explore"`,
  `"[🧬 subagent] explore"`, `"explore [🧬 subagent]"`, etc.
- **`edit_file` result no longer shown twice.** The interceptor's
  `applyNow` was pushing an info row, and the loop's tool event
  re-displayed the same text as a proper tool row. Dropped the info
  row push; the tool row alone carries the content.
- **`run_command` / `run_background` descriptions teach their shell
  constraints upfront.** Explicit list of rejected operators
  (`&&`, `||`, `|`, `;`, `>`, `<`, `2>&1`), the `cd` doesn't-persist
  rule, a warning against unbounded-output commands (`netstat -ano`,
  `find /`), and concrete alternatives (`npm --prefix`, `cargo -C`,
  `git -C`). Models stop burning turns rediscovering these via
  error replies.

### Refactored (no behavior change)

- **App.tsx split** from 2931 → ~1980 lines by extracting
  `LiveRows.tsx`, `edit-history.ts`, `useEditHistory.ts`,
  `useCompletionPickers.ts`, `useSessionInfo.ts`, and
  `useSubagent.ts`. Every hook under 310 lines.
- **slash.ts split** from 1786 → 20-line barrel. Types,
  SLASH_COMMANDS data + parse helpers, shared utility helpers, a
  handler registry (`dispatch.ts`), and 10 per-topic handler files
  all under `src/cli/ui/slash/`. Adding a command now means editing
  one handler file + one registry line.

### Docs

- **`docs/ARCHITECTURE.md` rewritten** for v0.6. The four pillars,
  current module layout (slash + handlers + hooks all reflected),
  design-evolution timeline replacing the stale roadmap,
  non-goals updated to call out "automatic cost escalation without
  user-visible announcement" as explicitly rejected.

## [0.5.24] — 2026-04-24

**Headline:** `reasonix code` gets a proper review gate, background
process support, and aggressive context hygiene so long coding
sessions stop bleeding money.

### Added

- **Edit-gate modes (review / auto)** — `edit_file` and `write_file`
  tool calls now route through a user gate. `review` (default) pops
  an `EditConfirm` modal with a scrollable diff + `y/n/a/A/Esc`
  keys; `auto` applies immediately and arms a 5-second undo banner.
  `Shift+Tab` cycles, `/mode` sets explicitly. Persisted to
  `~/.reasonix/config.json`.
- **Session edit history** — every applied batch lands in an
  in-memory ring. `/history` lists them, `/show [id] [path]` dumps
  a stored diff (per-file when path given), `/undo [id] [path]`
  rolls back at any granularity (latest batch, specific batch,
  single file inside a batch). `u` keybind reaches back past the
  5-second banner as long as history has a non-undone entry.
- **Background processes** — new `run_background` / `job_output` /
  `stop_job` / `list_jobs` tools for dev servers and watchers. Spawn
  returns after a ready-signal match (`listening on`, `Local:`,
  `compiled successfully`, …) or `waitSec` seconds. `/jobs` /
  `/kill <id>` / `/logs <id>` surface them to the user. Cleanup on
  SIGINT / SIGTERM / exit kills every child.
- **Per-edit review modal (`src/cli/ui/EditConfirm.tsx`)** — diff
  viewport sized to terminal rows; `↑↓/j/k/Space/PgUp/PgDn/g/G`
  scroll a big diff in place. `a` applies rest of turn, `A` flips
  to AUTO for the session.
- **Bottom mode status bar** — always-visible line above the prompt
  shows mode / pending count / Shift+Tab hint / running-jobs tag;
  flashes on mode change.
- **Onboarding tip** — first `reasonix code` launch after upgrade
  posts the edit-gate keybindings once; suppressed after via the
  `editModeHintShown` flag.

### Changed

- **`read_file`** — adds `range:"A-B"` param (1-indexed, inclusive).
  Files longer than 200 lines with no scope return an auto-preview
  (head 80 + tail 40 + "N lines omitted" marker) instead of dumping
  everything. One `read_file` used to burn 6.5K tokens on a fat
  file; scoped reads cut that 3-5×.
- **`directory_tree`** — default `maxDepth` 4 → 2; skips
  `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.nuxt`,
  `target`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`,
  `.mypy_cache`, `.cache`, `coverage` unless `include_deps:true`;
  collapses any directory past 50 children with a nudge toward
  `list_directory`.
- **Auto-compact tool-call args** — after every `tool` response, the
  loop shrinks that call's `arguments` JSON if it exceeds 800
  tokens. Paths and short fields stay verbatim; long SEARCH /
  REPLACE / content strings get replaced with a `[…shrunk: N chars,
  M lines — tool already responded, see result]` marker. Cuts
  stale-args drag across every subsequent turn.
- **`/compact`** — now covers both tool results (existing) and
  tool-call args (new) in one pass.
- **`reasoningEffort` persistence** — `/effort high` now writes the
  choice to `~/.reasonix/config.json` and the loop picks it up at
  launch. Earlier versions silently reverted to `max` every relaunch.
- **Prompt scope discipline** — code-mode prompt tells the model to
  stop after "run / start / launch" tasks instead of proactively
  refactoring, running tsc, or chasing unused imports.

### Fixed

- **`run_background` confirmation path** — TUI now pops the shell
  confirm modal for `run_background` (not just `run_command`). A
  `kind` field on `pendingShell` routes approval to
  `JobRegistry.start()` so approving doesn't synchronously block on
  a dev server that never exits.
- **`/kill` actually kills the tree** — Windows `taskkill /T /F`,
  POSIX `process.kill(-pid, …)` on a detached child. Earlier
  `SIGTERM` only killed the `npm.cmd` wrapper; `node → vite →
  esbuild` survived. `/kill` also posts a late "job N exit M" row
  when the stop resolves, so the user doesn't have to poll `/jobs`.

## [0.4.24] — 2026-04-22

**Headline:** `reasonix stats` is now a cross-session cost dashboard.

Every turn `reasonix chat|code|run` executes now appends one line to
`~/.reasonix/usage.jsonl` carrying tokens + cost + the equivalent
Claude Sonnet 4.6 cost. `reasonix stats` (no arg) rolls that log up
into today / week / month / all-time windows:

```
Reasonix usage — /Users/you/.reasonix/usage.jsonl (2.3 KB)

            turns  cache hit    cost (USD)      vs Claude     saved
----------------------------------------------------------------------
today           8      95.1%     $0.004821        $0.1348      96.4%
week           34      93.8%     $0.023104        $0.6081      96.2%
month         127      94.2%     $0.081530        $2.1452      96.2%
all-time      342      94.0%     $0.210881        $5.8934      96.4%

most used model:   deepseek-reasoner (84% of turns)
top session:       default (214 turns)
tracked since:     2026-04-20
```

Pillar 1's pitch (94–97% cost reduction vs Claude) turns from a
blog number into a fact users can check on their own machine. The
savings column is derived per turn (not synthesized) from the
existing `claudeEquivalentCost()` helper in `src/telemetry.ts`.

Back-compat: `reasonix stats <transcript>` still works — passing a
path falls back to the old per-file summary (assistant turns + tool
calls). No arg → dashboard.

Privacy: the log contains tokens + costs + the user-chosen session
name, nothing else. No prompts, no completions, no tool args.

### Added

- **`/stats` slash** — same dashboard, in-session. Reads
  `~/.reasonix/usage.jsonl` and renders via the shared
  `renderDashboard` pure function, so the shell command and the
  slash stay in sync by construction.
- **`src/usage.ts`** — `appendUsage` (best-effort JSONL write,
  swallows disk failures so a read-only `~/` never breaks the
  turn), `readUsageLog` (malformed-line tolerant), `aggregateUsage`
  (rolling windows: 24h / 7d / 30d / all, plus model + session
  histograms), `bucketCacheHitRatio`, `bucketSavingsFraction`,
  `formatLogSize`.
- **Wire-up** in `src/cli/ui/App.tsx` (assistant_final event) and
  `src/cli/commands/run.ts` (CI / scripting turns land in the same
  log as TUI turns).
- **Upgraded `reasonix stats`**. No-arg → dashboard; transcript arg
  → legacy per-file summary. `renderDashboard(agg, path)` is an
  exported pure function so tests can assert the string output.

### Tests (+15, suite 708 → 723)

- `tests/usage.test.ts` covers: appendUsage round-trip, empty
  log / malformed-line tolerance / parent-dir auto-creation / silent
  write-failure (points path at a regular file), aggregateUsage
  (empty, rolling-window bucketing, cross-record sums, byModel +
  bySession sort + (ephemeral) grouping), bucket helpers with zero
  denominators, renderDashboard (row labels + em-dash fallback).

---

## [0.4.23] — 2026-04-22

**Headline:** Hooks — user-defined automation that fires at four
well-known points in the loop. Same two-scope layout (project +
global) as memory and skills.

A hook is a shell command. Reasonix invokes it with stdin = a JSON
envelope describing the event. The exit code drives the decision:
`0` = pass, `2` = block (only on `PreToolUse` / `UserPromptSubmit`),
anything else = warn (rendered inline as a yellow row, the loop
keeps going). Block on a tool event swaps the dispatch for a
synthetic tool result carrying the hook's stderr — the model sees
a structured refusal instead of a silent omission, and can
reason about what to do next.

Settings file:

```json
// <project>/.reasonix/settings.json   ← committable
// ~/.reasonix/settings.json           ← per-user
{
  "hooks": {
    "PreToolUse":       [{ "match": "edit_file|write_file", "command": "bun scripts/guard.ts" }],
    "PostToolUse":      [{ "match": "edit_file", "command": "biome format --write" }],
    "UserPromptSubmit": [{ "command": "echo $(date +%s) >> ~/.reasonix/prompts.log" }],
    "Stop":             [{ "command": "bun test --run", "timeout": 60000 }]
  }
}
```

Project hooks fire before global hooks. `match` is anchored regex
on the tool name (`*` or omitted = match every tool); ignored for
prompt / Stop events. Per-hook `timeout` overrides the defaults
(5s for blocking events, 30s for logging events). The CLI loads
both files at App mount; `/hooks` lists what's active and
`/hooks reload` re-reads disk without tearing down the running
loop (so the append-only log is preserved).

Deliberate non-goals for v1: workflow DSL, conditional chaining,
hook templates. Hooks are shell commands — the user already has
a programming language, we don't need to invent one.

### Added

- **`src/hooks.ts`** — `loadHooks` (project + global merge),
  `runHooks` (event filter + stdin JSON + spawn dispatch),
  `decideOutcome` (pure exit-code → decision matrix), `matchesTool`
  (anchored-regex name filter), `formatHookOutcomeMessage` (single
  source of truth for the warning row text). Spawner is injectable
  for tests; default uses `shell: true` so `&&`, pipes, env
  expansion all behave the way they do in the user's terminal.
- **`CacheFirstLoopOptions.hooks` + `hookCwd`**. Loop dispatches
  `PreToolUse` (around line 866 in `src/loop.ts`) and `PostToolUse`
  (immediately after dispatch). `loop.hooks` is mutable so
  `/hooks reload` can swap the list without rebuilding the loop.
- **App-level `UserPromptSubmit` + `Stop`**. `App.tsx` calls
  `runHooks` before pushing the user message (block = drop the
  prompt) and after `loop.step` resolves (warnings only, since the
  turn already ended).
- **`/hooks` slash command**. `list` (default) groups loaded hooks
  by event with scope tags; `reload` re-reads settings.json from
  disk via the App-provided `reloadHooks` callback.
- **`/update` slash command**. Shows current vs the last-resolved
  latest (piggybacks on App.tsx's mount-time background check) and
  prints the exact shell command to upgrade. Deliberately does NOT
  spawn `npm install` from inside the TUI — stdio:inherit into a
  running Ink renderer corrupts the display, and on Windows the
  currently-running binary can be locked. Users exit the session
  and run `reasonix update` in a fresh shell.

### Tests (+36, suite 672 → 708)

- `tests/hooks.test.ts` — `loadHooks` (empty / project+global / array
  order / ignore malformed entries / tolerate malformed JSON / no
  project root → global only / path helpers), `matchesTool` (`*` /
  anchored regex / substring rejected / malformed regex falls back
  to no-match / non-tool events ignore match), `decideOutcome`
  (exit 0 / exit 2 / non-zero / timeout / spawn error per event),
  `runHooks` (filters by event+match before running, stops at first
  block, doesn't stop on warn, stdin envelope shape, cwd routing,
  default timeouts, per-hook timeout override), `formatHookOutcomeMessage`
  (pass → empty / non-pass includes scope+command+detail / 60-char
  truncation).
- `tests/loop-hooks.test.ts` — `CacheFirstLoop` accepts a hook list,
  default empty, `loop.hooks` is mutable, `hookCwd` defaults to
  `process.cwd()` and honors override, no-tool turn doesn't fire
  PreToolUse hooks.
- `tests/slash.test.ts` — updated `suggestSlashCommands("h")` to
  include the new `hooks` command; added 4 tests for `/update`
  (pending / up-to-date / upgrade-available / suggest-surfaces-it).

---

## [0.4.22] — 2026-04-22

**Headline:** Version display in the TUI header + `reasonix update`
self-upgrade command.

Two small quality-of-life additions. The stats panel now carries the
running version (`Reasonix v0.4.22 · model …`) so users can tell at
a glance whether they're on the latest build; a 24-hour background
check against the npm registry quietly surfaces a yellow
`update: X.Y.Z` nudge on the right side of the same row when a
newer version has been published. The nudge never blocks startup —
the fetch is bounded at 2s with a 24h on-disk cache, and any
failure (offline, firewall, registry hiccup) is silent by design.

`reasonix update` is the command form: detects whether you're
running a global install vs an ephemeral `npx` spawn, and either
spawns `npm install -g reasonix@latest` for the former or prints a
cache-refresh hint for the latter. `--dry-run` prints the plan
without executing.

The `VERSION` constant now sources from `package.json` at runtime
(walking up from `import.meta.url`) instead of a hand-maintained
literal, so it can never drift again — it was stale at `0.4.20`
before this release. Tests assert they stay in sync.

### Added

- **`src/version.ts`** — exports `VERSION`, `compareVersions`,
  `getLatestVersion`, `isNpxInstall`, and the
  `LATEST_CACHE_TTL_MS` / `LATEST_FETCH_TIMEOUT_MS` constants.
  `getLatestVersion` caches to `~/.reasonix/version-cache.json`
  (24h TTL) and returns `null` on any failure.
- **`reasonix update`** subcommand (`src/cli/commands/update.ts`).
  `planUpdate()` is the pure decision function, `updateCommand()`
  is the CLI orchestrator with test seams (`fetchLatest`, `isNpx`,
  `spawnInstall`, `write`, `exit`).
- **StatsPanel header shows `v${VERSION}`** inline, plus an
  `update: X` badge (yellow, bold) on the right when
  `updateAvailable` is passed. App.tsx fires the registry check
  in a background `useEffect` on mount; only a version strictly
  newer than the running one flips the state.

### Fixed

- **Drifted `VERSION` constant.** `src/index.ts` hard-coded
  `"0.4.20"` while `package.json` was on `0.4.21`. Replaced with a
  re-export from `src/version.ts`, which reads the manifest on
  first access. A regression test pins them together.

### Tests (+19, suite 588 → 607)

- `tests/version.test.ts` — `VERSION === package.json.version`,
  `compareVersions` covers numeric + pre-release ordering,
  `isNpxInstall` covers the three detection paths,
  `getLatestVersion` covers cache hit / force-refresh / expired
  entry / network failure / bad body / cache-write failure.
- `tests/update-command.test.ts` — `planUpdate` returns the
  correct action for all four decision quadrants; `updateCommand`
  respects every seam: no-spawn on up-to-date, no-spawn on npx,
  spawns on global-behind-latest, honors `--dry-run`, exits
  non-zero on registry failure, surfaces npm's non-zero exit.

---

## [0.4.21] — 2026-04-22

**Headline:** Skills — user-authored prompt packs, two-scope layout
matching user-memory.

Reasonix discovers skills under `<project>/.reasonix/skills/` (project
scope) and `~/.reasonix/skills/` (global scope). Project wins on name
collisions — per-repo overrides of a global skill work the way users
expect. Deliberately NOT tied to any other tool's directory
convention (`.claude/`, `.glm/`, etc.): Reasonix is model-agnostic at
the conversation layer, so coupling the skill filesystem to one
vendor would break anyone running a different backend.

The pinned index (names + one-line descriptions) lives in the
immutable system prefix; bodies stay lazy and enter the append-only
log only when invoked — either by the model calling the new
`run_skill` tool or by the user typing `/skill <name> [args]`. No
DAG engine, no workflow DSL — the model reads the skill's prose and
continues the normal tool-use loop from there. Pillar 1's cache
invariants are preserved: adding skills grows the pinned index
(under a 4k char cap, with a truncation marker) but never alters
the rest of the prefix.

### Added

- **`src/skills.ts`** — `SkillStore` with `SkillScope` of `"project"`
  or `"global"`, both layouts recognized (`{name}/SKILL.md` and flat
  `{name}.md`). `applySkillsIndex` composer is pinned into
  `applyMemoryStack` alongside REASONIX.md + user memory, receiving
  the same `rootDir` so the project scope picks up
  `<rootDir>/.reasonix/skills/`.
- **`run_skill` tool** (`src/tools/skills.ts`) — read-only, returns
  the full markdown body plus an optional forwarded `Arguments:` line.
  Registered in `reasonix chat` (global only) and `reasonix code`
  (project + global).
- **`/skill` slash command** — `list` / `show <name>` / bare
  `<name> [args]` form. The bare form injects the skill body as a
  user turn via the same `resubmit` hook `/apply-plan` uses. Reads
  project scope from `ctx.codeRoot`, mirroring how `/memory` behaves.

### Notes

- Each skill's `allowed-tools` frontmatter is parsed but **ignored**
  in v1. Reasonix's tool namespace (`filesystem`, `shell`, `web`)
  doesn't one-to-one map onto other clients' names; the model reads
  the prose instructions and picks our equivalents. Will revisit
  once the tradeoffs are clearer.
- What we explicitly did **not** add: workflow DSL, DAG scheduler,
  parallel branches, sub-agents. Skills are prose; the model does the
  sequencing. This keeps single-loop + append-only + cache-first
  intact — the architectural non-goal "no multi-agent orchestration"
  stands.

### Fixed

- **`ShellConfirm` "always allow" did not take effect until relaunch.**
  The `run_command` tool captured `extraAllowed` as a snapshot at
  registration time, so a prefix the user approved mid-session was
  written to `~/.reasonix/config.json` but the in-memory tool still
  refused it — the next invocation re-triggered the confirmation
  modal. `ShellToolsOptions.extraAllowed` now accepts a getter in
  addition to a static array; `reasonix code` passes
  `() => loadProjectShellAllowed(rootDir)` so the allowlist is
  re-read from disk on every dispatch. Static-array callers keep
  working unchanged.
- **Windows cmd.exe built-ins (`dir`, `echo`, `type`, `ver`, …)
  crashed with ENOENT.** These aren't standalone executables, so
  `PATH × PATHEXT` lookup misses and `spawn dir` fails. `prepareSpawn`
  now routes bare unresolved Windows commands through
  `cmd.exe /d /s /c "<cmd> <args…>"` with verbatim-args + manual
  metacharacter quoting — same wrapping strategy we already use for
  `.cmd`/`.bat` files. Built-ins resolve correctly; genuinely unknown
  commands get the standard "'foo' is not recognized as an internal
  or external command" message instead of a raw spawn error.
  Already-extensioned names (`node.exe`) and paths-with-separators
  (`C:\tool.exe`) still pass through unwrapped so an explicit "I
  know where this is" invocation fails loudly when it's missing.

## [0.4.19] — 2026-04-22

**Headline:** Windows shell hotfix + StormBreaker visibility.
`reasonix code` now runs `npm`, `npx`, `tsc`, `yarn`, `pnpm`, `bun`,
`pytest`, and every other `.cmd` / `.bat` wrapper on Windows — both
under Node 18/20 (broken by missing PATHEXT resolution) and Node
21.7.3+/24 (broken by CVE-2024-27980's prohibition on direct
`.cmd`/`.bat` spawns with `shell: false`). Unix behavior unchanged.
Plus: the StormBreaker anti-loop-detector no longer silently halts
a turn — when it fires it emits a visible warning row explaining
what was suppressed and what the user should do next, and its
sliding window resets on each new user message so a new intent
doesn't inherit the previous turn's repeat patterns.

### Fixed

- **`spawn npm ENOENT` on Windows** — `child_process.spawn` with
  `shell: false` uses `CreateProcess`, which ignores PATHEXT. Bare
  `npm` failed because no `npm.exe` exists — only `npm.cmd`. New
  `resolveExecutable(cmd)` walks `PATH × PATHEXT` manually and
  returns the full resolved path (`C:\Program Files\nodejs\npm.CMD`)
  before handing to spawn. Keeps `shell: false` (no shell expansion
  of piped / chained commands — the whole reason we avoided
  `shell: true` to begin with).
- **`spawn npm EINVAL` on Node ≥ 21.7.3 / 24** — even with the
  resolved `.cmd` path, Node's post-CVE-2024-27980 patch refuses to
  execute `.cmd` / `.bat` files via direct spawn. Second layer:
  `prepareSpawn()` detects a `.cmd` / `.bat` target on Windows and
  rewrites the invocation to `cmd.exe /d /s /c "<bin> <args…>"`
  with `windowsVerbatimArguments: true`. Each arg is routed through
  `quoteForCmdExe()`, which wraps in double quotes when the arg
  contains whitespace or cmd.exe metacharacters
  (`" & | < > ^ % ( ) , ; !`) and doubles embedded quotes per
  cmd.exe's `""` escape rule. Arguments like `a&b` stay literal;
  they don't become shell operators.

### Added

- **`resolveExecutable(cmd, opts?)`** — exported from `src/tools/shell.ts`.
  Windows PATH × PATHEXT resolver. Opts lets tests inject `platform`,
  `env`, and `isFile` so the Windows-specific path can be exercised
  from a Linux CI runner without touching real fs.
- **`prepareSpawn(argv, opts?)`** — exported. Returns the
  `(bin, args, spawnOverrides)` tuple that runCommand should pass to
  `child_process.spawn`. On non-Windows it's a passthrough; on
  Windows it applies the PATHEXT lookup and the `cmd.exe` wrapping
  when needed. Unit-tested without spawning real processes.
- **`quoteForCmdExe(arg)`** — exported. The per-arg quoting
  function. Round-trip tested against realistic argvs
  (`npm install`, paths with spaces, args containing
  `& | < > ^`, empty strings, embedded double quotes).

- **Silent storm-break**. When `StormBreaker` caught a repeated
  `(tool, args)` pattern it dropped the offending call but emitted
  nothing user-visible beyond a small `[repair] broke 1 storm` note
  on the assistant row. If the suppressed call was the only tool
  call of the turn, the turn just ended — no explanation of why
  nothing happened. Now the loop yields a dedicated `warning` event
  (same channel as Esc-abort and budget warnings) with an
  actionable message, distinguishing "all calls suppressed (stuck
  retry)" from "some calls suppressed" cases.
- **StormBreaker state bleeds across user turns**. The sliding
  window of recent signatures persisted for the lifetime of the
  loop, so a stuck pattern from an earlier intent could false-
  positive against the user's legitimate new "try again with
  different input" request. `CacheFirstLoop.step()` now calls
  `repair.resetStorm()` on every new user turn — the window
  repopulates naturally as the new turn's tool calls fire, and
  genuine repeats still trip after the usual 3-in-a-row pattern.

### Added

- **`ToolCallRepair.resetStorm()`** — exposes StormBreaker.reset
  through the repair facade. Called by the loop at each user turn;
  library consumers that drive `repair.process` manually can use it
  too if they wrap their own turn semantics.

### Tests (+22, suite 566 → 588)

- `tests/shell-tools.test.ts` (+21) — `resolveExecutable` on
  non-Windows (passthrough), PATHEXT walk (first-hit ordering,
  whitespace-tolerant PATHEXT entries), absolute-path / slash /
  already-extensioned passthrough, empty input, missing PATH /
  PATHEXT. `quoteForCmdExe` (simple identifiers unquoted, whitespace
  + metachars quoted, embedded quotes doubled, empty string
  → `""`). `prepareSpawn` (unix passthrough, `.cmd` wraps via
  cmd.exe, `.bat` wraps too, `.exe` direct, metachar args quoted,
  PATHEXT miss falls through).
- `tests/repair/pipeline.test.ts` (+1) — `resetStorm` clears the
  repeat-window so post-reset calls aren't suppressed.
- `tests/loop.test.ts` — the iter-budget warning test refined to
  filter by the iter-specific pattern, since identical fixture
  calls now also trip the (correct) storm warning.

### Internals

- `runCommand` in `src/tools/shell.ts` now calls `prepareSpawn`
  instead of spawning `argv[0]` directly. Every codepath that was
  going through `spawn` still does; the `bin` / `args` /
  `spawnOverrides` it receives are platform-normalized.
- Existing allowlist + `readOnlyCheck` plan-mode gate + timeout /
  output-cap / AbortSignal wiring is untouched.
- `CacheFirstLoop.step()` now resets the StormBreaker at the top of
  each turn AND emits a `warning` event after `repair.process()`
  when `report.stormsBroken > 0`. The existing `repair` field on
  `assistant_final` still carries the count for historical records
  / transcripts.

---

## [0.4.18] — 2026-04-22

**Headline:** Plan Mode — the model can propose a markdown plan
autonomously for large tasks (multi-file refactors, architecture
changes, ambiguous requests), and you can also force a read-only
exploration phase via `/plan`. Picker shows Approve / Refine / Cancel.
Approve pushes a synthetic "implement now" message; Refine keeps the
model exploring; Cancel drops the plan. Designed around Pillar 1 —
tool specs stay pinned, so the cache prefix doesn't break when plan
mode toggles.

### Added

- **`submit_plan` tool** (`src/tools/plan.ts`) — registered by default
  in `reasonix code`. Throws `PlanProposedError` carrying the plan
  text via the new `toToolResult()` protocol on ToolRegistry. Fires
  the picker whether or not plan mode is active — the model is
  expected to propose plans on its own for large tasks; `/plan` is
  the *stronger* constraint that forces the model into read-only.
- **`/plan` slash** (code mode only) — toggles read-only plan mode.
  `/plan on`, `/plan off`, or `/plan` to flip. While on, the registry
  refuses non-read-only dispatch; while off, the model can still
  propose plans autonomously via submit_plan. `/status` surfaces the
  state; `StatsPanel` shows a red `PLAN` tag.
- **`/apply-plan` slash** (code mode only) — force-approve fallback.
  Clears plan mode, clears the pending-plan picker state, and
  resubmits the implement-now synthetic via the existing `resubmit`
  mechanism. Useful when the model wrote the plan in assistant text
  instead of calling submit_plan, or when you want to keyboard-only
  the approval without the picker.
- **`ToolDefinition.readOnly` + `readOnlyCheck`** — declarative gate
  used by `ToolRegistry.dispatch` when plan mode is on. Read tools
  (`read_file`, `list_directory`, `search_files`, `directory_tree`,
  `get_file_info`, `web_search`, `web_fetch`) run normally. Write
  tools bounce with a refusal the model reads and learns from.
  `run_command` uses a dynamic `readOnlyCheck` so allowlisted
  invocations (`git status`, `cargo check`, `npm test`, `grep`, …)
  still work during planning — exploration isn't gated. Non-allowlisted
  commands refuse just like other writes.
- **`ToolRegistry.setPlanMode(on)` / `.planMode`** — the enforcement
  switch + accessor. Mirrored onto the UI's `planMode` React state so
  the StatsPanel badge stays in sync.
- **`toToolResult()` extension protocol** on Error subclasses —
  `ToolRegistry.dispatch` calls it if present when an error is thrown,
  serializing custom fields alongside `error`. Used by
  `PlanProposedError` to ferry the plan text to the UI without
  regex-scraping the error message. Falls back safely on serialization
  failure.
- **`PlanConfirm.tsx`** — 3-option Ink picker (Approve / Refine /
  Cancel) with the plan rendered as **live Markdown** (via the
  existing `Markdown` component — headings, lists, code, bold all
  formatted, not raw text) in a cyan-bordered panel above. 2 400-char
  rendered cap; longer plans get a "use /tool for full" truncation
  marker. Live rows hidden while the picker is up, matching
  `ShellConfirm`'s behavior. When the plan contains headings like
  "Open questions", "Risks", "Assumptions", "待确认", "开放问题", "风险",
  "未知", "假设", "不确定", the picker auto-selects the Refine option
  by default and shows a yellow "▲ the plan has open questions —
  pick Refine to answer them" hint above the options.
- **`PlanRefineInput.tsx`** — inline text input that appears after
  the user picks either **Approve** or **Refine**. Picking Approve
  lets the user type last-minute instructions or answers to the
  model's open questions (blank Enter = approve as-is). Picking
  Refine requires specifics — the input collects them and includes
  them verbatim in the synthetic sent to the model, so "refine"
  actually means "revise with this feedback" instead of the generic
  "try again" message the first cut sent. Esc returns to the picker
  without resuming the loop.
- **System-prompt guidance** (`CODE_SYSTEM_PROMPT`) — teaches the
  model when to call submit_plan autonomously (big / risky / ambiguous
  tasks) vs. just making the change (typos, obvious one-line fixes),
  and how `/plan` mode adds the stronger dispatch gate on top.

### Tests (+24, suite 542→566)

- `tests/plan.test.ts` (+17) — ToolRegistry plan-mode gate
  (default-off, toggle, block non-read-only, allow read-only, honor
  `readOnlyCheck` per-args, precedence over `readOnly`, off-mode
  noop); `toToolResult` protocol (serializes custom fields, falls
  back on serializer failure); `PlanProposedError` carries plan +
  STOP directive; `registerPlanTool` registers submit_plan as
  read-only, fires picker both in and out of plan mode, rejects
  empty plans, trims whitespace.
- `tests/slash.test.ts` (+7) — `/plan` registry entries + required
  commands check; `/plan` toggle / on / off / true / false / 0 / 1;
  `/plan` info text explicit about the stronger-constraint
  relationship; `/apply-plan` code-mode gating; `/apply-plan` flips
  mode + clears pending + resubmits; works without optional
  `clearPendingPlan` callback; `/status` plan-mode line appears
  iff on.

### Internals

- `src/tools/filesystem.ts` — read_file / list_directory /
  directory_tree / search_files / get_file_info tagged readOnly.
- `src/tools/shell.ts` — run_command gets `readOnlyCheck` tied to
  the existing `isAllowed` check + `allowAll` escape hatch.
- `src/tools/web.ts` — web_search / web_fetch tagged readOnly.
- `src/cli/commands/code.tsx` — `registerPlanTool(tools)` added after
  the filesystem and shell registrations so the tool is always in
  the pinned spec list (prefix cache stays stable across
  plan-mode toggles).
- `src/index.ts` — re-exports `PlanProposedError`, `registerPlanTool`,
  `PlanToolOptions` for library consumers.

---

## [0.4.17] — 2026-04-22

**Headline:** Project memory — drop a `REASONIX.md` in your project
root and its contents are pinned into the immutable-prefix system
prompt for every session in that directory. Persistent project
context (house conventions, domain glossary, gotchas the model keeps
forgetting) without eating per-turn context budget, and the prefix
cache stays warm as long as the file is stable.

### Added

- **`src/project-memory.ts`** — `readProjectMemory(rootDir)`,
  `applyProjectMemory(basePrompt, rootDir)`, `memoryEnabled()`. One
  source, one mental model: `REASONIX.md` at the project root, read
  once at session start, appended as a fenced "# Project memory"
  block after the base system prompt. Truncates at 8 000 chars
  (≈ 2k tokens) with a visible marker; `.gitignore` gets 2 000
  because it's a constraint dump, memory gets more headroom because
  it's deliberate instructions. Re-exported from `src/index.ts` for
  library consumers.
- **Auto-applied at every CLI entry** — top-level `reasonix`,
  `reasonix chat`, `reasonix run`, and `reasonix code` all honor
  the file. `code` resolves it against the rooted directory; the
  others against `process.cwd()` at launch.
- **`/memory` slash command** — prints the resolved file path +
  full contents (or a how-to stub when absent), so you can verify
  what the model is actually seeing without reading the system
  prompt blob. Reminds you changes take effect on the next launch
  or `/new`; the system prompt is hashed once per session to keep
  the prefix cache warm.
- **`REASONIX_MEMORY=off|false|0` env opt-out** — for CI or
  intentional offline reproducibility. `rm REASONIX.md` is the
  other opt-out.

### Tests (+25, suite 517→542)

- `tests/project-memory.test.ts` (+15) — absent / empty /
  whitespace-only / normal / oversized file paths;
  `memoryEnabled` env-value matrix; `applyProjectMemory` no-ops on
  missing/disabled; determinism (identical input ⇒ identical
  output, cache-prefix-safe); `codeSystemPrompt` stacks base →
  memory → .gitignore in the right order when all three exist.
- `tests/slash.test.ts` (+4) — `/memory` prints the how-to when no
  file, contents when present, "disabled" when env-off, "no root"
  when `memoryRoot` is absent from the SlashContext. Registry
  check updated to require `/memory`.

---

## [0.4.16] — 2026-04-22

**Headline:** Native `run_command` shell tool so the model can run
its own tests and verify its work (Claude Code / Aider parity).
3-choice picker for every unknown command — "run once", "always
allow in this project" (persists to `~/.reasonix/config.json`), or
"deny". Plus a session picker on startup so `reasonix code` stops
silently resuming the last conversation, and a Windows backspace fix.

### Added

- **`src/tools/shell.ts`** — `run_command(command, timeoutSec?)`
  registered by default in `reasonix code`. Read-only / testing
  commands (`git status`, `ls`, `cat`, `grep`, `rg`, `npm test`,
  `pytest`, `cargo test`, `cargo check`, `cargo clippy`, `go test`,
  `deno test`, `bun test`, `ruff`, `mypy`, `npx tsc --noEmit`,
  `npx biome check`, language `--version` probes) auto-run. Anything
  else goes through the ShellConfirm picker. 60s default timeout,
  32k-char output cap. `shell: false` in the child_process spawn
  so the model can't pipe / redirect / chain its way past the
  allowlist.
- **`src/cli/ui/ShellConfirm.tsx`** — 3-option SingleSelect modal
  that renders when the model asks to run a non-allowlisted
  command. Borders + color so it's impossible to miss. Arrow-key
  navigation; Enter confirms. No `y/n` hotkey — too easy to trigger
  by accident mid-typing.
- **`src/cli/ui/SessionPicker.tsx`** — on `reasonix chat` /
  `reasonix code` startup, if the session has prior messages, show
  a 3-option picker: **New** (default, safer), **Resume** (continue
  where you left off), **Delete and start new**. Flags `--resume`
  / `--new` bypass the picker for CI / muscle-memory.
- **Per-project persistent allowlist** — `config.projects[<abs>].shellAllowed`
  stores prefixes the user approved via "always allow". On next
  `reasonix code` in that dir they auto-run. Helpers
  `loadProjectShellAllowed` / `addProjectShellAllowed` exported.

### Fixed

- **Backspace dead on some Windows terminals.** Certain Git Bash /
  winpty combos report plain Backspace with `key.delete=true` and
  `key.backspace=false`; the 0.4.15 cursor reducer split the two
  and treated `delete` as forward-delete, which is a no-op when the
  cursor is at the end of the buffer — so pressing Backspace did
  nothing and Ctrl+Backspace (reported differently) was the only
  way to delete. Now both flags collapse to backward-delete, plus
  raw DEL (0x7f) and BS (0x08) bytes in `key.input` are honored as
  backspace too.

### Tests (+43, suite 474→517)

- `tests/shell-tools.test.ts` (+27) — tokenizer (quoting, escapes,
  unclosed-quote rejection); allowlist matching (exact / prefix /
  whitespace normalization / extras); `runCommand` against real
  child processes (stdout, stderr, cwd, timeout kill, output cap,
  empty-command rejection); registry dispatch (auto-run, refusal
  via `NeedsConfirmationError`, `allowAll: true` bypass);
  `formatCommandResult`; `NeedsConfirmationError` name/message
  invariants (no stale `/apply-shell` reference).
- `tests/shell-confirm.test.ts` (+4) — `derivePrefix` picks one or
  two tokens based on known wrappers and normalizes whitespace.
- `tests/config.test.ts` (+3) — `loadProjectShellAllowed` defaults
  to `[]`; `addProjectShellAllowed` persists and dedups per-project;
  ignores empty prefixes.
- `tests/multiline-keys.test.ts` (+2) — raw DEL/BS bytes are
  treated as backspace; `key.delete` unified with `key.backspace`.

---

## [0.4.15] — 2026-04-22

**Headline:** Web search + fetch tools (on by default, zero
configuration) plus real cursor editing in the prompt box (←/→,
Backspace/Delete mid-string, multi-line ↑/↓ navigation).

### Fixed

- **PromptInput was append-only** — cursor was always pinned to
  the end of the buffer, so the only way to fix a typo was
  backspacing back through everything after it. Now:
  - `←` / `→` move the cursor one column (clamped to buffer).
  - `↑` / `↓` move across lines in a multi-line buffer, preserving
    column when possible, clamping when the target line is shorter.
  - `Ctrl+A` / `Ctrl+E` jump to start / end of the current line.
  - `Backspace` deletes the char before the cursor; `Delete`
    deletes the char under the cursor.
  - Printable input inserts at the cursor (including multi-char
    paste bursts).
  - `Shift+Enter` / `Ctrl+J` insert a newline at the cursor.
- **History recall no longer steals arrow keys from mid-edit.**
  `↑` / `↓` only trigger prior-prompt recall when the buffer is
  empty. A non-empty buffer keeps the arrows for cursor motion so
  typed text isn't clobbered.

### Added

Web search + fetch tools are registered by default on `reasonix
chat` and `reasonix code`. The model calls `web_search` /
`web_fetch` on its own whenever a question needs fresher info than
its training data. Backed by **Mojeek**'s public search page — no
API key, no signup. Same Cache-First + repair + context-safety
plumbing as every other tool.

Implementation note: the first cut of this feature used DuckDuckGo,
but a live probe from the dev machine confirmed DDG now serves
HTTP 202 anti-bot pages for every unauthenticated POST regardless
of UA. Mojeek is an independent-index engine that's been stable
against the same probe (3/3 success on three queries spaced 3s
apart). Real-browser `User-Agent` string avoids Mojeek's
fast-path scraper filter.


- **`src/tools/web.ts`** — two functions + one registration helper:
  - `webSearch(query, opts?)` — fetches DDG's HTML endpoint, parses
    ranked results (title + url + snippet). `topK` is clamped to
    [1, 10]. Parser decodes DDG's `uddg=<url>` redirect wrapper and
    common HTML entities.
  - `webFetch(url, opts?)` — HTTP GET + HTML-to-text extraction
    (scripts/styles/nav/footer/aside/svg stripped, paragraph breaks
    preserved, entities decoded). 15s timeout, 32k-char cap (matches
    tool-result budget), forwards caller's AbortSignal so Esc during
    a long fetch is honored.
  - `registerWebTools(registry, opts?)` — registers both as
    ToolRegistry entries the model can invoke. Tool descriptions
    guide the model to call search whenever training data might be
    stale.
- **`ReasonixConfig.search`** + **`searchEnabled()`** — a simple
  boolean. Default on. Turn off with `search: false` in config or
  `REASONIX_SEARCH=off|false|0` in env. No API keys, no provider
  picker — one switch.
- **Auto-registered in chat/code.** `reasonix chat` and
  `reasonix code` register `web_search` + `web_fetch` by default.
  Zero setup: after the normal wizard, the model can already reach
  the web.

### Tests (+18, suite 444→462)

- `tests/web-tools.test.ts` (+13) — htmlToText strips
  scripts/styles/nav/footer + decodes entities + collapses
  whitespace; `parseDuckDuckGoResults` decodes redirect URLs + entities
  + returns empty on unexpected markup; `webSearch` hits the DDG
  endpoint with a browsery UA, respects topK, clamps to [1, 10],
  throws on non-2xx; `formatSearchResults` renders the expected
  layout; `registerWebTools` registers both verbs; `web_fetch` refuses
  non-http(s) URLs; `webFetch` extracts title + body, truncates at
  the cap with a visible marker, surfaces 404s.
- `tests/config.test.ts` (+5) — `searchEnabled` defaults to true;
  honors `search: false` in file; honors `REASONIX_SEARCH=off|false|0`;
  stays true for unrelated env values; env off beats config true.

---

## [0.4.14] — 2026-04-22

**Headline:** Render-load reductions for Windows terminals where
Ink's cursor-up repaint leaves ghost artifacts (winpty / MINTTY /
Git Bash). No single bug fix — a set of pressure reductions plus an
explicit opt-out for the terminals where nothing else helps.

### Fixed

- **`patchConsole: false`** on every `render()` call (chat, setup,
  replay, diff). We never log to console during the TUI, so the
  patch was pure overhead and a known redraw-glitch source on
  wrapped-ANSI terminals.
- **Consolidated every animated component onto a single 120ms tick.**
  Previously `Pulse` (500ms), `Elapsed` × 2 (1000ms each), `StatusRow`
  (120ms + 1000ms), `OngoingToolRow` (120ms + 1000ms), and
  `PromptInput` cursor blink (500ms) each owned a private
  `setInterval`. On a streaming turn that's 6-10 uncoordinated
  re-render sources firing into Ink's patch loop. New
  `TickerProvider` / `useTick` / `useElapsedSeconds` in
  `src/cli/ui/ticker.tsx` collapses all of them to one shared
  counter — same visible behavior, ~5× fewer React re-renders per
  second.
- **Flush interval 60ms → 100ms.** 10 Hz still feels live while
  giving slow terminals more headroom per repaint. The prior 60ms
  rate queued patches faster than some Windows terminals could
  process them, manifesting as visible duplicates in scrollback.
- **`reasonix --version` no longer reports 0.4.3 forever.** The
  hardcoded `VERSION` in `src/index.ts` had been stale since April
  21; now matches `package.json`.

### Added

- **`REASONIX_UI=plain` env opt-out.** Suppresses every transient
  row in the render tree (streaming preview, ongoing-tool spinner,
  status line, processing fallback) AND disables the ticker
  entirely. Only `<Static>` committed events + the input prompt are
  drawn. Trades liveness for stability; use when the default TUI
  produces ghost rendering on your terminal.

---

## [0.4.13] — 2026-04-22

**Headline:** Two streaming-row bugs that made `reasonix code` feel
broken: the spinner froze for the entire duration of a large
`edit_file` call, and multi-iteration turns displayed the previous
iteration's body text concatenated into the next one.

### Fixed

- **Streaming row no longer freezes during a large tool-call.** When
  the model streams `tool_calls[].function.arguments` (kilobytes of
  SEARCH/REPLACE for a big `edit_file`) there are zero `content` or
  `reasoning_content` bytes, so the label sat on "writing response ·
  N chars" untouched — indistinguishable from a hung network. The
  loop now yields a new `tool_call_delta` event carrying the growing
  cumulative argument-char count, and the TUI surfaces it either as
  a dedicated "assembling tool call <name> · N chars of arguments"
  phase (magenta) when content/reasoning are empty, or as an extra
  segment on the "writing response" line when content is also
  streaming.
- **Multi-iteration turns no longer concat prior iterations' text
  into the next row.** A single `handleSubmit` can span N iterations
  (each tool_call loops us around the model), and the streaming
  buffer wasn't reset between them. If an iteration returned empty
  content (pure tool_calls), the historical entry fell back to the
  streaming-buffer's accumulated text — yielding an assistant block
  that read like a concatenation of every prior iteration's reply.
  Fix: clear `streamRef.text` / `.reasoning` / `.toolCallBuild` and
  the per-flush buffers on every `assistant_final`.
- **Unique `<Static>` key per iteration.** A single turn's multiple
  assistant_final events used to share one React key, which Ink
  dedupes; the iteration counter fixes it.

### Added

- `LoopEvent` role `tool_call_delta` with field `toolCallArgsChars`
  (cumulative arguments-string length for the call being assembled).
  Useful for any UI consumer, not just the TUI.

### Tests (+1, suite 443→444)

- `tests/loop.test.ts` — new streaming test: fake SSE body streams a
  tool_call across multiple chunks; asserts `tool_call_delta` events
  carry a strictly-growing `toolCallArgsChars` and that the id-only
  opener (name still empty) does not emit an event.

---

## [0.4.12] — 2026-04-22

**Headline:** Bulletproof tool_calls ↔ tool pairing so corrupted
session files can't keep 400ing forever. Auto-compact attempt
before forcing summary on context-guard so a single oversized
turn doesn't eat your entire session.

### Fixed

- **DeepSeek 400 "insufficient tool messages following tool_calls"**
  after a forced-summary on context-guard. Root cause: the loop
  appended `assistant.tool_calls` and then bailed to summary BEFORE
  dispatching the tools, leaving the log in a shape DeepSeek's API
  validator rejects. Fix: strip the dangling tail before calling
  summary, and defensively validate at every `buildMessages` call.
- **DeepSeek 400 "tool must be a response to a preceding tool_calls"**
  when typing anything after the above error. Root cause: partial
  fixes left stray tool messages or half-matched tool_calls in the
  log. Fix: `healLoadedMessages` now runs a full pairing validator
  — any `assistant.tool_calls` whose response set is incomplete is
  dropped along with its partial responses; any stray tool message
  is dropped. Runs on session load (with disk rewrite to persist the
  heal) AND on every outgoing API call (defensive).
- **Auto-compact before forcing summary** on context-guard trip.
  Previously the loop immediately forced a summary at 80% context —
  users lost a full turn of work. Now it first tries shrinking
  oversized tool results; if that drops enough tokens, the turn
  continues normally and the user can keep asking. Falls back to
  forced summary only when compaction has nothing to shrink.
- **`CacheFirstLoop.compact()` no longer strips structural tail** —
  split the "shrink oversized tool payloads" concern out from the
  full load-time heal. `/compact` during a live session only
  shrinks, never touches tool_calls/tool pairing (those edges are
  legitimate mid-turn state).

### Internals

- New exported `shrinkOversizedToolResults(messages, cap)` for the
  shrink-only concern. `healLoadedMessages` now composes
  `shrinkOversizedToolResults` + the full pairing validator.
- Session load heal now rewrites the session file on disk when
  anything was healed, so the damage doesn't re-surface every
  restart.

### Tests (+5, 4 reshaped, suite 436→443)

- `tests/loop-error.test.ts` (+5) — `healLoadedMessages` drops a
  stray tool without preceding tool_calls; drops an
  assistant.tool_calls whose response set is incomplete; 4 existing
  tests reshaped to use valid tool_call pairings (stray tools now
  correctly get pruned by the validator).
- `tests/loop.test.ts` (+2) — context-guard auto-compacts oversized
  tool results and continues instead of forcing summary; dangling
  assistant-with-tool_calls tail stripped defensively at
  buildMessages time.

---

## [0.4.11] — 2026-04-22

**Headline:** Real git-diff-style output for `edit_file`, `/new`
command that actually drops context (unlike `/clear`), clearer
phase labels on the streaming row.

### Added

- **LCS line-level diff for `edit_file`** — unchanged lines now
  render as ` ` context (dim), removed as `-` (red), added as `+`
  (green). Previously a one-line search with a multi-line replace
  would show the unchanged line as both `-` and `+`, which was
  just noise.
- **Git-style hunk header** (`@@ -42,1 +42,4 @@`) above each
  `edit_file` diff showing where in the file the change lands and
  how many lines it affects. Matches the `git diff` convention.
- **`edit_file` results never truncated** in the EventLog. Other
  tools keep the 400-char clip + `/tool N` escape, but edit diffs
  always show the full change so `/apply` decisions are informed.
- **`/new` slash command** (alias `/reset`) that drops the
  in-memory message log AND rewrites the session file to empty.
  Unlike `/forget` (deletes the session), `/new` keeps the session
  name, model, and config — just starts a fresh conversation.
  `CacheFirstLoop.clearLog()` is the backing public API.
- **Clearer streaming-row phase labels** — replaced the cryptic
  "streaming · 391 + think 4506 chars" with explicit state text:
  - yellow "request sent · waiting for server" pre-first-byte
  - cyan "R1 reasoning · N chars of thought" during reasoning-only
  - green "writing response · N chars · after M chars of reasoning"
    during content phase. Colored so the eye catches the phase at
    a glance instead of decoding dim text.

### Changed

- **`/clear` now advertises what it does NOT do** — users kept
  expecting it to clear context. It still clears only the visible
  scrollback, but the returned info line now says so explicitly
  and points at `/new` for context drop.
- App.tsx now renders the info line from a clear-plus-info slash
  result (previously `clear: true` short-circuited and ate any
  accompanying message).

### Tests (+8, suite 427→436 — some existing `/clear` test adjusted for new info output)

- `tests/filesystem-tools.test.ts` (+3) — `edit_file` returns a
  proper LCS diff with context lines (user's real case of one-line
  search + multi-line replace no longer double-counts); git-style
  `@@` hunk header with starting-line number from the original
  file.
- `tests/filesystem-tools.test.ts` — dedicated `lineDiff` test
  block (+5) covering pure insertion, pure deletion, substitution
  order (-/+ matches git-diff convention), identical-arrays as
  all-context, empty-search all-additions, the user-reported real
  case.
- `tests/slash.test.ts` (+3, 1 changed) — `/new` drops log + clears
  scrollback; `/reset` alias; `/help` distinguishes `/clear` vs
  `/new`; `/clear` now surfaces an explanatory info line.

---

## [0.4.10] — 2026-04-22

**Headline:** Fills the "silent wait" gaps users were hitting —
transient status indicator between iterations + before harvest, live
stats refresh per iter (not per turn), account balance cell,
in/out cost split, Esc now interrupts harvest too, `edit_file`
returns a real diff. Drops the misleading "vs Claude / saving"
numbers.

### Added

- **`status` loop event** + `StatusRow` component — a magenta
  spinner row that fills silent phases with explicit text:
  - `"thinking about the tool result…"` between iterations, while
    R1 reasons about a just-finished tool output before emitting
    the next turn's first streaming byte
  - `"extracting plan state from reasoning…"` right before the
    silent harvest round-trip (1-10s on the cheap model)
  - `"summarizing what was gathered…"` before the forced-summary
    call (budget / context-guard)
  Auto-clears on the next primary event.
- **Account balance cell** in the stats panel. `DeepSeekClient.getBalance()`
  hits `/user/balance` (separate endpoint, no billing impact).
  Fetched at launch + refreshed after each completed turn. Hides
  the cell on failure so the session works without it.
- **Input / output cost split** — panel now reads
  `cost $X (in $Y · out $Z)` so users can see where their spend
  lands without guessing. `SessionSummary` gains `totalInputCostUsd`
  and `totalOutputCostUsd`; `inputCostUsd()` and `outputCostUsd()`
  exposed as library utilities.
- **Inline diff in `edit_file` tool result** — every edit returns a
  unified-style `- old / + new` block so you can see *what* changed
  without running `git diff`. Long blocks are truncated in the
  spinner row with a `… (N more lines)` marker; `/tool N` still
  shows the full result.
- **Live stats refresh per assistant_final** — previously the
  panel only updated in the `finally` block at end-of-turn;
  multi-iter tool chains stayed frozen at the prior turn's numbers
  for 30-60s at a time. Now the cost/ctx/cache hit gauges update
  as each iteration's usage is recorded.
- **Stronger pre-first-byte hint** — streaming row now reads
  `(request sent · waiting for server)` with a concrete estimate,
  replacing the ambiguous `(streaming · 0 chars)`.

### Changed

- **Esc now also interrupts `harvest()`.** The cheap-model
  round-trip that extracts plan state was the last remaining
  un-signaled API call. Threaded `AbortSignal` through. Fast-path
  returns `emptyPlanState` when the signal is already aborted so
  the caller unblocks without a network burn.

### Removed

- **"vs Claude / saving" cells from the panel.** The savings
  percentage was a synthetic ratio against static Claude pricing,
  not a measured comparison — users fairly pointed out it reads
  like made-up marketing. The summary shape still carries
  `claudeEquivalentUsd` + `savingsVsClaudePct` for benchmark /
  replay compat but they're deprecated and no longer surfaced in
  chat.

### Also added in 0.4.10 (same release)

- **GFM markdown tables** in assistant output. `parseBlocks` now
  recognizes `| col | col |` + separator + data rows and renders
  them as aligned columns with `│` dividers. Handles alignment
  colons (`:---`, `---:`), escaped pipes, and leading-pipe-free
  variants. CJK-width-aware column padding so Chinese and English
  tables both align correctly.
- **"processing…" fallback indicator** — if the loop is busy but
  none of the targeted indicators (streaming row, ongoingTool,
  statusLine) are visible, a generic magenta spinner row fills the
  gap. Belt-and-suspenders: no more silent clock-ticks.
- **Clearer between-iter status wording** — changed from "thinking
  about the tool result…" (which sounded like a model-only phase)
  to "tool result uploaded · model thinking before next response…"
  so it's obvious the wait covers both the upload round-trip and
  the model's thinking time.

### Tests (+11, suite 416→427)

- `tests/telemetry.test.ts` (+4) — `inputCostUsd` covers cache-hit
  + cache-miss but not completion; `outputCostUsd` covers
  completion only; both return 0 for unknown models;
  `totalInputCostUsd + totalOutputCostUsd == totalCostUsd`.
- `tests/filesystem-tools.test.ts` (+2) — `edit_file` returns an
  inline `- search / + replace` diff; huge edit blocks get
  `… (N more lines)` marker in the middle.
- `tests/markdown.test.ts` (+5) — simple table with CJK header +
  cells, alignment-colon separators accepted, pipe-less headers
  accepted, bare `|` in prose doesn't false-trigger, escaped `\|`
  preserved inside cells.

---

## [0.4.9] — 2026-04-22

**Headline:** Three user-reported issues fixed together: Esc now
really stops (not "after the tool finishes"), `reasonix code` drops
the filesystem MCP subprocess for native tools with an R1-friendly
`edit_file` shape, and the placeholder cursor renders in the right
place. Plus a `slow_count` demo tool so progress bars are testable.

### Changed

- **Esc is now an immediate cancel**, not "cancel at the next iter
  boundary." The loop now threads an AbortController through every
  I/O path it can:
  - `DeepSeekClient.chat`/`.stream` already accepted `signal` — now
    wired at every call site (normal turn, branch sampling, forced
    summary), so Esc closes the HTTP/SSE stream immediately.
  - `ToolRegistry.dispatch` accepts `{ signal }` and passes a
    `ToolCallContext` to the tool's `fn`. Existing tools that don't
    consume the ctx keep working.
  - `McpClient.callTool({ signal })` sends an MCP
    `notifications/cancelled` for the in-flight request AND rejects
    the pending promise right away — no "wait for subprocess."
    Late responses are swallowed by `dispatch` because the id is
    already gone from `pending`.
  - `bridgeMcpTools` forwards `ctx.signal` straight into
    `client.callTool`, so MCP tools inherit the cancellation path.
- **Built-in filesystem tools** replace the
  `@modelcontextprotocol/server-filesystem` subprocess inside
  `reasonix code`. Ten tools — `read_file` (head/tail), `write_file`,
  `edit_file` (flat SEARCH/REPLACE, not the JSON-in-string array
  shape that triggered R1 DSML hallucinations), `list_directory`,
  `directory_tree`, `search_files`, `get_file_info`,
  `create_directory`, `move_file`. Sandbox enforcement on every
  path. New CLI output: `▸ reasonix code: … · 10 native fs tool(s)`.
  Library API: `registerFilesystemTools(registry, { rootDir })`.
  `ChatOptions` gains `seedTools: ToolRegistry` so callers can
  pre-register tools and still bridge MCP on top.

### Fixed

- **Placeholder cursor now renders at position 0**, not after the
  dimmed hint text. Matches "you're about to type here," not "you
  typed the placeholder." Only affects the empty-input view; when
  there's real content the cursor still follows the last char.

### Added

- **`slow_count` demo tool** in `examples/mcp-server-demo.ts` that
  emits real `notifications/progress` frames (1/N, 2/N, …) with
  300 ms pauses. Progress-bar plumbing from 0.4.8 is now testable
  end-to-end: `reasonix chat --mcp "demo=node --import tsx examples/mcp-server-demo.ts"` then ask the model to
  "please use slow_count to count to 5" → bar fills in the spinner.
- **`ToolCallContext`** public type (`{ signal?: AbortSignal }`),
  passed to every tool's `fn`. Re-exported from `src/index.ts`.

### Tests (+29, suite 387→416)

- `tests/filesystem-tools.test.ts` (new, +26) — read/write/edit
  happy paths, head/tail line selection, truncation on oversize,
  directory refusal, sandbox escape rejection (both relative `../`
  and absolute `/etc/…`), search case-insensitivity, empty-result
  formatting, `edit_file` multi-match refusal, move across dirs,
  `create_directory` idempotence, `allowWriting: false` trims the
  write-side tool set.
- `tests/mcp.test.ts` (+3) — AbortSignal rejects the pending
  promise, emits `notifications/cancelled` with the correct id,
  rejects immediately when called with an already-aborted signal.

---

## [0.4.8] — 2026-04-21

**Headline:** MCP progress notifications — long-running tool calls
now stream incremental progress into the spinner row instead of
sitting silent for minutes. "▸ tool\<fs_scan\> running… 42s" grows
to "[█████░░░░░░░░░░░░░░░] 500/2000 25%  reading src/…"  as the
server reports.

### Added

- **`McpClient.callTool(name, args, { onProgress })`** — attaches
  a fresh `_meta.progressToken` per call; server-emitted
  `notifications/progress` frames are routed to the handler until
  the final response arrives. Handler is dropped on completion or
  timeout — no leaks, late frames are silently swallowed.
- **Dispatch routing for `notifications/progress`** in the client's
  reader loop. Other server-initiated notifications are still
  dropped (list_changed frames not implemented yet).
- **`bridgeMcpTools({ onProgress })`** — pipes the per-call
  callback through to bridged tools. The info object includes the
  *registered* (prefix-applied) tool name so multi-server UIs can
  attribute progress correctly.
- **Progress bar in `OngoingToolRow`** — when a frame arrives with
  `total`, renders `[███░░░░░░] n/total pct%  message`. Without
  `total`, falls back to `progress: n  message`. Resets on each
  new tool call so stale progress doesn't linger.
- **Public types in `src/mcp/types.ts`**: `McpProgressHandler`,
  `McpProgressInfo`, `ProgressNotificationParams`. Re-exported
  from `src/index.ts` for library consumers.

### Tests (+5, suite 382→387)

- `tests/mcp.test.ts` (+5) — progress frames routed to onProgress
  in order; `_meta.progressToken` omitted when no callback is
  given; distinct token when present; late frames after resolution
  silently swallowed; `bridgeMcpTools` forwards progress with the
  prefixed tool name.

---

## [0.4.7] — 2026-04-21

**Headline:** Multi-line input in the chat TUI. Paste a code block
without it getting chopped on the first newline; compose structured
prompts across multiple lines; still hit Enter once to send.

### Added

- **Multi-line prompt input** replacing the old single-line
  `ink-text-input`. Newline-insertion paths, in order of terminal
  reliability:
  - `Ctrl+J` — universal (real ASCII LF), works on every terminal
  - `Shift+Enter` — works on terminals that enable CSI-u modifier
    reporting (iTerm2 with that setting on, WezTerm, Ghostty, etc.)
  - `\<Enter>` — bash-style line continuation, always works as a
    portable fallback
  - Pasted multi-line text lands intact instead of submitting on
    the first embedded `\r`.
- **Visible blinking cursor** on the active line so the input box
  looks alive even when you stop typing mid-compose.
- **`processMultilineKey` pure reducer** in `src/cli/ui/multiline-keys.ts`.
  Keystroke → action function that's fully unit-testable; the
  React component is a thin wrapper. Parent-owned keys (Tab for
  slash auto-complete, ↑/↓ for slash-nav + history, Esc for abort,
  left/right/page arrows) are no-ops in the reducer so the buffer
  never eats a stray control sequence when both parent and child
  `useInput` fire on the same event.

### Design notes

- No mid-string insertion cursor. Edits are cursor-at-end (backspace
  to delete, paste to insert). Matches how readline-in-raw-mode
  feels, covers ~95% of prompt-composition cases, and skips a pile
  of complexity (arrow-key cursor nav, selection, kill/yank) that
  would collide with the parent's arrow-key handling for slash-nav
  and history recall.
- `ink-text-input` is still used by `Wizard`, `Select`, `Setup` — it
  fits those single-line forms fine and didn't need replacing.

### Tests (+18, suite 364→382)

- `tests/multiline-keys.test.ts` (new) — printable input, multi-char
  paste, Enter-submit, Shift+Enter-newline, Ctrl+J (raw LF and
  normalized `ctrl+'j'`), bash continuation, backspace across
  newlines, delete, tab/arrows/esc/ctrl-letter/meta all ignored,
  empty-buffer edge cases.

---

## [0.4.6] — 2026-04-21

**Headline:** Slash-command UX overhaul + MCP discovery closes in
two places. Typing `/` now pops an IntelliSense-style suggestion
list you can walk with ↑/↓ and pick with Enter or Tab — no more
memorizing commands or reading a cluttered footer. The footer is
gone. `/mcp` inside chat now shows each server's tools + resources
+ prompts in one grouped view. For scripting/CI there's a new
`reasonix mcp inspect <spec>` CLI doing the same.

### Added

- **Slash autocomplete popup.** When the input starts with `/` and
  matches exist, a floating panel lists commands (name + args hint
  + one-line summary). ↑/↓ navigate the list; Tab inserts the
  highlighted name into the input; Enter runs it directly. Leaves
  slash mode the moment you type a space — then ↑/↓ goes back to
  shell-style prompt history as before. Registry lives in
  `SLASH_COMMANDS` and gates code-mode-only entries (`/apply`,
  `/discard`, `/undo`, `/commit`) behind the TUI's `codeMode` flag.
- **`/mcp` is now the discovery view.** Rich output per connected
  server: name + version + spec, tool count, resources list, prompts
  list. Unsupported sections collapse to `(not supported)` so a
  tools-only server still reads clean. Inspection happens once at
  chat startup and flows through `SlashContext.mcpServers` — the
  slash handler stays sync.
- **`reasonix mcp inspect <spec>`**. CLI counterpart to `/mcp`, for
  running outside chat (CI, scripting, "does this server even
  work?"). Same spec grammar as `--mcp`; `--json` emits the full
  report.
- **`inspectMcpServer(client)`** public API in `src/mcp/inspect.ts`.
  Pure function — testable against any `McpClient` instance; returns
  an `InspectionReport` with per-section `{supported, items}` or
  `{supported: false, reason}`. Re-exported from `src/index.ts`.
- **`McpClient.serverInfo` + `.protocolVersion` + `.serverInstructions`**.
  The full initialize handshake result is now exposed, not just
  `.serverCapabilities`. Needed by any UI that wants to surface
  "connected to X v1.2.3".

### Removed

- **Static command-strip footer under the input.** Took 3-4 dimmed
  lines listing a random subset of commands; superseded by the
  on-demand slash popup that only surfaces when the user asks for
  it (by typing `/`).

### Tests (+11, suite 353→364)

- `tests/mcp-inspect.test.ts` (new, +5) — full-support server,
  -32601 → `supported: false`, non-32601 forwarded as the section
  reason, serverInfo/protocolVersion/instructions accessors,
  undefined-instructions fallback.
- `tests/slash.test.ts` (+6) — `SLASH_COMMANDS` contains every
  handler case, `suggestSlashCommands` prefix + case + empty-string
  behavior, code-mode gating, `/mcp` rich view renders tools +
  resources + prompts grouped per server, `/mcp` spec-only fallback.

---

## [0.4.5] — 2026-04-21

**Headline:** Two protocol-level completions bundled together. (1)
DSML-hallucinated tool calls are now **recovered** (not just stripped
from display) — when R1 emits its chat-template markup in the content
channel instead of the proper `tool_calls` field, the repair pipeline
parses it back into a real ToolCall and executes it. (2) The MCP
client gains `resources/*` and `prompts/*` — the remaining method
families needed for spec parity beyond tools.

### Added

- **DSML invoke parser in `scavengeToolCalls`.** Pattern A in
  `src/repair/scavenge.ts` now recognizes `<｜DSML｜invoke name="X">…</｜DSML｜invoke>` blocks with nested `<｜DSML｜parameter name="k" string="true|false">v</｜DSML｜parameter>` children. `string="true"` → literal; `string="false"` → JSON. Both full-width `｜` and ASCII `|` variants accepted. Malformed JSON under `string="false"` falls back to a literal string so data isn't lost.
- **Content-channel scavenge.** `ToolCallRepair.process` now takes an
  optional third arg `content` and scans both reasoning + content for
  leaked calls. The loop wires `assistantContent` through. This closes
  the hole noted in the v0.4 deferred queue: before, DSML in a regular
  turn was stripped from display but the tool never ran.
- **MCP `resources/list` + `resources/read`** on `McpClient`. Types:
  `McpResource`, `McpResourceContents` (text + blob shapes),
  `ListResourcesResult`, `ReadResourceResult`. Pagination cursor
  supported.
- **MCP `prompts/list` + `prompts/get`** on `McpClient`. Types:
  `McpPrompt`, `McpPromptArgument`, `McpPromptMessage`,
  `McpPromptResourceBlock`, `ListPromptsResult`, `GetPromptResult`.
- **Initialize capabilities** now advertise `resources` and `prompts`
  alongside `tools`. Servers that don't implement them respond with
  −32601 method-not-found; client surfaces that as a thrown Error.

### Tests (+13, suite 340→353)

- `tests/repair/scavenge.test.ts` (+5) — DSML with string + JSON
  params, ASCII-pipe variant, allow-list skip, `string="false"`
  malformed-JSON fallback, no double-counting via Pattern B.
- `tests/repair/pipeline.test.ts` (+2) — content-channel DSML yields
  scavenged call; no double-count when DSML appears in both channels.
- `tests/mcp.test.ts` (+6) — list+read resources, method-not-found
  on unsupported server, capabilities payload advertises all three,
  cursor round-trip; list+get prompts with args, argument omission.

---

## [0.4.4] — 2026-04-21

**Headline:** `/tool` slash command — inspect the full untruncated
output of any tool call this session. The `EventLog` renderer has
always clipped tool results at 400 chars for display; when the model
says "I read your file, it says …", users had no way to verify that
claim against what the tool actually returned. Now they do.

### Added

- **`/tool`** (no arg) — list up to 10 most recent tool calls with
  tool name, char count, and a one-line preview. `#1` is the most
  recent; older entries are paged behind a "… (N earlier)" hint.
- **`/tool N`** — dump the Nth-most-recent tool result in full,
  untruncated. Reads from an in-memory ref populated as each `tool`
  event lands in `App.tsx`. Not persisted across process restarts
  (resumed sessions don't rebuild the history — the tool messages
  are still in the session log for the model's sake, but `/tool`
  history is per-process).
- **`SlashContext.toolHistory` callback** — the TUI passes
  `() => toolHistoryRef.current`; pure `handleSlash` tests stub
  an array directly. Keeps `slash.ts` stateless.

### Tests (+8, suite 332→340)

- `tests/slash.test.ts` (+8) — empty-history message, list ordering
  (most recent first), `/tool 1` dumps full content, `/tool 2`
  reaches one back, out-of-bounds message, non-numeric → usage,
  list pagination at 15 entries, `/help` mentions `/tool`.

---

## [0.4.3] — 2026-04-21

**Headline:** Seven more UX improvements on top of 0.4.2. Layered in
after live `reasonix code` sessions surfaced pain points: R1 fake
tool-call hallucinations leaking into forced summaries, no quick
retry, /status too thin, tool errors blending in, no prompt history,
no one-key pending-edit confirmation, and — critically — Esc
blocking for 30-90s on a reasoner call the user never asked for.

### Added

- **`/retry` slash command.** Truncates the log back to just before
  your last user message, then re-submits so the model runs a fresh
  turn from a clean slate. Persists the truncation to the session
  file. `SlashResult` grows a `resubmit?: string` field the TUI
  honors after displaying `info`.
- **`/status` is now a real situation-report.** Labeled table:
  model, harvest/branch/stream flags, last-turn context usage
  against the window (`42k/131k (32%)`), MCP server + tool counts,
  session name + log length + resumed-count, pending edit count.
- **Prompt history with ↑/↓.** Shell-style recall. Lives in an
  `App.tsx` ref; cursor −1 = live input, 0+ walks back. Process-
  scoped — no cross-run persistence.
- **Y/N fast-path for pending edits.** When pending count > 0,
  `y` + Enter = `/apply`, `n` + Enter = `/discard`. Doesn't
  interfere otherwise. Preview message ends with `(or y / n)`.

### Changed

- **Tool errors render red + ✗**, not yellow + →. Tool results
  prefixed `ERROR:` (from `flattenMcpResult` on `isError`) now
  visually distinguish from success. A failure needs different
  attention than a directory listing.
- **Esc abort no longer forces another API call.** Previously:
  Esc → `warning: aborted at iter N/M — forcing summary` → another
  full reasoner call that took 30-90s → done. Users reported the
  wait was the opposite of "cancel." Now: Esc → quick warning →
  synthetic `assistant_final` ("no summary produced — ask again
  or `/retry` when ready") → done. Takes milliseconds. Prior tool
  output stays in the log so a follow-up question hits the warm
  prefix cache. Budget / context-guard still call `forceSummary`
  because there the user didn't choose to stop; we did.

### Fixed

- **Forced-summary path no longer leaks DSML tool-call markup as
  prose.** Passing `tools: undefined` wasn't enough — R1 primed
  for tool use still emitted `<｜DSML｜function_calls>…
  </｜DSML｜function_calls>` as plain text. Two layers: (1) append
  an explicit user-role instruction at the end of the forced-summary
  message list ("summarize in plain prose, do NOT emit any tool
  calls or function-call markup"); (2) post-hoc strip known
  envelopes (DSML full-width, DSML ASCII, Anthropic
  `<function_calls>`, truncated un-closed DSML openers) from the
  response. Exported as `stripHallucinatedToolMarkup`. Fallback
  message when stripping leaves nothing points at `/retry` and
  `/think`.

### Tests (+13, suite 319→332)

- `tests/slash.test.ts` (+8) — `/think` empty/populated/help,
  `/retry` happy path + empty-log + help listing, `/status` new
  format + pending-edit suppression at count 0.
- `tests/loop-error.test.ts` (+5) — `stripHallucinatedToolMarkup`
  live R1 DSML shape, Anthropic-style, truncated un-closed opener,
  plain prose passthrough, all-markup edge case.
- `tests/loop.test.ts` — abort test rewritten to confirm no extra
  API call is made (previously asserted a "partial findings"
  summary from the never-needed follow-up).

---

## [0.4.2] — 2026-04-21

**Headline:** Three small but visible UX improvements from a real
session: tool-call spinner now shows elapsed time + meaningful args
(not raw JSON), reasoning preview shows the *tail* instead of the
head (where the decision actually lives), and a `/think` slash
command dumps the full R1 reasoning for the most recent turn.

### Changed

- **Tool-running row surfaces elapsed seconds + per-tool argument
  summary.** Instead of `⠋ tool<filesystem_edit_file> running… 
  {"path":"F:\\testtest\\index.html","edits":[…]}`, you now see:
    ```
    ⠋ tool<filesystem_edit_file> running… 3s
      path: F:\testtest\index.html (2 edits)
    ```
  Per-tool summarizers for `read_file`, `write_file`, `edit_file`,
  `list_directory`, `directory_tree`, `search_files`, `move_file`,
  `get_file_info`. Matches on suffix (`_read_file`) so namespaced
  servers (`filesystem_read_file`) and anonymous servers both work.
  Unknown tools fall back to a truncated raw-JSON preview — better
  than nothing.
- **Reasoning preview shows the tail, not the head.** R1 opens every
  turn with the same "let me look at the structure…" scaffolding, so
  previously the `↳ thinking: …` line repeated across turns and hid
  the real content in `(+N chars)`. Now the preview window shows the
  last ~260 chars — which is where the model actually decides what
  to do next. Users reported the head-only preview made R1 turns
  look identical; this fixes the underlying information-hiding bug.

### Added

- **`/think` slash command.** Dumps the full raw reasoning text from
  the most recent turn (read from `loop.scratch.reasoning`). Intended
  for when the 260-char tail isn't enough and you want to see R1's
  actual chain. Reports a helpful message if no reasoning is cached
  (e.g. the current model is `deepseek-chat`, which doesn't produce
  `reasoning_content`). Also listed as an alias `/reasoning`.
- **`/retry` slash command.** Truncates the log back to just before
  your last user message, then re-submits it so the model runs a
  fresh turn from a clean slate. Persists the truncation to the
  session file so reload doesn't rehydrate the stale exchange.
  Useful to resample R1 when the first try was off, without typing
  the question again. `SlashResult` grows a `resubmit?: string` field
  the TUI honors after displaying the result's `info` line.
- **`/status` is now a real situation-report.** Previously it was
  four key=value pairs on one line; now it's a labeled table
  covering model, harvest/branch/stream flags, last turn's context
  usage against the window (`42k/131k (32%)`), MCP server + tool
  counts, session name + log length + resumed-count, and pending
  edit count in code mode. One command, whole state.
- **Prompt history with ↑/↓.** Shell-style recall of previously
  submitted prompts. Lives in a ref in `App.tsx`; ↑ walks back, ↓
  walks forward (empty input at cursor=-1). Scoped to the current
  session process — no cross-launch persistence. Fast path for
  iterating on the same question with small tweaks.
- **Y/N fast-path for pending edits.** When edit blocks are waiting
  for `/apply` or `/discard`, typing just `y` or `n` + Enter maps
  to those commands. Doesn't interfere with normal input because
  the branch only triggers when pending count > 0. Preview line
  now ends with `(or y) … (or n)` so users know the shortcut exists.

### Changed

- **Tool-running row surfaces elapsed seconds + per-tool argument
  summary.** Instead of `⠋ tool<filesystem_edit_file> running…
  {"path":"F:\\testtest\\index.html","edits":[…]}`, you now see:
    ```
    ⠋ tool<filesystem_edit_file> running… 3s
      path: F:\testtest\index.html (2 edits)
    ```
  Per-tool summarizers for `read_file`, `write_file`, `edit_file`,
  `list_directory`, `directory_tree`, `search_files`, `move_file`,
  `get_file_info`. Matches on suffix (`_read_file`) so namespaced
  servers (`filesystem_read_file`) and anonymous servers both work.
  Unknown tools fall back to a truncated raw-JSON preview — better
  than nothing.
- **Reasoning preview shows the tail, not the head.** R1 opens every
  turn with the same "let me look at the structure…" scaffolding, so
  previously the `↳ thinking: …` line repeated across turns and hid
  the real content in `(+N chars)`. Now the preview window shows the
  last ~260 chars — which is where the model actually decides what
  to do next. Users reported the head-only preview made R1 turns
  look identical; this fixes the underlying information-hiding bug.
- **Tool errors render red, not yellow.** Tool results whose content
  starts with `ERROR:` (the prefix `flattenMcpResult` adds when the
  server reports `isError: true`) now show as a red `tool<X>  ✗`
  header + red body, instead of the same yellow `→` as successful
  results. A failure needs different attention than "here's your
  directory listing."

### Fixed

- **Forced-summary no longer leaks DSML tool-call markup as prose.**
  When the loop forces a no-tools summary (Esc / budget /
  context-guard), passing `tools: undefined` turned out not to be
  enough — R1 primed for tool use would still emit
  `<｜DSML｜function_calls>…</｜DSML｜function_calls>` as plain text,
  which rendered verbatim in the TUI. Fix is two layers:
    1. Inject an explicit user-role instruction at the end of the
       forced-summary message list ("summarize in plain prose, do
       NOT emit any tool calls or function-call markup").
    2. Post-hoc strip known hallucinated envelopes (DSML full-width,
       DSML ASCII, Anthropic-style `<function_calls>`, and
       truncated un-closed DSML openers) from the model's response
       before yielding. Exported as `stripHallucinatedToolMarkup(s)`
       so library callers building their own UIs can apply the same
       cleanup.
  When stripping leaves nothing behind, the loop emits a clear
  fallback message pointing at `/retry` and `/think` rather than
  showing an empty assistant turn.

### Tests (+13, suite 319→332)

- `tests/slash.test.ts` (+8) — `/think`, `/retry` happy path +
  empty-log path + help listing, `/status` new format with rich
  rows, `/status` pending-edit suppression at count 0.
- `tests/loop-error.test.ts` (+5) — `stripHallucinatedToolMarkup`
  against the live R1 DSML shape, Anthropic-style
  `<function_calls>`, truncated unpaired DSML opener, plain prose
  passthrough, and the all-markup-no-prose edge case.

---

## [0.4.1] — 2026-04-21

**Headline:** `reasonix code` grows `/undo`, `/commit`, `.gitignore`
awareness — and, **critically, stops auto-writing edits to disk.** A
real-session bug ("I asked to analyze the project, it silently edited
a file") exposed that v0.4.0's auto-apply was the wrong default.
Edits now sit as **pending** until the user says `/apply`. This
release also replaces the fixed iter-count budget with a
token-context guard, which you were right to call out as the correct
abstraction from the start.

### Fixed (behavior change for code-mode users)

- **Edits are now gated behind `/apply`.** Each assistant turn's
  SEARCH/REPLACE blocks are parsed and shown as a preview line
  (`▸ N pending edit block(s) — /apply to commit, /discard to drop`)
  with per-block `path  (-N +M lines)`. Nothing touches disk without
  explicit `/apply`. Pending state survives across user messages —
  you can keep chatting and land the batch later. Aider's model, which
  we should have picked from the start.
- **Forced-summary events are tagged `forcedSummary: true` on
  `LoopEvent`.** The code-mode edit applier ignores tagged events
  entirely. Without this, a budget / abort / context-guard summary
  could dump SEARCH/REPLACE blocks into output and silently turn
  "analysis" into "edit". This was the root-cause bug for the
  real-session report.
- **Token-context guard replaces iter count as the primary stop.**
  After every model response, if `promptTokens / contextWindow > 0.8`
  the loop emits a yellow warning, skips executing the tool calls the
  model just proposed, and diverts to the no-tools summary path
  (`reason: "context-guard"`). Iter cap bumped 24 → 64 as a
  last-resort backstop — the real constraint is the 131k-token
  window, not a magic iteration count.
- **Stray `EditSummary` / `summarizeEdit` reverted** from
  `src/code/edit-blocks.ts`. v0.4.0's auto-apply let the model write
  it during a failed forced-summary run. Nothing referenced it.
  Removed.
- **SEARCH/REPLACE blocks render as a real diff, not mangled prose.**
  Previously the Markdown renderer fed SEARCH/REPLACE content through
  the paragraph path — which joined lines with spaces and let the
  inline bold/italic regex eat `*` characters inside JSDoc `/** … */`
  comments. Output looked like `/** Edit landed on disk. /` with
  trailing `*` consumed and newlines flattened. Now the parser
  recognizes the `<filename>` / `<<<<<<< SEARCH` / `=======` /
  `>>>>>>> REPLACE` envelope and emits a dedicated `edit-block` block
  kind, rendered as `- ` / `+ ` diff rows with the filename on top
  and (new file) tagged for empty-SEARCH creations. No inline
  markdown inside — content is shown verbatim.
- **"Reasoning before it speaks" UX no longer looks frozen.** Under
  `deepseek-reasoner`, R1 streams `reasoning_content` first and
  `content` only after — often 20-90 seconds of silence from the
  user's perspective. The streaming preview used to show
  `(waiting for first token…)` during that window, making the app
  look hung. Now:
    - A cyan braille-spinner pulse ticks at 500 ms so the heartbeat
      is visible regardless of stream bursts.
    - Label switches `streaming` → `reasoning` while body is empty.
    - The "waiting" line is replaced with an explicit
      `R1 is thinking before it speaks — body text starts when
      reasoning completes (typically 20-90s)` so the user knows to
      wait, not to bail.
- **Tool calls now show a spinner while dispatching.** The loop
  gains a new `tool_start` event yielded *before* `await
  tools.dispatch(...)`, separate from the existing `tool` event
  yielded with the result. The TUI renders a
  `⠋ tool<filesystem_edit_file> running…` row (with a short args
  preview) while the Promise is pending. Without this, a multi-KB
  edit could sit for a full second with no visual feedback — the
  streaming block was already cleared on `assistant_final` and the
  input was disabled. Transcripts still only record the `tool`
  result event (not `tool_start`), so replay/diff output is
  unchanged.

### Added (code mode)

- **`/apply`** — commits pending edit blocks, snapshots for `/undo`,
  per-block status.
- **`/discard`** — forgets pending edits without writing.
- **`/undo`** — roll back the *last applied* edit batch. Restores
  files to their pre-`/apply` content, deletes any file the batch had
  just created. One level of history for now, Aider-style.
- **`/commit "msg"`** — `git add -A && git commit -m "msg"` inside
  the code-mode rootDir. Surfaces git's stderr on failure (hooks,
  nothing staged, detached HEAD, etc.).
- **.gitignore awareness** — `reasonix code` reads the project's
  `.gitignore` on launch and injects it into the system prompt as
  "don't traverse or edit these paths unless asked". Hard-coded
  baseline ignores (`node_modules`, `dist`, `.git`, `.venv`, etc.) are
  also baked into the base prompt for projects without a `.gitignore`.
  Stops the model wasting 5 tool calls listing `node_modules`.

### Tightened

- **`CODE_SYSTEM_PROMPT` gains a "when to edit vs. when to explore"
  section.** Explicitly tells the model: only propose edits when the
  user asks to change / fix / add / remove / refactor. For analyze /
  explain / describe, stay read-only. Belt-and-braces with the
  `/apply` gate below.

### Tests (+35, suite 292→318)

- `tests/edit-blocks.test.ts` (+5) — `snapshotBeforeEdits` +
  `restoreSnapshots` round-trip: restore modified file, delete
  newly-created file on undo, de-dup per path in batches, refuse
  path-escape in snapshots.
- `tests/code-prompt.test.ts` (+4 new file) — `.gitignore` injection:
  no-file case, happy path, truncation over 2KB, base prompt still
  names the built-in ignores.
- `tests/slash.test.ts` (+13) — `/apply`, `/discard`, `/undo`,
  `/commit`: inside vs. outside code mode, usage hint on empty
  message, double-quote stripping, help listing all of them.
- `tests/loop.test.ts` (+1) — context-guard warning + forced-summary
  flag when prompt tokens exceed 80% of the window.
- `tests/markdown.test.ts` (+5) — `parseBlocks` extracts SEARCH/
  REPLACE into `edit-block` blocks, preserves multi-line JSDoc
  verbatim, handles new-file (empty SEARCH), rejects stray markers
  without close, multi-block responses interleaved with prose.
- `tests/loop.test.ts` (+1) — `tool_start` precedes `tool` for each
  dispatch, so UI consumers can pair them.

### Notes

- If you relied on 0.4.0's auto-apply behavior in scripts, that's
  gone. For automation, call `applyEditBlocks` directly from the
  library — the CLI TUI is for interactive use where the new gate
  is correct.

---

## [0.4.0] — 2026-04-21

**Headline:** `reasonix code` — a new subcommand that turns Reasonix
into a coding assistant. Auto-bridges the filesystem MCP at your
working directory, teaches the model to emit Aider-style
SEARCH/REPLACE blocks, applies them to disk after each turn. The
"cheap Claude Code" pitch becomes real.

### Added

- **`npx reasonix code [dir]`** — opinionated wrapper around chat:
  - Filesystem MCP auto-bridged at `[dir]` (default CWD). No wizard,
    no config merge. Out-of-box ready.
  - Code-specialized system prompt that teaches SEARCH/REPLACE.
  - Reasoner + harvest on by default (coding tasks repay R1 thinking).
  - Per-directory session name (`code-<basename>`) so different
    projects don't share history.
- **SEARCH/REPLACE edit blocks** (`src/code/edit-blocks.ts`). The
  model emits:
    ```
    path/to/file.ts
    <<<<<<< SEARCH
    (exact existing lines)
    =======
    (replacement)
    >>>>>>> REPLACE
    ```
  Reasonix parses them from `assistant_final`, applies them under
  the root dir, reports each result (`✓ applied`, `✓ created`,
  `✗ not-found`, `✗ path-escape`, …) as an info line in the TUI.
  Empty SEARCH creates a new file (Aider convention). SEARCH must
  match byte-for-byte; we never fuzzy-match, because a silently wrong
  edit is worse than a loud rejection.
- **New public API** on the library: `parseEditBlocks`,
  `applyEditBlock`, `applyEditBlocks`, `CODE_SYSTEM_PROMPT`, and the
  types `EditBlock` / `ApplyResult` / `ApplyStatus`. Anyone building
  their own code-assistant UX can compose from these.
- **`ChatOptions.codeMode`** — opt-in flag to enable edit-block
  processing inside the existing TUI event loop. Plain `reasonix chat`
  leaves it off.

### Why 0.4.0 (minor, not patch)

This is a new user-facing primitive, not a bug fix or UX polish. The
library exports grow; the `ChatOptions` interface gains a field.
Nothing breaks for existing 0.3.x users — `reasonix chat` behaves
exactly as before when `codeMode` is absent. But the SemVer convention
is: additive new surface = minor bump.

### Tests (+13, suite 279→292)

- `tests/edit-blocks.test.ts` (+13 new file). `parseEditBlocks`
  round-trips single + multi + multi-line + empty-SEARCH blocks, and
  ignores stray 7-char runs in arbitrary prose. `applyEditBlock`
  covers happy path, new-file creation, not-found rejection,
  file-missing, path-escape defense, first-occurrence semantics.
  Batch `applyEditBlocks` confirms failures don't cascade.

### Notes

- v1 scope is deliberately narrow: no `/commit`, no `/undo`, no
  .gitignore filtering, no diff preview. The user's own `git diff` +
  `git checkout` is the review + undo surface — and we run inside a
  git repo by convention.
- The ctx gauge + Esc + /compact safety net from 0.3.1/0.3.2 applies
  equally to code mode. Exploring a large repo now has visible
  progress and a hard off-switch.

---

## [0.3.2] — 2026-04-21

**Headline:** Long exploration sessions are now interruptible and
self-announcing. 0.3.1's forced-summary was a terminal safety net;
this release turns it into an interactive budget with a visible warning
at 70% and `Esc` to cash out early. Plus a README rewrite so new users
actually know the new UX exists.

### Added

- **Esc while thinking → force a summary now.** `CacheFirstLoop` grows
  an `abort()` method; the TUI's `useInput` wires Esc to it during
  busy state (guarded by a once-per-turn flag). The loop checks the
  abort flag at each iteration boundary, lets any in-flight tool call
  complete, then diverts to the same no-tools summary path introduced
  in 0.3.1 — prefixed `[aborted by user (Esc) — summarizing what I
  found so far]`.
- **Yellow warning at 70% of tool-call budget.** New `"warning"`
  `EventRole` + `DisplayRole`, yielded once per step when tool-iter
  count reaches `Math.floor(maxToolIters * 0.7)`. TUI renders it
  yellow in the event log with the "Press Esc to summarize now" hint.
  The command strip under the prompt also advertises the Esc hotkey.
- **README hero rewrite.** `npx reasonix` (no flags) is now the first
  code block, with the wizard story in prose; `--mcp`/`--preset`
  moved to an "Advanced — CLI subcommands and flags" section.
  What-you-get table gains *Setup wizard*, *Context safety net*
  (tool-result cap + heal-on-load + `/compact` + ctx gauge + Esc),
  and merges the MCP transports into one row. Non-goals and
  configuration sections trimmed to match the new flow.

### Tests (+2, suite 277→279)

- `tests/loop.test.ts` (+2) — warning fires exactly once at the 70%
  threshold and the content carries `N/budget tool calls used` +
  `Esc`. `abort()` mid-step pulls the loop into the summary path,
  surfacing an `aborted by user` prefix on the final event.

---

## [0.3.1] — 2026-04-21

**Fixes a silent stop** that surfaced on the first real MCP exploration
task after 0.3.0 shipped: the reasoner chained 8 filesystem tool calls
against a project and the loop quietly exited at the `maxToolIters`
ceiling without showing the user any answer — no error, no summary,
just a hung-looking terminal.

### Fixed

- **Tool-call budget now produces a summary instead of stopping silent.**
  When `maxToolIters` is exhausted with tool calls still pending, the
  loop now makes one final call *with tools disabled*, forcing the
  model to produce a text answer from everything it gathered. Yielded
  as a normal `assistant_final` event prefixed with
  `[tool-call budget (N) reached — forcing summary from what I found]`.
- **Default `maxToolIters` raised from 8 → 24.** Eight was never enough
  for real filesystem / MCP work (read_file → list → read_file chains
  easily top that). Twenty-four is a workable ceiling that still caps
  the damage from a confused model. Pass a number to
  `new CacheFirstLoop({ maxToolIters: N })` to tune per call site.

### Tests

- `tests/loop.test.ts` (+1) — tight `maxToolIters: 2` scenario where
  every step still wants to call tools, proves the summary call fires,
  the annotated `assistant_final` contains the fallback text, and the
  stream still ends with `done`.
- Suite: **277 passing** (was 276).

---

## [0.3.0] — 2026-04-21

**Stable.** MCP (stdio + SSE, multi-server) + first-run wizard +
context-safety (result cap + auto-heal + `/compact`). The `0.3.0-alpha.*`
series graduates — `npm install reasonix@latest` now pulls this.

### Added — since 0.2.2

- **MCP client**: stdio + HTTP+SSE transports, tools/list + tools/call,
  repeatable `--mcp` flag with `name=` namespacing, curated catalog
  (`reasonix mcp list`), bundled demo server.
- **`reasonix setup` wizard**: API key → preset pick → MCP multi-select
  → per-server args → `~/.reasonix/config.json`. `npx reasonix` with
  no args launches this on first run and drops into chat afterward.
- **Config-backed defaults**: `preset`, `mcp`, `session` persist across
  launches; CLI flags override; `--no-config` escape hatch.
- **Context gauge in StatsPanel** (NEW this release): `ctx 42k/131k
  (32%)` next to cache/cost. Turns yellow at 50%, red at 80%, adds a
  `· /compact` nudge at red.
- **`/compact` slash** (NEW this release): shrinks every oversized
  tool result in the log with a tighter 4k cap (configurable via
  `/compact <chars>`), rewrites the session file on disk. Reports
  `▸ compacted N tool result(s), saved M chars (~T tokens)`.
- **`/mcp` and `/setup` slashes**: inspect attached servers, point at
  the reconfigure command.

### Fixed — since 0.2.2

- `shellSplit` no longer mangles Windows paths outside quotes.
- Windows `--mcp "npx ..."` works via automatic `.cmd`/`.bat` resolution.
- `@modelcontextprotocol/server-fetch` and `server-sqlite` removed from
  the catalog (Python-only reference impls, not on npm).
- One broken MCP server no longer kills the chat — per-spec failures
  print `▸ MCP setup SKIPPED` and the session continues.
- Tool results capped at 32k chars by default (override via
  `bridgeMcpTools(client, { maxResultChars: N })`). Sessions from
  pre-alpha.6 clients auto-heal on load — `▸ session "X": healed N
  oversized tool result(s)…`.
- DeepSeek 400 `maximum context length` errors now decorate with
  actionable advice + pretty-printed token figure.

### Tests

- Suite: **276 passing** (was 224 at 0.2.2).
- New files this release: `tests/resolve.test.ts`, `tests/wizard.test.ts`,
  `tests/loop-error.test.ts`, `tests/mcp-sse.test.ts`.

### Breaking changes

None against a 0.2.2 user. The config schema grew, but missing fields
fall through to defaults. MCP-specific API additions (`McpSpec` is now
a discriminated union, `FlattenOptions`, `DEFAULT_MAX_RESULT_CHARS`)
are all new surface.

### Deprecated

None.

---

## [0.3.0-alpha.6] — 2026-04-21

**Headline:** A single oversized tool result (e.g. `read_file` on a big
file) used to silently poison a session — the 3 MB payload landed in
history and every subsequent turn 400'd with *"maximum context length
is 131072 tokens. However, you requested 929,452 tokens."* Fixed at
both ends: prevent it, and diagnose it.

### Fixed

- **MCP tool results are now capped at 32,000 chars by default.**
  Oversized results are sliced head + 1 KB tail and separated by a
  `[…truncated N chars…]` marker so the model still sees both ends
  (common case: error messages appended after a stack trace). Override
  via `bridgeMcpTools(client, { maxResultChars: N })`. Rationale: ~8k
  English tokens or ~16k CJK tokens — fits with headroom across 5–10
  tool calls even at the context limit.
- **Heal-on-load: poisoned sessions from older clients auto-repair.**
  On session resume, every tool-role message whose content exceeds the
  cap is truncated with the same head + tail policy. A stderr line
  `▸ session "X": healed N oversized tool result(s)…` names the scope
  of the repair. User and assistant messages are untouched — the
  conversation flow is preserved, only the bloat from a past
  `read_file` (etc.) shrinks. Without this, any session built with
  pre-alpha.6 clients would tip over the 131k-token limit *on the very
  first new prompt*, before the new 32k cap could matter.
- **`DeepSeek 400: maximum context length` errors now show actionable
  advice** instead of a raw JSON blob. The decorated message points at
  the heal-on-load behaviour, `/forget` (nuke the session file) and
  `/clear` (drop the display history), and pretty-prints the
  requested-token figure.

### Added

- `DEFAULT_MAX_RESULT_CHARS` (= 32,000) export for callers that want
  to raise or lower the cap programmatically.
- `truncateForModel(s, maxChars)` helper export — same head + tail
  policy, usable by non-MCP tool adapters that want the same protection.
- `FlattenOptions` type export (just `{ maxChars? }` today).
- `formatLoopError(err)` export — the error-decorator used by the loop,
  exposed so library callers get the same advice when catching errors
  outside the TUI.
- `healLoadedMessages(messages, maxChars)` export — the session-heal
  helper, exposed so library callers who build their own resume flows
  can apply the same policy.

### Tests (+9, suite 262→271)

- `tests/mcp.test.ts` (+3) — truncation with head + tail preserved,
  no-op below cap, end-to-end `bridgeMcpTools` dispatch capped by
  default.
- `tests/loop-error.test.ts` (+6 new file) — overflow annotation with
  token figure, non-overflow passthrough, overflow without a figure,
  heal-on-load truncating tool-role messages while leaving user and
  assistant messages intact, no-op when all messages fit, multi-hit
  healing across several oversized rows.

### Migration note

This is a silent behaviour change for any library user whose MCP tool
was counting on >32k-char results making it to the model verbatim. If
that's you, pass `maxResultChars: Infinity` (or a higher explicit
value) to `bridgeMcpTools`.

---

## [0.3.0-alpha.5] — 2026-04-21

**Headline:** `reasonix setup` replaces the CLI-flag maze. New users run
one command, pick from an arrow-key checklist, and every later launch
remembers what they chose. The `--mcp "name=npx -y @scope/pkg /path"`
syntax still works for scripts and power users — it's just no longer
the *only* way to turn MCP on.

### Added

- **`reasonix setup`** — interactive Ink wizard:
  1. Paste API key (skipped if already set via env or previous run)
  2. Pick a preset: `fast` / `smart` / `max` (bundles of model +
     harvest + branch budget — no more "what's the right model id?")
  3. Multi-select MCP servers from the curated catalog (space to
     toggle, enter to confirm). Per-server parameters (filesystem
     directory, sqlite path) are prompted inline.
  4. Review + save to `~/.reasonix/config.json`.
  Re-run any time to reconfigure — existing selections are pre-checked.
- **`reasonix` with no subcommand** — launches the wizard on first run,
  drops straight into chat afterwards using saved defaults. Designed
  so a brand-new user can `npx reasonix` and be chatting in 30s
  without reading `--help`.
- **`--preset <fast|smart|max>`** on both `chat` and `run`. Picks the
  same bundles the wizard offers. Individual flags (`--model`,
  `--harvest`, `--branch`) still override when you want to be specific.
- **`--no-config`** escape hatch on `chat` and `run` — ignore
  `~/.reasonix/config.json` entirely (useful for CI, reproducing
  a bug report against default settings, or isolating shared boxes).
- **`/mcp` slash command** — shows the spec strings attached to the
  current session and the tool registry (handy mid-chat when you want
  to remember what a tool is called).
- **`/setup` slash command** — prints instructions to exit and re-run
  `reasonix setup`. Live reconfiguration mid-session is out of scope:
  changing the tool set would reset the byte-stable prefix and
  invalidate the cache-first guarantees that define Reasonix.

### Changed

- **`ReasonixConfig` schema** grows: `preset`, `mcp` (spec strings),
  `session`, `setupCompleted`. Previous configs (apiKey-only) still
  load; missing fields fall through to hardcoded defaults.
- `reasonix chat` / `reasonix run`: when a flag is not passed, the
  value comes from `~/.reasonix/config.json`. Explicit flags still
  win. `--no-config` short-circuits this.
- Slash handler signature: `handleSlash(cmd, args, loop, ctx?)` — the
  new `ctx` carries per-session state like `mcpSpecs`. Old callers
  that passed three args continue to compile.

### Tests (+21)

- `tests/resolve.test.ts` (+11) — precedence order: flag → --preset
  → config.preset → fast defaults; `--no-config`, `--no-session`,
  `--branch` cap and off cases.
- `tests/config.test.ts` (+2) — full `ReasonixConfig` round-trip,
  `session: null` interpreted as ephemeral.
- `tests/slash.test.ts` (+4) — `/mcp` empty + populated, `/setup`
  prints the reconfigure hint, help lists both.
- `tests/wizard.test.ts` (+4) — `buildSpec` → `parseMcpSpec`
  round-trip on filesystem / memory / spaces-in-path / unknown-entry
  degrade-gracefully.
- Suite: **262 passing** (was 241).

### Fixed

- **Catalog no longer lists Python-only servers.** `fetch` and `sqlite`
  reference MCP servers are distributed as `pip install
  mcp-server-fetch` / `mcp-server-sqlite`, not npm packages. They
  were in the catalog by mistake, which meant picking them in the
  wizard produced a spec that always 404'd on `npm install` when the
  child was spawned. Removed. The remaining five entries
  (`filesystem`, `memory`, `github`, `puppeteer`, `everything`) are
  verified-on-npm as of this release.
- **One broken MCP server no longer kills the whole chat/run.** Before:
  any spawn or initialize failure on any server called
  `process.exit(1)`, losing the session and the other working servers.
  Now: each failure prints a `▸ MCP setup SKIPPED` line pointing at
  `reasonix setup` and the session continues with whatever succeeded.

### Notes

- The wizard's Ink rendering is verified manually — unit-testing
  arrow-key handling would mean pulling in `ink-testing-library`
  (another dev dep) to exercise mechanically obvious `setState`
  calls. The pure data layer (what gets written to config.json) is
  tested end-to-end via `buildSpec → parseMcpSpec`.
- Existing `npm publish --tag alpha` users: if you published
  alpha.4 already, alpha.5 is a *pure additive* upgrade — config
  files written by alpha.4 continue to work; `setupCompleted: false`
  is assumed on migration so the wizard offers itself on first launch.

---

## [0.3.0-alpha.4] — 2026-04-21

**Headline:** MCP over HTTP+SSE. Bridge *remote* / hosted MCP servers,
not just local subprocesses. Pass a URL to `--mcp` and Reasonix opens
an SSE stream and POSTs JSON-RPC to the endpoint the server advertises.

### Added

- **`SseTransport`** (`src/mcp/sse.ts`) — 2024-11-05 HTTP+SSE wire:
  GET the SSE URL, wait for `event: endpoint`, POST every outgoing
  JSON-RPC frame to that URL, read responses off the SSE channel.
  Headers are passthrough, so `Authorization: Bearer ...` works for
  hosted servers behind auth.
- **`--mcp` now accepts URLs.** The parser routes anything starting
  with `http://` or `https://` to `SseTransport`; everything else is
  stdio as before. Both namespaced and anonymous forms work:
    ```
    reasonix chat --mcp "kb=https://mcp.example.com/sse"
    reasonix run  --mcp "http://127.0.0.1:9000/sse" --task "..."
    ```
- `McpSpec` is now a discriminated union:
  `{ transport: "stdio", command, args } | { transport: "sse", url }`.
  Callers who inspected `spec.command` / `spec.args` need to branch on
  `spec.transport` first — not a concern for `--mcp` CLI users.
- `src/index.ts` exports `SseTransport`, `SseTransportOptions`,
  `parseMcpSpec`, and the `McpSpec` union types.

### Tests

- `tests/mcp-sse.test.ts` (+4) — in-process `http.Server` fake that
  implements the SSE wire. Covers: relative-path endpoint resolution,
  absolute endpoint URLs, a full `McpClient.initialize` →
  `listTools` round-trip over SSE, and handshake-failure propagation.
- `parseMcpSpec` SSE cases (+4) — anonymous URL, namespaced URL,
  case-insensitive scheme, and `ws://` staying routed to stdio (no
  surprise detection beyond the two supported schemes).
- Suite: **241 passing** (was 233).

### Notes

- Still targeting MCP protocol `2024-11-05`. The 2025-03-26 spec's
  "Streamable HTTP" transport (single endpoint, no separate SSE GET)
  is a separate body of work — deferred until there's a server in
  the wild worth testing against.

---

## [0.3.0-alpha.3] — 2026-04-22

**Headline:** multi-server MCP + discovery command. Bridge two or more
MCP servers into one chat session, and stop guessing what servers exist
— `reasonix mcp list` prints a curated catalog with copy-paste commands.

### Added

- **Repeatable `--mcp`** — pass the flag multiple times to bridge
  multiple MCP servers into the same `ToolRegistry`. New spec syntax:
    `"name=cmd args..."`   → tools land namespaced as `name_toolname`
    `"cmd args..."`        → anonymous (tools keep native names)
  Example:
    ```
    reasonix chat \
      --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe" \
      --mcp "mem=npx -y @modelcontextprotocol/server-memory"
    ```
  Tools show up as `fs_read_file`, `mem_set`, etc.
- **`reasonix mcp list`** — curated catalog of popular official MCP
  servers (filesystem / fetch / github / memory / sqlite / puppeteer /
  everything) with ready-to-paste `--mcp` commands. Hardcoded because
  the list changes slowly; fetching over the network would make it
  flaky offline. `--json` prints the machine-readable form.
- `src/mcp/spec.ts::parseMcpSpec` — small helper exposed if library
  callers want the same `name=cmd` parsing. Not exported from the
  barrel yet; can be promoted when there's demand.
- `src/mcp/catalog.ts::MCP_CATALOG` — the curated list.

### Fixed

- **`shellSplit` mangled Windows paths outside quotes.** Backslashes
  were being treated as POSIX escape chars, so `C:\path\to\dir` turned
  into `C:pathtodir`. Now backslashes only escape inside double
  quotes; outside, they pass through literally. Matches user
  expectation on Windows; POSIX users who want escape-a-space should
  quote the arg instead.

### Tests

- `parseMcpSpec` (+8) — name=cmd form, anonymous form, Windows drive
  letters (must not look like namespace), identifier edge cases,
  empty / malformed input.
- Multi-server integration test (+1) — spawn two demo subprocesses
  concurrently with different prefixes, dispatch to each, verify no
  cross-talk.
- `shellSplit` Windows-path behavior (+1).
- Suite: **233 passing** (was 224).

---

## [0.3.0-alpha.2] — 2026-04-22

**Headline:** Windows `--mcp` actually works now, plus a second live
data point through the *official* `@modelcontextprotocol/server-filesystem`.

### Fixed

- **Windows `npx`/`pnpm` MCP launch**. `StdioTransport` now defaults to
  `shell: true` on win32 so `.cmd` shims (npx.cmd, pnpm.cmd) resolve.
  Previously `--mcp "npx -y ..."` failed with EPIPE on Windows because
  `spawn("npx")` couldn't find `npx.cmd` without a shell. POSIX behavior
  unchanged.
- **Silenced Node's `DEP0190` deprecation warning.** Under `shell: true`
  with an args array, Node concatenates args without quoting — unsafe
  if any arg contains shell metacharacters. We now build a quoted
  command line ourselves (command bare so PATH lookup works, args
  platform-quoted) and pass it as a single string. No more warning on
  `--mcp` runs.

### Added

- **`StdioTransportOptions.shell?: boolean`** — explicit opt-in/out of
  shell-mode spawning. Platform default still wins when omitted.
- **Second reference transcript** —
  `benchmarks/tau-bench/transcripts/mcp-filesystem.jsonl`. Live run
  through `@modelcontextprotocol/server-filesystem` (14 external tools,
  code we don't control): **5 turns, 4 tool calls, cache 96.7%,
  cost $0.00124, 97% cheaper than Claude** at equivalent tokens. The
  run includes a deliberate permission-denied recovery to show
  cache-first holds under realistic agent messiness.
- README table now shows both MCP data points side-by-side (bundled
  demo vs official external server).

### Tests

- Integration tests explicitly set `shell: false` (they spawn `node.exe`
  by absolute path — no shim needed). Suite still 224/224.

---

## [0.3.0-alpha.1] — 2026-04-22

**Headline:** MCP client lands. Any
[Model Context Protocol](https://spec.modelcontextprotocol.io/) server's
tools now flow through the Cache-First Loop automatically — cache-hit and
repair benefits extend to the entire MCP ecosystem.

Verified end-to-end on live DeepSeek: `reasonix run --mcp "..."` spawns an
MCP server, bridges its tools, calls them from the model. The follow-up
turn after the tool call hit **96.6% cache**, 94% cheaper than Claude at
same token counts. Reference transcript committed at
`benchmarks/tau-bench/transcripts/mcp-demo.add.jsonl`.

### Added

- **`reasonix chat --mcp "<cmd>"`** and **`reasonix run --mcp "<cmd>"`** —
  spawn an MCP server and bridge its tools into the Cache-First Loop.
  Shell-quoted command; use `--mcp-prefix` to namespace tool names when
  mixing servers.
- **Hand-rolled MCP client** (`src/mcp/`) — zero runtime deps. JSON-RPC
  2.0 + MCP initialize / tools/list / tools/call over stdio NDJSON.
  Official `@modelcontextprotocol/sdk` deliberately not used; see
  `src/mcp/README.md` for the reasoning.
- **`bridgeMcpTools(client)`** — walk an MCP server's tools/list result
  and register each into a Reasonix `ToolRegistry`. MCP tools become
  indistinguishable from native tools to the loop, inheriting
  Cache-First + repair (scavenge / flatten / storm) automatically.
- **Bundled demo MCP server** — `examples/mcp-server-demo.ts`, ~160
  lines, zero deps. Exposes `echo` / `add` / `get_time`. Lets any user
  try the whole integration locally with no external install.
- **`shellSplit()`** — small shell-style command parser used by the
  `--mcp` flag. Respects single/double quotes, backslash escapes,
  tab-space runs. Throws on unterminated quotes.
- Library exports: `McpClient`, `StdioTransport`, `bridgeMcpTools`,
  `flattenMcpResult`, `MCP_PROTOCOL_VERSION`, and related types.

### Tests

- **+21 tests**:
  - `tests/mcp.test.ts` (10) — in-process fake transport covering
    handshake, list, call, errors, bridge, name prefixing, result
    flattening.
  - `tests/mcp-shell-split.test.ts` (9) — quote handling, escapes,
    unterminated-quote error, whitespace-only input.
  - `tests/mcp-integration.test.ts` (2) — real subprocess against
    the bundled demo server via `node --import tsx …` (cross-platform,
    avoids Windows `.cmd` resolution).
- Suite: **224 passing** (was 203 at v0.2.2).

### Known limits (next alpha)

- No SSE transport — stdio only.
- No resources / prompts methods — tool-use only.
- No progress notifications — tool calls are assumed complete on first
  response.
- No streaming tool results.

### Also in this release

- **harvest-bench 18-run data + findings** (no release on its own —
  data was illuminating, conclusion was "V3 is strong enough that
  harvest doesn't differentiate on common math", see
  `benchmarks/harvest/report.md`). Informed the decision to ship MCP as
  the v0.3 headline rather than a harvest-accuracy claim.
- **`--timeout` flag** on harvest-bench runner, default 300s. Fixes
  120s-default client timeout on long R1 + harvest runs.

---

## [0.2.2] — 2026-04-21

**Headline:** 48-run bench data (3 repeats × 8 tasks × 2 modes). Reasonix
now scores **100% pass rate (24/24)** against 96% baseline; cache-hit
delta holds at **+47.7pp** with variance well under the last single-run
numbers.

### Fixed

- **t05 predicate relaxed** (`benchmarks/tau-bench/tasks.ts`). The task
  required "no refund on a processing order" and formerly also required
  status to stay `processing`, penalizing an agent who offered
  cancellation as a helpful alternative. The new predicate passes iff
  no refund row is written AND the order ends in `{processing, cancelled}`
  — either refusal or helpful substitution counts. Cancellation was
  marking reasonix as fail on its single run in v0.1; with this fix
  reasonix now passes every refusal task in every repeat.

### Changed

- **README headline numbers updated** to the 48-run set. Baseline shows
  one failure out of 24 (a `t07_wrong_identity` run where baseline
  skipped identity verification); Reasonix held the guardrail on every
  run.
- **`benchmarks/tau-bench/report.md`** regenerated from the 48-run
  results. Cost estimate vs Claude Sonnet 4.6 stays at ~96% cheaper
  per task.
- **`benchmarks/tau-bench/results.json`** replaced with the 48-run data.

### Tests

- +3 tests pinning the three t05 outcomes (refuse / cancel / illegally
  refund). Suite: **172 passing** (was 169).

---

## [0.2.1] — 2026-04-21

**Headline:** v0.2 grows eyes. `reasonix replay` and `reasonix diff` now
open interactive Ink TUIs by default. The stdout paths still work when
piped, so CI / `less` / markdown-export workflows aren't disturbed.

### Added

- **Interactive `reasonix replay <transcript>`** — Ink TUI with
  per-turn navigation (`j`/`k`/space/arrows, `g`/`G` for jump-to-edge,
  `q` to quit). Sidebar re-renders cumulative cost / cache / prefix
  stability as the cursor moves, so "how did the cache hit rate climb
  over the conversation?" is answered visually instead of in
  aggregate.
- **Interactive `reasonix diff <a> <b>`** — split-pane Ink TUI. Both
  sides scroll together; `n` / `N` jump the cursor to the next / prev
  divergent turn (the whole point of a diff tool). Cursor defaults to
  the first divergence so you skip the "identical setup turns".
- **Shared `RecordView` component** (`src/cli/ui/RecordView.tsx`)
  used by both TUIs — consistent visual grammar (user cyan, assistant
  green with cache badge, tool yellow, error red). Replaces the
  inline renderer in `ReplayApp`.
- **Pure navigation helpers** in `src/diff.ts`:
  `findNextDivergence(pairs, fromIdx)` and
  `findPrevDivergence(pairs, fromIdx)`. Unit-testable without Ink.
  Both guard against out-of-bounds `fromIdx`.
- **Pure replay nav helpers** in `src/replay.ts`:
  `groupRecordsByTurn(records)` and `computeCumulativeStats(pages, upToIdx)`.
  Used by the TUI sidebar; also individually testable.
- **New CLI flags** on both commands:
  - `reasonix replay --print` — force stdout pretty-print (auto when
    stdout isn't a TTY, or when `--head` / `--tail` is passed).
  - `reasonix diff --print` — force stdout table.
  - `reasonix diff --tui` — force Ink TUI even when piped (rare
    escape hatch).

### Changed

- **`reasonix replay` default** is now the TUI. Old stdout behavior
  reachable via `--print` or by piping. Non-TTY detection
  automatically flips to stdout mode, so shell pipelines behave as
  they did in 0.2.0.
- **`reasonix diff` default** picks itself from context:
  - `--md <path>` → write markdown + print summary (unchanged).
  - `--print` or piped stdout → stdout summary table.
  - TTY, no `--md`, no `--print` → TUI.

### Tests

- +10 new tests (`replay.test.ts` +6: `groupRecordsByTurn` +
  `computeCumulativeStats`; `diff.test.ts` +4: divergence navigation).
  Suite: **169 passing** (was 159).

---

## [0.2.0] — 2026-04-21

**Headline:** v0.2 makes the v0.1 cache-hit claim *auditable*. Any reader
can now verify the 94.3% / −42% numbers from committed JSONL transcripts
— no API key required.

### Added

- **`reasonix replay <transcript>`** — pretty-print a past transcript and
  rebuild its full session summary (turns, tool calls, cache hit, cost,
  prefix stability) offline. No API calls.
- **`reasonix diff <a> <b>`** — compare two transcripts: aggregate deltas,
  first divergence (with Levenshtein similarity for text + exact match
  for tool-name / args), prefix-stability story. Optional `--md <path>`
  writes a blog-ready markdown report.
- **`benchmarks/tau-bench/transcripts/`** — committed reference transcripts
  (baseline + reasonix on `t01_address_happy`) so anyone can clone the
  repo and run `reasonix replay` / `diff` immediately, without running
  the bench.
- **Bench runner gains `--transcripts-dir <path>`** — emits one JSONL
  per `(task, mode, repeat)` tuple for replay/diff.
- New library exports: `computeReplayStats`, `replayFromFile`,
  `diffTranscripts`, `renderDiffSummary`, `renderDiffMarkdown`,
  `parseTranscript`, `recordFromLoopEvent`, `writeRecord`.

### Changed

- **Transcript format bumped (backward-compatible)**. Records now carry
  `usage`, `cost`, `model`, `prefixHash` (reasonix only), and `toolArgs`.
  All fields optional on read — v0.1 transcripts still parse (cost/cache
  shown as n/a). A `_meta` line at the top records source/model/task
  metadata.
- **Baseline bench runner now emits per-sub-call transcripts**. Previously
  wrote one aggregated record per user turn, which made diff's
  apples-to-apples "model calls" count off. Now both modes emit at the
  same granularity.
- **Diff rendering label change**: "turns (assistant)" → "model calls",
  with "user turns" as a separate row in the summary table. Removes the
  ambiguity that hit when comparing baseline vs reasonix.
- **Top-level README**: `validated numbers` table now shows the 16-run
  τ-bench-lite results (94.3% cache, −42% cost) and links to the
  committed reference transcripts.
- **Exposed `LoopEvent.toolArgs`** so transcript writers can persist
  *what* the model sent to each tool, not just the result.

### Fixed

- Windows-only entrypoint bug in the bench runner
  (`import.meta.url === file://${argv[1]}`) — replaced with
  `pathToFileURL(argv[1]).href` so `main()` actually runs on Windows.

### Tests

- 17 new tests across `transcript.test.ts` (3), `replay.test.ts` (3),
  and `diff.test.ts` (11). Total suite: 159 passing.

---

## [0.1.0] — 2026-04-21

**Headline:** first reproducible evidence for Pillar 1 (Cache-First Loop).

### Added

- **`benchmarks/tau-bench/`** — τ-bench-lite harness. 8 retail-flavored
  multi-turn tool-use tasks with a DeepSeek V3 user simulator,
  deterministic DB-end-state success predicates (no LLM judge), and a
  cache-hostile naive baseline runner. Schema mirrors Sierra's τ-bench
  so upstream tasks can drop in.
- **`benchmarks/tau-bench/runner.ts`** — orchestrator with
  `--task` / `--mode` / `--repeats` / `--dry` / `--verbose` flags.
- **`benchmarks/tau-bench/report.ts`** — renders results JSON into a
  blog-ready markdown summary with explicit scope caveats.
- **Live bench numbers** published in `benchmarks/tau-bench/report.md`:
  - cache hit: baseline 43.9% → reasonix **94.3%** (+50.3pp)
  - cost/task: baseline $0.00278 → reasonix **$0.00162** (−42%)
  - vs Claude Sonnet 4.6 (token-count estimate): **~96% cheaper**
  - pass rate: 100% (baseline) vs 88% (reasonix; 1 predicate too strict,
    documented)

### Tests

- 8 new tests in `tests/benchmarks.test.ts` covering DB isolation,
  check-predicate satisfiability, and tool guards — all runnable without
  an API key. Total suite at this release: 143 passing.

---

Earlier `0.0.x` versions covered Pillar 1 + Pillar 3 internals, retry
layer, first-run API key prompt, harvest MVP, self-consistency
branching, and session persistence. They're not reflected as individual
entries above because the `0.1.0` bench harness is what first produced
*externally verifiable* evidence for their value.

[0.3.0-alpha.3]: https://github.com/esengine/reasonix/releases/tag/v0.3.0-alpha.3
[0.3.0-alpha.2]: https://github.com/esengine/reasonix/releases/tag/v0.3.0-alpha.2
[0.3.0-alpha.1]: https://github.com/esengine/reasonix/releases/tag/v0.3.0-alpha.1
[0.2.2]: https://github.com/esengine/reasonix/releases/tag/v0.2.2
[0.2.1]: https://github.com/esengine/reasonix/releases/tag/v0.2.1
[0.2.0]: https://github.com/esengine/reasonix/releases/tag/v0.2.0
[0.1.0]: https://github.com/esengine/reasonix/releases/tag/v0.1.0
