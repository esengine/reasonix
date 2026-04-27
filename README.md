<p align="center">
  <img src="docs/logo.svg" alt="Reasonix — DeepSeek-native agent framework" width="640"/>
</p>

<p align="center">
  <em>Cache-first agent loop for DeepSeek V4 (flash + pro) — Ink TUI, MCP first-class, no LangChain.</em>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a> · <a href="https://esengine.github.io/reasonix/">Website</a>
</p>

# Reasonix

[![npm version](https://img.shields.io/npm/v/reasonix.svg)](https://www.npmjs.com/package/reasonix)
[![CI](https://github.com/esengine/reasonix/actions/workflows/ci.yml/badge.svg)](https://github.com/esengine/reasonix/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/reasonix.svg)](./LICENSE)
[![downloads](https://img.shields.io/npm/dm/reasonix.svg)](https://www.npmjs.com/package/reasonix)
[![node](https://img.shields.io/node/v/reasonix.svg)](./package.json)

**A DeepSeek-native AI coding agent in your terminal.** ~30× cheaper
per task than Claude Code, with a cache-first loop engineered for
DeepSeek's pricing model. Edits as reviewable SEARCH/REPLACE blocks.
MIT-licensed. No IDE lock-in. MCP first-class.

---

## Quick start (60 seconds)

**1. Get a DeepSeek API key.** Free credit on signup:
<https://platform.deepseek.com/api_keys>

**2. Point it at a project.** No install needed.

```bash
cd my-project
npx reasonix code
```

First run walks you through a 30-second wizard (paste API key → pick
preset → multi-select MCP servers). Every run after that drops you
straight in.

**3. Ask it to edit.** The model proposes edits as SEARCH/REPLACE
blocks — nothing hits disk until you `/apply`.

```
reasonix code › users.ts 里 findByEmail 对大小写敏感导致登录失败，帮我改

assistant
  ▸ tool<search_files> → src/users.ts, src/users.test.ts
  ▸ tool<read_file>    → (src/users.ts, 412 chars)
  ▸ 找到了。findByEmail 直接用 === 比对。改成小写规范化并补一条测试。

src/users.ts
<<<<<<< SEARCH
  return users.find(u => u.email === email);
=======
  const needle = email.toLowerCase();
  return users.find(u => u.email.toLowerCase() === needle);
>>>>>>> REPLACE

▸ 1 pending edit across 1 file — /apply to write · /discard to drop

reasonix code › /apply
▸ ✓ applied src/users.ts
```

Requires Node ≥ 20.10. macOS, Linux, Windows (PowerShell / Git Bash /
Windows Terminal). Press `Esc` anytime to abort; `/help` for the full
command list.

---

## Why Reasonix? (vs Cursor / Claude Code / Cline / Aider)

Three things you'd come to Reasonix for, that nothing else combines:

- **The cost economics actually land in your bill.** DeepSeek V4 is
  ~30× cheaper than Claude Sonnet per token. Cheaper tokens alone
  isn't the win — *cheap tokens with a 90%+ prefix-cache hit* is.
  Reasonix's loop is engineered around append-only prompt growth so
  the cache-stable prefix survives every tool call, which the
  benchmarks section below verifies end-to-end (94.4% live, vs 46.6%
  for a generic harness against the same workload). The `/stats`
  panel tracks "vs Claude Sonnet 4.6" savings every turn so you can
  watch your bill not happen.

- **It lives in your terminal.** Pure CLI — no Electron, no VS Code
  extension, no IDE plugin to wedge into your editor. Sits next to
  git, tmux, and your shell history. macOS / Linux / Windows
  (PowerShell, Git Bash, Windows Terminal all tested). The only
  network call is to the DeepSeek API itself; no vendor server in
  the middle.

- **Open source and hackable, end to end.** MIT-licensed TypeScript.
  The entire loop, tool registry, cache-stable prefix, TUI, MCP
  bridge — all in `src/` under 30k lines. Fork it, ship a private
  build, drop it into CI. No SaaS layer, no enterprise tier, no
  feature gates.

| | Reasonix | Claude Code | Cursor | Cline | Aider |
|---|---|---|---|---|---|
| Backend | DeepSeek V4 only | Anthropic only | OpenAI / Anthropic | any (OpenRouter) | any (OpenRouter) |
| Cost / typical task | **~$0.001–$0.005** | ~$0.05–$0.50 | $20/mo + usage | varies | varies |
| Where it runs | terminal | terminal + IDE | IDE (Electron) | VS Code only | terminal |
| License | **MIT** | closed | closed | Apache 2 | Apache 2 |
| Cache-first prefix loop | **engineered (94% hit)** | basic | n/a | n/a | basic |
| MCP servers | **first-class** | first-class | — | beta | — |
| Plan mode (read-only audit gate) | **yes** | yes | — | yes | — |
| User-authored skills | **yes** | yes | — | — | — |
| Edit review (no auto-write) | **yes** (`/apply`) | yes | partial | yes | yes |
| Workspace switch (`/cwd`, `change_workspace`) | **yes** | — | n/a (per-window) | — | — |
| Cross-session cost dashboard | **yes** (`/stats`) | — | — | — | — |
| Sandbox boundary enforcement | **strict** (refuses `..` escape) | yes | partial | yes | partial |

### Pick something else when

- **You want multi-provider flexibility** (mix Claude / GPT / Gemini /
  local Llama in one tool). Try [Aider](https://aider.chat) or
  [Cline](https://cline.bot). Reasonix is DeepSeek-only on purpose —
  every layer (cache-first loop, R1 harvesting, JSON-mode tool repair,
  reasoning-effort cap) is tuned against DeepSeek-specific behavior
  and economics. Coupling to one backend is the feature, not a
  limitation we'll grow out of.
- **You want IDE integration** (inline diff in your gutter,
  multi-cursor, ghost text, refactor previews). Try
  [Cursor](https://cursor.com) or Claude Code's IDE mode. Reasonix
  is terminal-first; the diff lives in `git diff`, the file tree
  lives in `ls`, the chat lives in your shell.
- **You're chasing the hardest reasoning benchmarks.** Claude Opus
  4.6 still wins some leaderboards. DeepSeek V4-pro is competitive
  on most coding tasks but doesn't lead every benchmark. If your
  task is "solve this PhD-level proof" rather than "fix this auth
  bug," start with Claude.
- **You need fully-local / fully-free**. DeepSeek's API has free
  credit on signup, but isn't free forever. For air-gapped or
  always-free, look at Aider + Ollama or [Continue](https://continue.dev).

### "But DeepSeek now has an Anthropic-compatible API — can't I just point Claude Code at it?"

You can. DeepSeek ships an official Anthropic-compatible endpoint at
`https://api.deepseek.com/anthropic`, and Claude Code (or any Anthropic
SDK client) talks to it without modification. The protocol works. The
**caching economics** don't transfer, and that's the whole point.

Look at DeepSeek's [own compatibility table](https://api-docs.deepseek.com/guides/anthropic_api):

| Field | Status on DeepSeek's compat endpoint |
|---|---|
| `cache_control` markers | **Ignored** |
| `mcp_servers` (API-level) | Ignored |
| `thinking.budget_tokens` | Ignored |
| Images / documents / citations | Not supported |

`cache_control: Ignored` is the load-bearing line. Two completely
different cache mechanics are colliding here:

| | Anthropic native | DeepSeek auto-cache |
|---|---|---|
| Model | **Marker-based.** You put `cache_control` on a message; Anthropic caches "everything up to this marker" as a content-addressed unit. Multiple markers = multiple independent breakpoints. | **Byte-stable prefix.** The cache fingerprints the literal byte stream from byte 0. |
| Claude Code's design | Built around this. Markers on system prompt + tool defs let the loop reorder, compact, or insert metadata after the markers without losing the cache. | n/a — Claude Code wasn't designed for byte-stable prefixes. |
| What happens when Claude Code → DeepSeek compat | Markers stripped (ignored). Claude Code's main caching strategy disappears. | Falls back to auto-cache. But Claude Code's prefix isn't byte-stable (markers were the *substitute* for byte-stability), so auto-cache misses too. |

Net effect: **Claude Code's loop, redirected at DeepSeek, gets the
cheap tokens and loses the cache hit it depended on.** A loop running
at 80%+ cache hit on Anthropic's marker cache lands somewhere in the
40-60% range on DeepSeek's auto-cache (matches the generic-harness
baseline in our benchmarks). Same model, same API, same workload —
the loop's invariants don't fit the cache mechanic it's now talking
to.

Reasonix's loop was designed around byte-stable prefix from line one.
No markers, no breakpoints — append-only is the invariant. That's why
the same τ-bench workload lands at **94.4% cache hit** on Reasonix
and **46.6%** on a cache-hostile baseline (committed transcripts;
benchmarks section below). At DeepSeek's pricing — $0.07/Mtok
uncached, ~$0.014/Mtok cached — the difference between 50% and 94%
hit is **roughly 2.5× on input cost alone**.

### "What about Aider / Cline / Continue?"

They support DeepSeek natively (no compat layer needed) and you do
get the cheap token price. What you don't get is the DeepSeek-
specific loop work — those tools' loops support every backend
generically (OpenAI / Anthropic / local Llama / ...) and use
compaction + summarization patterns that destroy byte-stability. They
land in the same 40-60% cache-hit range as the baseline. Plus a
handful of DeepSeek-specific quirks generic loops don't handle:

| Generic loops assume | DeepSeek actually does | Reasonix's fix |
|---|---|---|
| Reasoning emitted as a structured `thinking` block | R1 sometimes leaks tool-call JSON inside `<think>` tags | a `scavenge` pass that pulls escaped tool calls back out, otherwise the model thinks it called and waits for output that never comes |
| Tool schemas validated strictly | DeepSeek silently drops deeply-nested object/array params | auto-flatten — nested params get rewritten to single-level prefixed names so the model sees them at all |
| Tool-call args are well-formed JSON | DeepSeek occasionally produces `string="false"` and other malformed fragments | dedicated `ToolCallRepair` heals the common shapes before they hit dispatch |
| Reasoning depth tuned via system-level switches | V4 exposes a `reasoning_effort` knob (`max` / `high`) | `/effort` slash + `--effort` flag, so users can step down for cheap turns |
| Old tool results kept in full forever | 1M context — don't compact pre-emptively, but most agents do | call-storm breaker + result token cap, but the prefix is *never* rewritten; compaction lands as new turns at the tail |

> Cache-stability isn't a feature you turn on; it's an invariant
> the loop is designed around. Reasonix isn't yet-another agent
> CLI — it's an agent CLI built around DeepSeek's specific cache
> mechanic and pricing model.

---

## `reasonix code` — pair programmer in your terminal

Scoped to the directory you launch from. The model has native
`read_file` / `write_file` / `edit_file` / `list_directory` /
`search_files` / `directory_tree` / `get_file_info` /
`create_directory` / `move_file` tools, all sandboxed — any path that
resolves outside the launch root (including `..` and symlink escapes)
is refused. Plus `run_command` with a read-only allowlist; anything
state-mutating (`npm install`, `git commit`, …) is gated behind a
confirmation picker.

### Walkthrough: explore before editing

For "what does this code do?" questions the model uses the read-side
tools and replies in prose — no SEARCH/REPLACE blocks, no file
writes. Ask to change something only when you mean it:

```
reasonix code › 这个项目的路由是怎么组织的？
assistant
  ▸ tool<directory_tree> → (src/ tree, 47 entries)
  ▸ tool<read_file> → (src/router.ts, 1.2 KB)
  ▸ 路由分三层：顶层 AppRouter 注册 tab，每个 tab 用 React Router 的
    nested routes 写子路径，最后 …
```

If an `edit_file` SEARCH block doesn't match the file byte-for-byte,
the edit is refused loudly rather than fuzzy-matched. The model sees
the error and retries — silent wrong edits are worse than visible
rejections.

### Plan mode — review before executing

For anything bigger than a typo, the model is encouraged to propose a
markdown plan first. You'll see a picker with **Approve / Refine /
Cancel**:

```
reasonix code › 把 auth 从 JWT 迁移到 session cookies

▸ plan submitted — awaiting your review
────────────────────────────────────────
## Summary
Swap JWT middleware for session cookies, keep user table intact.

## Files
- src/auth/middleware.ts — replace `verifyJwt` with `readSession`
- src/auth/session.ts — new file, in-memory store + signed cookie
- src/routes/login.ts — return Set-Cookie instead of a token
- tests/auth/*.test.ts — update fixtures

## Risks
- Existing logged-in users get logged out (no migration).
- Session store is in-memory; restart clears sessions.
────────────────────────────────────────
  ▸ Approve and implement
    Refine — explore more
    Cancel
```

**Force it** with `/plan` — enters an explicit read-only phase where
the model *must* submit a plan before any edit or non-allowlisted
shell call will execute. Use for high-stakes changes you want to
audit before the model touches disk. `/plan off` or picker
Approve/Cancel exits.

### Prompt prefixes — `!cmd` and `@path`

Two inline shortcuts that don't need a slash:

**`!<cmd>` — run a shell command in the sandbox and feed it to the
model.** Typed at the prompt, like bash. Output lands in the visible
log AND in the session so the model's next turn reasons about it:

```
reasonix code › !git status --short
▸ M src/users.ts
▸ M src/users.test.ts

reasonix code › 把这两个文件的改动说明一下
assistant
  ▸ tool<read_file> → src/users.ts, src/users.test.ts
  ▸ …
```

No allowlist gate — user-typed shell = explicit consent. 60s timeout,
32k char cap, survives session resume since 0.5.14.

**`@path/to/file` — inline a file under "Referenced files."** Start
typing `@` and a picker appears (↑/↓ navigate, Tab/Enter to insert).
Good for "what does @src/users.ts do?" without making the model
`read_file` it first. Sandboxed: relative paths only, no `..` escape,
64KB per-file cap. Recent files rank higher.

### `/commit` — stage + commit in one step

```
reasonix code › /commit "fix: findByEmail case-insensitive"
▸ git add -A && git commit -m "fix: findByEmail case-insensitive"
  [main a1b2c3d] fix: findByEmail case-insensitive
```

### Things to try

- `/tool 1` — dump the last tool call's full output (when the 400-char
  inline clip isn't enough).
- `/think` — see the model's full reasoning for the last turn
  (thinking-mode models: v4-flash / v4-pro / reasoner alias).
- `/undo` — roll back the last applied edit batch.
- `/new` — start fresh in the same directory without losing the
  session file.
- `/effort high` — step down from the default `max` agent-class
  reasoning_effort for cheaper/faster turns on simple tasks.
- `npx reasonix code --preset max` — v4-pro + 3-way self-consistency
  branching for gnarly refactors.
- `npx reasonix code src/` — narrower sandbox (only `src/` is
  writable).
- `npx reasonix code --no-session` — ephemeral; nothing saved.

### `reasonix stats` — how much did you actually save?

Every turn `reasonix chat|code|run` runs appends a compact record
(tokens + cost + what Claude Sonnet 4.6 would have charged) to
`~/.reasonix/usage.jsonl`. `reasonix stats` with no args rolls that
log into today / week / month / all-time windows:

```
Reasonix usage — /Users/you/.reasonix/usage.jsonl

            turns  cache hit    cost (USD)      vs Claude     saved
----------------------------------------------------------------------
today           8      95.1%     $0.004821        $0.1348      96.4%
week           34      93.8%     $0.023104        $0.6081      96.2%
month         127      94.2%     $0.081530        $2.1452      96.2%
all-time      342      94.0%     $0.210881        $5.8934      96.4%
```

Privacy: only tokens, costs, and the session name you chose land
in the file. No prompts, no completions, no tool arguments.
`reasonix stats <transcript>` keeps the old per-file summary
(assistant turns + tool calls) for scripts that already use it.

### Staying current

The panel header shows the running version next to `Reasonix` (e.g.
`Reasonix v0.5.21 · deepseek-v4-pro · harvest · max …`, the trailing
`max` is the reasoning-effort badge — `/effort high` to step down).
A quiet 24-hour background check against
the npm registry surfaces a yellow `update: X.Y.Z` on the right side
of the same row when a newer version has been published. No blocking,
no nagging — the check runs once per day max and is silent on failure
(offline, firewall, etc.).

```bash
reasonix update             # print current vs latest, run `npm i -g reasonix@latest`
reasonix update --dry-run   # print the plan without running anything
```

Running via `npx`? The command detects that and prints a
cache-refresh hint instead — npx picks up the newest version on
its next invocation automatically.

### Project conventions — `REASONIX.md`

Drop a `REASONIX.md` in the project root and its contents are pinned
into the system prompt every launch. Committable team memory — house
conventions, domain glossary, things the model keeps forgetting:

```bash
cat > REASONIX.md <<'EOF'
# Notes for Reasonix
- Use snake_case for new Python modules; legacy camelCase modules keep their style.
- `cargo check` is in the auto-run allowlist; full `cargo test` needs confirmation.
- The `api/` dir mirrors `backend/` — keep schemas in sync.
EOF
```

Re-launch (or `/new`) to pick it up; the prefix is hashed once per
session to keep the DeepSeek cache warm. `/memory` prints what's
currently pinned. `REASONIX_MEMORY=off` disables every memory source
for CI / offline repro.

### User memory — `~/.reasonix/memory/`

A second, **private per-user** memory layer lives under your home
directory. Unlike `REASONIX.md` it's never committed, and the model
can write to it itself via the `remember` tool. Two scopes:

- `~/.reasonix/memory/global/` — cross-project (your preferences,
  tooling).
- `~/.reasonix/memory/<project-hash>/` — scoped to one sandbox root
  in `reasonix code` (decisions, local facts, per-repo shortcuts).

Each scope keeps an always-loaded `MEMORY.md` index of one-liners
plus zero or more `<name>.md` detail files (loaded on demand via
`recall_memory`). Writes land immediately; pinning into the system
prompt takes effect on next `/new` or launch so the cache prefix
stays stable for the current session.

```
reasonix code › 我用 bun 而不是 npm，请以后都用 bun 跑构建

assistant
  ▸ tool<remember> → project/bun_build saved
    "Build command on this machine is `bun run build`"
```

**Slash**: `/memory` · `/memory list` · `/memory show <name>` ·
`/memory forget <name>` · `/memory clear <scope> confirm`.
**Model tools**: `remember(type, scope, name, description, content)` ·
`forget(scope, name)` · `recall_memory(scope, name)`.

Project scope is only available inside `reasonix code` (needs a real
sandbox root to hash); plain `reasonix` gets the global scope only.

### Skills — user-authored prompt packs

Skills are prose instruction blocks you drop on disk. Reasonix pins
their names + one-line descriptions into the system prompt; the
model can call `run_skill({name: "..."})` on its own when a match
fits, or you can type `/skill <name> [args]` to run one manually.

Two scopes, same layout as user memory:

- `<project>/.reasonix/skills/` — per-project skills (commit them to
  share with your team, or add to `.gitignore` for personal drafts).
- `~/.reasonix/skills/` — global skills available everywhere.

Either layout works: `<name>/SKILL.md` (preferred — can bundle
additional assets alongside) or flat `<name>.md`.

```markdown
---
name: review
description: Review uncommitted changes and flag risks
---

Run `git diff` on staged and unstaged changes. Summarize what each
hunk does, call out potential regressions, and list files that might
need additional tests. Don't propose edits unless I ask.
```

Use it:

```
reasonix code › /skill review
▸ running skill: review
assistant
  ▸ tool<run_command> → git diff --cached
  ▸ 3 改动，1 个需要回归测试 …
```

Or let the model pick autonomously — because the skill's name +
description are pinned in the prefix, asking "帮我看下未提交的改动有没
有风险" triggers `run_skill({name: "review"})` without you typing the
slash command.

**Slash**: `/skill` (list) · `/skill show <name>` · `/skill <name>
[args]` (inject body as user turn).

**Deliberately not tied** to any other client's directory convention
(`.claude/skills`, etc.) — Reasonix is model-agnostic at the
conversation layer. Any SKILL.md you author works; the body is
prose, so skills authored for other tools usually port over unchanged
(Reasonix's tool names differ — `filesystem` / `shell` / `web` — but
the model reads the instructions and picks our equivalents).

### Hooks — automate around tool calls and turns

Drop a `settings.json` under `.reasonix/` (project or `~/`) and
Reasonix will fire shell commands at four well-known points in
the loop: before a tool runs, after a tool returns, before your
prompt reaches the model, and after the turn ends.

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

Each hook is a shell command. Reasonix invokes it with stdin = a
JSON envelope describing the event:

```json
{ "event": "PreToolUse", "cwd": "/path/to/project",
  "toolName": "edit_file", "toolArgs": { "path": "src/x.ts", "..." } }
```

Exit code drives the decision:

- **0** — pass; loop continues normally
- **2** — block (only on `PreToolUse` / `UserPromptSubmit`); the
  hook's stderr becomes the synthetic tool result the model sees,
  or the prompt is dropped entirely
- **anything else** — warn; loop continues, stderr renders as a
  yellow row inline

`match` is anchored regex on the tool name; `*` or omitted matches
every tool. Project hooks fire before global hooks. Default
timeouts: 5s for blocking events, 30s for logging events; per-hook
`timeout` overrides.

**Slash**: `/hooks` (list active hooks) · `/hooks reload` (re-read
`settings.json` from disk without losing your session).

### Staying current from inside the TUI

`/update` inside a running session shows your current version, the
last-resolved latest version (from the quiet 24h background check),
and the shell command to run. The slash does *not* spawn
`npm install` — stdio:inherit into a running Ink renderer corrupts
the display. Exit the session and run `reasonix update` in a
fresh shell when you actually want to install.

---

## `reasonix` — also works as general chat

Same TUI, no filesystem tools unless you opt in via MCP. Good for
drafting, Q&A, schema design, architecture discussions, or driving
your own MCP servers. Sessions persist per name under
`~/.reasonix/sessions/`.

```bash
npx reasonix                             # uses saved config + wizard-selected MCP
npx reasonix --preset smart              # reasoner + R1 harvest for this run
npx reasonix --session design            # named session — resume later with --session design
```

Bridge your own MCP servers on the fly:

```bash
npx reasonix \
  --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe" \
  --mcp "kb=https://mcp.example.com/sse"
```

MCP tools go through the same Cache-First + repair + context-safety
plumbing as native tools — 32k result cap, live progress-notification
rendering, retries.

---

## Commands inside the session

**Core**

| command | what it does |
|---|---|
| `/help` · `/?` | full command reference with hints |
| `/status` | current model · flags · context · session |
| `/new` · `/reset` | fresh conversation in the same session |
| `/clear` | clear visible scrollback only (log kept) |
| `/retry` | truncate and resend your last message (fresh sample) |
| `/exit` · `/quit` | quit |

**Model**

| command | what it does |
|---|---|
| `/preset <fast\|smart\|max>` | one-tap bundle (model + harvest + branch) |
| `/model <id>` | switch DeepSeek model (`deepseek-v4-flash`, `deepseek-v4-pro`, plus `deepseek-chat` / `deepseek-reasoner` compat aliases) |
| `/models` | list live models from DeepSeek `/models` endpoint |
| `/harvest [on\|off]` | toggle R1 plan-state extraction |
| `/branch <N\|off>` | run N parallel samples per turn, pick best (N ≥ 2) |
| `/effort <high\|max>` | reasoning_effort cap — `max` is the agent default, `high` is cheaper/faster |
| `/think` | dump the last turn's full thinking-mode reasoning |

**Context & tools**

| command | what it does |
|---|---|
| `/mcp` | list attached MCP servers and their tools / resources / prompts |
| `/resource [uri]` | browse + read MCP resources (no arg → list URIs; `<uri>` → fetch) |
| `/prompt [name]` | browse + fetch MCP prompts |
| `/tool [N]` | dump the Nth tool call's full output (1 = latest) |
| `/compact [tokens]` | shrink oversized tool results in the log (default 4000 tokens/result) |
| `/context` | break down where context tokens are going (system / tools / log) |
| `/stats` | cross-session cost dashboard (today / week / month / all-time) |
| `/keys` | keyboard shortcuts + prompt prefixes (`!` / `@` / `/`) cheatsheet |

**Memory & skills**

| command | what it does |
|---|---|
| `/memory` | show pinned memory (REASONIX.md + ~/.reasonix/memory) |
| `/memory list` · `show <name>` · `forget <name>` · `clear <scope> confirm` | manage the store |
| `/skill` · `/skill list` | list discovered skills (project + global) |
| `/skill show <name>` | dump one skill's body |
| `/skill <name> [args]` | run a skill (inject body as user turn) |

**Sessions**

| command | what it does |
|---|---|
| `/sessions` | list saved sessions (current marked with `▸`) |
| `/forget` | delete the current session from disk |
| `/setup` | reconfigure (exit and run `reasonix setup`) |

**Code mode only** (`reasonix code`)

| command | what it does |
|---|---|
| `/apply` | commit the pending SEARCH/REPLACE blocks to disk |
| `/discard` | drop the pending edit blocks without writing |
| `/undo` | roll back the last applied edit batch |
| `/commit "msg"` | `git add -A && git commit -m "msg"` |
| `/plan [on\|off]` | toggle read-only plan mode |
| `/apply-plan` | force-approve a pending plan |

**Keyboard**

- `Enter` — submit
- `Shift+Enter` / `Ctrl+J` — newline (multi-line paste also supported;
  `\` + Enter as a portable fallback)
- `↑` / `↓` — walk prompt history while idle; navigate slash-autocomplete
- `Tab` / `Enter` on a `/foo` prefix — accept the highlighted suggestion
- `Esc` — abort the current turn (stops the API call, cancels any
  in-flight tool, rejects pending MCP requests)
- `y` / `n` on confirm prompts — hotkey accept / reject

---

## Sessions and safety nets

- Sessions live as JSONL under `~/.reasonix/sessions/<name>.jsonl`
  (per directory for `reasonix code`). Every message appended
  atomically; `Ctrl+C` never loses context.
- Tool results are capped at 32k chars per call. Oversized sessions
  self-heal on load (shrinks + rewrites the file).
- Malformed `assistant.tool_calls` / `tool` pairing is validated on
  every outgoing API call so a corrupted session can't keep 400ing.
- Context gauge turns yellow at 50%, red at 80% with a `/compact`
  nudge. Approaching the 1M-token window (V4 flash + pro) triggers an
  automatic compaction attempt before falling back to a forced summary.
- The `reasonix code` sandbox refuses any path that resolves outside
  the launch directory, including symlink escape and `..` traversal.

### Troubleshooting: duplicate rows / ghost rendering

Some Windows terminals (Git Bash / MINTTY / winpty-wrapped shells)
don't fully implement the ANSI cursor-up escapes Ink uses to repaint
the live spinner region. Symptom: spinners, streaming previews, or
tool-result rows print multiple copies into scrollback instead of
overwriting in place.

If you hit this, run with plain mode:

```bash
REASONIX_UI=plain npx reasonix code
```

Plain mode suppresses live/animated rows and disables the internal
tick timer. You lose the streaming preview and spinners but gain
stable scrollback. Windows Terminal, PowerShell 7 in Windows
Terminal, and WezTerm don't need this opt-out.

---

## Web search — on by default

The model has two web tools the moment you launch: `web_search` and
`web_fetch`. No flag, no API key, no signup. When you ask about
something the model wasn't trained on (new releases, current events,
obscure APIs), it decides to call `web_search` on its own; if a
snippet isn't enough it follows up with `web_fetch`.

Backed by **Mojeek**'s public search page — an independent web
index, bot-friendly, no cookies/sessions. Coverage on niche or very
recent queries can be thinner than Google/Bing, but it's reliable
from scripts. (DDG was the original backend but started serving
anti-bot pages in 2026.)

**Turn it off** (offline mode / privacy / CI):

```json
// ~/.reasonix/config.json
{ "apiKey": "sk-…", "search": false }
```

```bash
REASONIX_SEARCH=off npx reasonix code
```

**Bring your own** (Kagi, SearXNG, internal caches): implement the
`WebSearchProvider` interface and call
`registerWebTools(registry, { provider })` yourself, or bridge an
existing MCP search server via `--mcp`.

---

## MCP — bring your own tools

Any [MCP](https://spec.modelcontextprotocol.io/) server works. The
wizard lets you pick from a catalog, or drive it by flag:

```bash
# stdio (local subprocess)
npx reasonix --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe"

# multiple at once
npx reasonix \
  --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe" \
  --mcp "demo=npx tsx examples/mcp-server-demo.ts"

# HTTP+SSE (remote / hosted)
npx reasonix --mcp "kb=https://mcp.example.com/sse"
```

`reasonix mcp list` shows the curated catalog. `reasonix mcp inspect
<spec>` connects once and dumps the server's tools / resources /
prompts without starting a chat. Progress notifications from
long-running tools (2025-03-26 spec) render live as a progress bar
in the spinner.

Supported transports: **stdio** (local command) and **HTTP+SSE**
(remote, MCP 2024-11-05 spec).

---

## CLI reference

```bash
npx reasonix code [path]                 # coding mode scoped to path (default: cwd)
npx reasonix                             # chat (uses saved config)
npx reasonix setup                       # reconfigure the wizard
npx reasonix chat --session work         # named session
npx reasonix chat --no-session           # ephemeral
npx reasonix run "ask anything"          # one-shot, streams to stdout
npx reasonix stats session.jsonl         # summarize a transcript
npx reasonix replay chat.jsonl           # rebuild cost/cache from a transcript
npx reasonix diff a.jsonl b.jsonl --md   # compare two transcripts
npx reasonix mcp list                    # curated MCP catalog
npx reasonix mcp inspect <spec>          # probe a single MCP server
npx reasonix sessions                    # list saved sessions
```

Common flags:

```bash
--preset <fast|smart|max>   # bundle (model + harvest + branch)
--model <id>                # explicit model id
--harvest / --no-harvest    # R1 plan-state extraction
--branch <N>                # self-consistency budget
--mcp "name=cmd args…"      # attach an MCP server (repeatable)
--transcript path.jsonl     # write a JSONL transcript on the side
--session <name>            # named session (default: per-dir for code mode)
--no-session                # ephemeral
--no-config                 # ignore ~/.reasonix/config.json (CI-friendly)
```

Env vars (win over config):

```bash
export DEEPSEEK_API_KEY=sk-...
export DEEPSEEK_BASE_URL=https://...   # optional alternate endpoint
export REASONIX_MEMORY=off              # disable REASONIX.md + user memory
export REASONIX_SEARCH=off              # disable web_search / web_fetch
export REASONIX_UI=plain                # disable live rows (ghosting workaround)
```

---

## Library usage

```ts
import {
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
  ToolRegistry,
} from "reasonix";

const client = new DeepSeekClient(); // reads DEEPSEEK_API_KEY from env
const tools = new ToolRegistry();

tools.register({
  name: "add",
  description: "Add two integers",
  parameters: {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "integer" } },
    required: ["a", "b"],
  },
  fn: ({ a, b }: { a: number; b: number }) => a + b,
});

const loop = new CacheFirstLoop({
  client,
  tools,
  prefix: new ImmutablePrefix({
    system: "You are a math helper.",
    toolSpecs: tools.specs(),
  }),
  harvest: true,
  branch: 3,
});

for await (const ev of loop.step("What is 17 + 25?")) {
  if (ev.role === "assistant_final") console.log(ev.content);
}
console.log(loop.stats.summary());
```

`ChatOptions.seedTools` accepts a pre-built `ToolRegistry` for
callers who want the `reasonix code` loop wiring without the CLI
wrapper. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
internals.

---

## Benchmarks — verify the cache-hit claim yourself

Every abstraction here earns its weight against a DeepSeek-specific
property — dirt-cheap tokens, R1 reasoning traces, automatic prefix
caching, JSON mode. Generic wrappers leave these on the table.

| | Reasonix default | generic frameworks |
|---|---|---|
| Prefix-stable loop (→ 85–95% cache hit) | yes | no (prompts rebuilt each turn) |
| Auto-flatten deep tool schemas | yes | no (DeepSeek drops args) |
| Retry with jittered backoff (429/503) | yes | no (custom callbacks) |
| Scavenge tool calls leaked into `<think>` | yes | no |
| Call-storm breaker on identical-arg repeats | yes | no |
| Live cache-hit / cost / vs-Claude panel | yes | no |

On the same τ-bench-lite workload — 8 multi-turn tool-use tasks × 3
repeats = 48 runs per side, live DeepSeek `deepseek-chat`, sole
variable prefix stability:

| metric | baseline (cache-hostile) | Reasonix | delta |
|---|---:|---:|---:|
| cache hit | 46.6% | **94.4%** | +47.7 pp |
| cost / task | $0.002599 | $0.001579 | **−39%** |
| pass rate | 96% (23/24) | **100% (24/24)** | — |

**Reproduce without spending an API credit:**

```bash
git clone https://github.com/esengine/reasonix.git && cd reasonix && npm install
npx reasonix replay benchmarks/tau-bench/transcripts/t01_address_happy.reasonix.r1.jsonl
npx reasonix diff \
  benchmarks/tau-bench/transcripts/t01_address_happy.baseline.r1.jsonl \
  benchmarks/tau-bench/transcripts/t01_address_happy.reasonix.r1.jsonl
```

The committed JSONL transcripts carry per-turn `usage`, `cost`, and
`prefixHash`. Reasonix's prefix hash stays byte-stable across every
model call; baseline's churns on every turn. The cache delta is
*mechanically* attributable to log stability, not to a different
system prompt.

Full 48-run report:
[`benchmarks/tau-bench/report.md`](./benchmarks/tau-bench/report.md).
Reproduce with your own API key: `npx tsx
benchmarks/tau-bench/runner.ts --repeats 3`.

MCP reference runs (one single prefix hash across all 5 turns even
with two concurrent MCP subprocesses):

| server | turns | cache hit | cost | vs Claude |
|---|---:|---:|---:|---:|
| bundled demo (`add` / `echo` / `get_time`) | 2 | **96.6%** (turn 2) | $0.000254 | −94.0% |
| official `server-filesystem` | 5 | **96.7%** | $0.001235 | −97.0% |
| **both concurrently** | 5 | **81.1%** | $0.001852 | −95.9% |

---

## Non-goals

- **Multi-agent orchestration / sub-agents** (use LangGraph).
- **Workflow DSL / DAG scheduler / parallel-branch engine** — skills
  are prose; the model sequences via the normal tool-use loop.
  Keeps single-loop + append-only + cache-first invariants intact.
- **Multi-provider abstraction** (use LiteLLM). Reasonix is
  DeepSeek-only on purpose — every pillar (cache-first loop, R1
  harvesting, tool-call repair) is tuned against DeepSeek-specific
  behavior and economics. Coupling to one backend is the feature.
- **RAG / vector stores** (use LlamaIndex).
- **Web UI / SaaS.**

Reasonix does DeepSeek, deeply.

---

## Development

```bash
git clone https://github.com/esengine/reasonix.git
cd reasonix
npm install
npm run dev code        # run CLI from source via tsx
npm run build           # tsup to dist/
npm test                # vitest (1482 tests)
npm run lint            # biome
npm run typecheck       # tsc --noEmit
```

---

## License

MIT
