<p align="center">
  <img src="docs/logo.svg" alt="Reasonix — DeepSeek-native agent framework" width="640"/>
</p>

<p align="center">
  <em>Cache-first agent loop for DeepSeek V4 — terminal-native, MCP first-class, no LangChain.</em>
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

**A DeepSeek-native AI coding agent for your terminal.** ~30× cheaper per task than Claude Code, engineered around DeepSeek's prefix-cache so the savings are real (94% live cache hit, not theoretical). MIT-licensed, no IDE lock-in, MCP first-class.

---

## Quick start

```bash
cd my-project
npx reasonix code
```

First run: paste a [DeepSeek API key](https://platform.deepseek.com/api_keys), pick a preset, optionally select MCP servers. Every run after drops you straight in.

```
reasonix code › fix the case-sensitivity bug in findByEmail

assistant
  ▸ tool<search_files> → src/users.ts, src/users.test.ts
  ▸ tool<read_file>    → src/users.ts (412 chars)

src/users.ts
<<<<<<< SEARCH
  return users.find(u => u.email === email);
=======
  const needle = email.toLowerCase();
  return users.find(u => u.email.toLowerCase() === needle);
>>>>>>> REPLACE

▸ 1 pending edit · /apply to write, /discard to drop
```

Edits stay in memory until you type `/apply` — nothing hits disk by default. Requires Node ≥ 20.10. Tested on macOS, Linux, and Windows (PowerShell, Git Bash, Windows Terminal).

### Appending code-mode system instructions

`reasonix code` supports append-only system prompt customization for users who want to layer personal workflow rules on top of the default Reasonix Code prompt.

```sh
reasonix code --system-append "Always inspect relevant files before editing."
reasonix code --system-append-file ./agent-instructions.md
```

Both options may be used together. When both are provided, the inline `--system-append` text is added first, followed by the `--system-append-file` contents, under a `# User System Append` heading at the end of the generated system prompt.

These options do not replace the default code prompt. They append additional instructions after Reasonix Code's built-in tool-use and edit-protocol instructions. There is no `--system` override for `reasonix code`.

---
## How it compares

|                                  | Reasonix         | Claude Code     | Cursor             | Aider            |
|----------------------------------|------------------|-----------------|--------------------|------------------|
| Backend                          | DeepSeek V4      | Anthropic       | OpenAI / Anthropic | any (OpenRouter) |
| **Cost / typical task**          | **~¥0.01–0.04**  | ~¥0.40–4        | ¥150/mo + usage    | varies           |
| Surface                          | terminal         | terminal + IDE  | IDE (Electron)     | terminal         |
| License                          | **MIT**          | closed          | closed             | Apache 2         |
| **DeepSeek prefix-cache hit**    | **94%** (live)   | n/a             | n/a                | ~33% (baseline)  |
| Plan mode (read-only audit gate) | yes              | yes             | —                  | yes              |
| Edit review (`/apply`, no auto-write) | yes         | yes             | partial            | yes              |
| MCP servers                      | first-class      | first-class     | —                  | —                |
| User-authored skills             | yes              | yes             | —                  | —                |
| Embedded web dashboard           | yes              | —               | n/a (IDE)          | —                |
| Hooks (`PreToolUse`, etc.)       | yes              | yes             | —                  | —                |
| Sandbox boundary                 | strict           | yes             | partial            | yes              |
| Persistent per-workspace sessions | yes             | partial         | n/a                | —                |

Numbers from `benchmarks/tau-bench-lite` (8 multi-turn tasks × 3 repeats, live `deepseek-chat`). [Committed transcripts →](./benchmarks/)

<details>
<summary><strong>Why DeepSeek-only? — the cache economics</strong></summary>

Cheap tokens alone is half the story. DeepSeek's prefix-cache is **byte-stable**: the cache fingerprints from byte 0 of the prompt. Reasonix's loop is engineered around that — append-only growth, no re-ordering, no marker-based compaction — so the cache prefix survives every tool call.

By comparison, Claude Code is built around Anthropic's `cache_control` markers (a fundamentally different mechanic). Pointing it at DeepSeek's Anthropic-compat endpoint keeps the cheap tokens but loses the cache hits — markers are ignored, and the underlying prefix isn't byte-stable. Generic-backend tools (Aider / Cline / Continue) hit the same wall from the other direction: their compaction patterns destroy byte stability.

At DeepSeek's pricing — $0.07/Mtok uncached, $0.014/Mtok cached — **the difference between 50% and 94% hit is roughly 2.5× on input cost alone.** Same model, same API; the loop's invariants are what changed.

A few DeepSeek-specific fixes generic loops miss:

| Generic loops assume | DeepSeek actually does | Reasonix's fix |
|---|---|---|
| Reasoning emitted as a structured `thinking` block | R1 sometimes leaks tool-call JSON inside `<think>` tags | a `scavenge` pass that pulls escaped tool calls back out |
| Tool schemas validated strictly | DeepSeek silently drops deeply-nested object/array params | auto-flatten — nested params get rewritten to single-level prefixed names |
| Tool-call args are well-formed JSON | DeepSeek occasionally produces `string="false"` and other malformed fragments | dedicated `ToolCallRepair` heals the common shapes before dispatch |
| Reasoning depth tuned via system-level switches | V4 exposes a `reasoning_effort` knob (`max` / `high`) | `/effort` slash + `--effort` flag for cheap turns |

Cache stability isn't a feature you turn on; it's an invariant the loop is designed around. That's the entire reason Reasonix is DeepSeek-only.

</details>

---

## What's in the box

### Cache-first agent loop
Loop preserves prefix stability across tool dispatches. R1-style reasoning supported, with a scavenge pass that pulls escaped tool calls back out of `<think>` blocks. Tool-call repair handles malformed args before they hit dispatch. `/effort` lets you step reasoning depth down for cheap turns.

### Tool registry
Native: `read_file`, `write_file`, `edit_file` (SEARCH/REPLACE), `list_directory`, `search_files`, `grep_files`, `run_command`, `run_background`, `web_search`, `web_fetch`. All sandboxed to the launch directory. **MCP first-class** — `--mcp 'name=cmd args'` adds external servers (stdio / Streamable HTTP / SSE), tools merge into the registry under a prefix.

### Plan mode + edit review
`/plan` enters a read-only audit gate where the model can't dispatch edits until you approve a written plan. Edits emerge as SEARCH/REPLACE blocks; nothing hits disk until `/apply`. `/walk` steps through pending edits one at a time. `/discard` drops them all.

### Sessions, scoped per workspace
Sessions persist in `~/.reasonix/sessions/` and are filtered by launch directory. `--new` preserves the previous session under a timestamped name; `--resume` finds the latest. `/sessions` switches mid-chat without quitting.

### Embedded web dashboard
`/dashboard` opens a localhost SPA mirroring the running TUI — chat (with full composer fallback when the TUI's renderer breaks down on legacy PowerShell), editor (file tree + CodeMirror), Sessions / Plans / Usage / Tools / MCP / Memory / Hooks / Settings. Token-gated, CSRF-checked, ephemeral. [Design mockup →](./design/agent-dashboard.html)

### Hooks
Configurable shell scripts that fire on `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`. Lives in `.reasonix/settings.json` (per-project) or `~/.reasonix/settings.json` (per-user). The harness executes them — not the model.

### Memory + skills
Two layers: project-scoped `REASONIX.md` (committed, repo conventions) and user-scoped `~/.reasonix/memory/` (per-user, the model can write to it via the `remember` tool). Skills are user-authored prompt packs with optional sub-agent execution.

### Permissions
`allow` / `ask` / `deny` patterns on commands and tools. `npm publish` defaults to `ask`; `rm -rf *` and `git push --force *` default to `deny`. Approved-once decisions can be remembered for a prefix.

[Full feature docs on the website →](https://esengine.github.io/reasonix/) · [Architecture →](./docs/ARCHITECTURE.md) · [TUI design mockup →](./design/agent-tui-terminal.html)

---

## Contributing

Reasonix is solo-maintained but designed to grow. Scoped starter issues:

- [#15 — `reasonix doctor --json` flag](https://github.com/esengine/reasonix/issues/15) · CLI · 2-3h
- [#16 — `web_search` / `web_fetch` actionable error messages](https://github.com/esengine/reasonix/issues/16) · tools · 2-3h
- [#17 — Slash command "did you mean?" suggestion](https://github.com/esengine/reasonix/issues/17) · TUI · 2-3h
- [#18 — Unit tests for `clipboard.ts`](https://github.com/esengine/reasonix/issues/18) · tests · 2-3h

Each has background, code pointers, acceptance criteria, hints. Browse all [`good first issue`](https://github.com/esengine/reasonix/labels/good%20first%20issue)s.

**Open Discussions** — opinions wanted:
- [#20 · CLI / TUI design](https://github.com/esengine/reasonix/discussions/20) — what's broken, what's missing, what would you change?
- [#21 · Dashboard design](https://github.com/esengine/reasonix/discussions/21) — react against the [proposed mockup](./design/agent-dashboard.html)
- [#22 · Future feature wishlist](https://github.com/esengine/reasonix/discussions/22) — what would you build into Reasonix next?

**Before your first PR**: read [`CONTRIBUTING.md`](./CONTRIBUTING.md). Short, strict project rules (comments, errors, libraries-over-hand-rolled); `tests/comment-policy.test.ts` enforces the comment ones and `npm run verify` is the pre-push gate.

```bash
git clone https://github.com/esengine/reasonix.git
cd reasonix
npm install
npm run dev code        # run from source via tsx
npm run verify          # lint + typecheck + 1665 tests
```

---

## Non-goals

- **Multi-provider flexibility.** DeepSeek-only on purpose — every layer is tuned around DeepSeek's specific cache mechanic and pricing. Coupling to one backend is the feature.
- **IDE integration.** Terminal-first; the diff lives in `git diff`, the file tree in `ls`. The dashboard is a companion, not a Cursor replacement.
- **Hardest-leaderboard reasoning.** Claude Opus still wins some benchmarks. DeepSeek V4 is competitive on coding; if your work is "solve this PhD proof" rather than "fix this auth bug," start with Claude.
- **Air-gapped / fully-free.** DeepSeek's API has free credit on signup but isn't free forever. For air-gapped, see Aider + Ollama or [Continue](https://continue.dev).

---

## License

MIT — see [LICENSE](./LICENSE).
