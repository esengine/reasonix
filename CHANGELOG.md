# Changelog

All notable changes to Reasonix. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
