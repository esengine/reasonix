# Reasonix

[![npm version](https://img.shields.io/npm/v/reasonix.svg)](https://www.npmjs.com/package/reasonix)
[![CI](https://github.com/esengine/reasonix/actions/workflows/ci.yml/badge.svg)](https://github.com/esengine/reasonix/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/reasonix.svg)](./LICENSE)
[![downloads](https://img.shields.io/npm/dm/reasonix.svg)](https://www.npmjs.com/package/reasonix)
[![node](https://img.shields.io/node/v/reasonix.svg)](./package.json)

**A DeepSeek-native AI coding assistant in your terminal.** Ink TUI. MCP
first-class. No LangChain.

---

## Quick start (60 seconds)

**1. Get a DeepSeek API key.** Free credit on signup:
<https://platform.deepseek.com/api_keys>

**2. Run it.** No install needed.

```bash
npx reasonix
```

First run walks you through a 30-second wizard:

- paste your API key (saved to `~/.reasonix/config.json`)
- pick a preset — `fast` (cheap chat, default), `smart` (+R1 reasoning), `max` (+self-consistency branching)
- multi-select MCP servers from a catalog (filesystem, memory, github, puppeteer, …)

Every run after that drops you straight into chat.

**3. Inside the chat.** Type anything and hit Enter. Type `/help` to see
every command. The status bar at the top shows cache hit %, cost so far,
balance, and context usage. Press `Esc` to cancel whatever is running.

```
reasonix › explain what this project does
assistant
  …streams R1 reasoning into a dim preview, then writes the answer…
status bar: cache hit 92% · cost $0.001 · ctx 8k/131k (6%) · balance 12.34 CNY
```

Requires Node ≥ 18. Works on macOS, Linux, Windows (Git Bash + PowerShell).

---

## Using `reasonix code` — your terminal pair programmer

Scoped to the directory you launch from. The model has native
`read_file` / `write_file` / `edit_file` / `list_directory` /
`search_files` / `directory_tree` / `get_file_info` /
`create_directory` / `move_file` tools, all sandboxed — any path that
resolves outside the launch root (including `..` and symlink escapes)
is refused.

```bash
cd my-project
npx reasonix code
```

### Walkthrough: fix a bug

```
reasonix code › users.ts 里 findByEmail 对大小写敏感导致登录失败，帮我改成大小写不敏感

assistant
  ▸ R1 reasoning · 1243 chars of thought
  ▸ tool<search_files> → src/users.ts, src/users.test.ts
  ▸ tool<read_file>    → (src/users.ts, 412 chars)
  ▸ tool<read_file>    → (src/users.test.ts, 820 chars)
  ▸ 找到了。findByEmail 直接用 === 比对。我把查询和存储都规范化为小写，并补上一条测试。

src/users.ts
<<<<<<< SEARCH
  return users.find(u => u.email === email);
=======
  const needle = email.toLowerCase();
  return users.find(u => u.email.toLowerCase() === needle);
>>>>>>> REPLACE

src/users.test.ts
<<<<<<< SEARCH
  it("finds by email", () => {
    expect(findByEmail("a@b.com")).toBeDefined();
  });
=======
  it("finds by email", () => {
    expect(findByEmail("a@b.com")).toBeDefined();
  });

  it("is case-insensitive", () => {
    expect(findByEmail("A@B.COM")).toBeDefined();
  });
>>>>>>> REPLACE

▸ 2 pending edits across 2 files — /apply to write · /discard to drop
```

**At this point nothing has been written to disk.** You have three
options:

- `/apply` — commit the pending blocks. You'll see `✓ applied
  src/users.ts` and `✓ applied src/users.test.ts`. A snapshot of the
  pre-edit file is kept so `/undo` can roll back.
- `/discard` — throw the blocks away without writing.
- Keep chatting — ask for adjustments. Say "also cover the empty
  string case" and the model proposes another block set.

After applying:

```
reasonix code › /commit "fix: findByEmail case-insensitive"
▸ git add -A && git commit -m "fix: findByEmail case-insensitive"
  [main a1b2c3d] fix: findByEmail case-insensitive
```

`/commit` runs `git add -A && git commit -m ...` from the sandbox root.

### Walkthrough: explore before editing

For "what does this code do?" questions the model uses the read-side
tools and replies in prose — no SEARCH/REPLACE blocks, no file writes.
Ask to change something only when you mean it:

```
reasonix code › 这个项目的路由是怎么组织的？
assistant
  ▸ tool<directory_tree> → (src/ tree, 47 entries)
  ▸ tool<read_file> → (src/router.ts, 1.2 KB)
  ▸ 路由分三层：顶层 AppRouter 注册 tab，每个 tab 用 React Router 的
    nested routes 写子路径，最后 …
```

If the SEARCH text doesn't match the file byte-for-byte, `edit_file`
refuses the edit loudly rather than fuzzy-matching. The model sees the
error and retries with the correct search text — silent wrong edits are
worse than visible rejections.

### Things to try

- `/tool 1` — dump the last tool call's full output (when the 400-char
  inline clip isn't enough).
- `/think` — see the model's full R1 reasoning for the last turn
  (reasoner preset only).
- `/undo` — roll back the last applied edit batch.
- `/new` — start fresh in the same directory without losing the
  session file.
- Drop `--no-session` for an ephemeral session that doesn't persist.

```bash
npx reasonix code src/           # narrower sandbox (only src/ is writable)
npx reasonix code --no-session   # ephemeral — nothing saved to disk
npx reasonix code --preset max   # R1 reasoning + 3-way self-consistency
```

---

## Using `reasonix` — general chat

Same TUI, no filesystem tools unless you opt in via MCP. Good for
drafting, Q&A, schema design, architecture discussions, or driving
your own MCP servers. Sessions persist per name under
`~/.reasonix/sessions/`.

```bash
npx reasonix                             # uses saved config + wizard-selected MCP
npx reasonix --preset smart              # one-shot override
npx reasonix --session design            # named session
npx reasonix --session design            # resume it later — history intact
```

### Walkthrough: a multi-turn session with R1 reasoning

```
reasonix › /preset smart
▸ switched to smart · model deepseek-reasoner · harvest on · branch off

reasonix › 我要给一个 Flutter 应用设计限时折扣的弹窗展示规则。目标：
      每天首次打开时弹一次，连续弹 3 天后休眠 7 天。怎么实现？

assistant
  ▸ R1 reasoning · 2410 chars of thought
  ‹ subgoals (3): 持久化展示计数 · 判断是否过了 24h · 休眠窗口判断
  ‹ hypotheses (2): SharedPreferences 存计数 · lastShownAt 时间戳
  ‹ uncertainties (1): 用户换设备后重置的策略

  建议数据模型：
    lastShownAt: DateTime
    consecutiveShows: int (0..3)
    sleepUntil: DateTime?
  …
```

`/think` dumps the full R1 thought trace; `/status` shows the current
model / flags / context use; `/retry` re-samples the same prompt with
a fresh random seed (useful when the first answer missed something).

### Walkthrough: attach MCP tools on the fly

```bash
# Attach the official filesystem server sandboxed to /tmp/scratch,
# plus a remote knowledge-base over SSE.
npx reasonix \
  --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/scratch" \
  --mcp "kb=https://mcp.example.com/sse"
```

Inside the chat:

```
reasonix › /mcp
▸ fs (stdio, 11 tools)   fs_read_file · fs_list_directory · fs_write_file · …
▸ kb (sse,   4 tools)    kb_search · kb_get · kb_list_collections · kb_stat

reasonix › 在 /tmp/scratch 下把所有 .log 文件里含 "ERROR" 的行收集到 errors.txt
assistant
  ▸ tool<fs_search_files> → 4 matches
  ▸ tool<fs_read_file>    → …
  ▸ tool<fs_write_file>   → wrote 2.4 KB to errors.txt
  ▸ 已写入 errors.txt — 共 38 行，分布在 4 个源文件中。
```

MCP tools go through the same Cache-First + repair + context-safety
plumbing as native tools, including the 32k result cap and live
progress-notification rendering.

### When to use `reasonix` vs `reasonix code`

| situation | command |
|---|---|
| Editing files in the current project | `reasonix code` |
| Exploring a project without writing files | `reasonix code` (it only writes on `/apply`) |
| Design / architecture / research chat | `reasonix` |
| Driving your own MCP servers | `reasonix --mcp "..."` |
| One-shot question, no TUI | `reasonix run "..."` |
| Reproducing a prior session / benchmark | `reasonix replay path.jsonl` |

---

## Commands inside the session

| command | what it does |
|---|---|
| `/help` | full command reference with hints |
| `/status` | current model · flags · context · session |
| `/preset <fast\|smart\|max>` | one-tap bundle (model + harvest + branch) |
| `/model <id>` | switch DeepSeek model (`deepseek-chat`, `deepseek-reasoner`) |
| `/harvest [on\|off]` | toggle R1 plan-state extraction |
| `/branch <N\|off>` | run N parallel samples per turn, pick best (N ≥ 2) |
| `/mcp` | list attached MCP servers and their tools |
| `/tool [N]` | dump the Nth tool call's full output (1 = latest) |
| `/think` | dump the last turn's full R1 reasoning |
| `/retry` | truncate and resend your last message (fresh sample) |
| `/compact [cap]` | shrink oversized tool results in the log |
| `/sessions` | list saved sessions (current marked with `▸`) |
| `/forget` | delete the current session from disk |
| `/new` (alias `/reset`) | start a fresh conversation in the same session |
| `/clear` | clear visible scrollback only (log kept) |
| `/setup` | reconfigure (exit and run `reasonix setup`) |
| `/exit` | quit |

Additional commands in `reasonix code`:

| command | what it does |
|---|---|
| `/apply` | commit the pending SEARCH/REPLACE blocks to disk |
| `/discard` | drop the pending edit blocks without writing |
| `/undo` | roll back the last applied edit batch |
| `/commit "msg"` | `git add -A && git commit -m "msg"` |

**Keyboard:**

- `Enter` — submit
- `Shift+Enter` / `Ctrl+J` — newline (multi-line paste also supported; `\` + Enter as a portable fallback)
- `↑ / ↓` — walk prompt history while idle; navigate slash-autocomplete matches
- `Tab` / `Enter` on a `/foo` prefix — accept the highlighted suggestion
- `Esc` — abort the current turn (stops the API call, cancels any in-flight tool, rejects pending MCP requests)
- `y` / `n` on confirm prompts — hotkey accept / reject

---

## Sessions and safety nets

- Sessions live as JSONL under `~/.reasonix/sessions/<name>.jsonl` (per
  directory for `reasonix code`). Every message appended atomically; `Ctrl+C`
  never loses context.
- Tool results are capped at 32k chars per call. Oversized sessions
  self-heal on load (shrinks + rewrites the file).
- Malformed `assistant.tool_calls` / `tool` pairing is validated on
  every outgoing API call so a corrupted session can't keep 400ing.
- Context gauge turns yellow at 50%, red at 80% with a `/compact` nudge.
  Approaching the 131k window triggers an automatic compaction attempt
  before falling back to a forced summary.
- The model's sandbox in `reasonix code` refuses any path that resolves
  outside the launch directory, including symlink escape and `..` traversal.

### Troubleshooting: duplicate rows / ghost rendering

Some Windows terminals (Git Bash / MINTTY / winpty-wrapped shells)
don't fully implement the ANSI cursor-up escapes Ink uses to repaint
the live spinner region. Symptom: spinners, streaming previews, or
tool-result rows print multiple copies into scrollback instead of
overwriting in place.

If you hit this, run with plain mode:

```bash
REASONIX_UI=plain npx reasonix code
# or
REASONIX_UI=plain npx reasonix
```

Plain mode suppresses every live/animated row and disables the
internal tick timer. You lose the streaming preview and spinners
but gain stable scrollback. Committed events (your prompts, tool
results, the model's final responses) still render normally via
Ink's `<Static>` append path.

Windows Terminal, PowerShell 7 in Windows Terminal, and WezTerm
don't need this opt-out.

---

## Web search — on by default

The model has two web tools the moment you launch: `web_search` and
`web_fetch`. No flag, no API key, no signup. When you ask about
something the model wasn't trained on (new releases, current events,
obscure APIs), it decides to call `web_search` on its own; if a
snippet isn't enough it follows up with `web_fetch`.

```
you › Flutter 3.19 新加了什么？
assistant
  ▸ tool<web_search> → query: "Flutter 3.19 new features"
  ▸ tool<web_fetch> → https://docs.flutter.dev/release/3-19
  ▸ 3.19 主要新增了 …
```

Backed by **Mojeek**'s public search page — an independent web index,
no API key, no signup, bot-friendly. Coverage on niche or very recent
queries can be thinner than Google/Bing, but it's reliable from
scripts and doesn't gate on cookies or sessions. (DDG was the original
backend but it started serving anti-bot pages in 2026.)

**Turn it off** (offline mode / privacy / CI):

```json
// ~/.reasonix/config.json
{ "apiKey": "sk-…", "search": false }
```

```bash
# Or one env var (wins over config):
REASONIX_SEARCH=off npx reasonix
```

**Bring your own provider** (Kagi, SearXNG, Serper, an internal
cache) — implement the two tools however you want and register them
manually:

```ts
import { ToolRegistry } from "reasonix";
// Register your own `web_search` / `web_fetch` on a ToolRegistry,
// then pass it to CacheFirstLoop (or `reasonix chat --no-config`
// with seedTools via library API).
```

Inside the session:

```
reasonix › Flutter 3.19 引入了什么新的 Navigator API？
assistant
  ▸ tool<web_search> → query: "Flutter 3.19 new Navigator API"
    answer: Flutter 3.19 introduces the NavigatorObserver changes …
    1. Flutter 3.19 Release Notes — https://docs.flutter.dev/…
    2. What's new in Flutter 3.19 — https://medium.com/…
  ▸ tool<web_fetch> → https://docs.flutter.dev/release/release-notes/3-19-0
    (full page text, clipped at 32k)
  ▸ 3.19 新增了 …
```

For advanced / self-hosted search (Kagi, SearXNG, internal caches)
implement the `WebSearchProvider` interface and call
`registerWebTools(registry, { provider })` yourself, or bridge an
existing MCP search server via `--mcp`.

---

## MCP — bring your own tools

Any [MCP](https://spec.modelcontextprotocol.io/) server works. Wizard
lets you pick from a catalog, or drive it by flag:

```bash
# stdio (local subprocess)
npx reasonix --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe"

# multiple servers at once
npx reasonix \
  --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe" \
  --mcp "demo=npx tsx examples/mcp-server-demo.ts"

# HTTP+SSE (remote / hosted)
npx reasonix --mcp "kb=https://mcp.example.com/sse"
```

`reasonix mcp list` shows the curated catalog. `reasonix mcp inspect <spec>`
connects once and dumps the server's tools / resources / prompts without
starting a chat. Progress notifications from long-running tools (2025-03-26
spec) render live as a progress bar in the spinner.

Supported transports: **stdio** (local command) and **HTTP+SSE** (remote,
MCP 2024-11-05 spec).

---

## CLI reference

```bash
npx reasonix                             # chat (uses saved config)
npx reasonix code [path]                 # coding mode scoped to path (default: cwd)
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

`ChatOptions.seedTools` accepts a pre-built `ToolRegistry` for callers
who want the `reasonix code` loop wiring without the CLI wrapper.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for internals.

---

## Why Reasonix (not LangChain)

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
| First-run config prompt + Markdown TUI | yes | no |

On the same τ-bench-lite workload — 8 multi-turn tool-use tasks × 3
repeats = 48 runs per side, live DeepSeek `deepseek-chat`, sole variable
prefix stability:

| metric | baseline (cache-hostile) | Reasonix | delta |
|---|---:|---:|---:|
| cache hit | 46.6% | **94.4%** | +47.7 pp |
| cost / task | $0.002599 | $0.001579 | **−39%** |
| pass rate | 96% (23/24) | **100% (24/24)** | — |

**Verify it yourself — no API key, zero cost:**

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

Full 48-run report: [`benchmarks/tau-bench/report.md`](./benchmarks/tau-bench/report.md).
Reproduce with your own API key: `npx tsx benchmarks/tau-bench/runner.ts --repeats 3`.

MCP reference runs (one single prefix hash across all 5 turns even
with two concurrent MCP subprocesses):

| server | turns | cache hit | cost | vs Claude |
|---|---:|---:|---:|---:|
| bundled demo (`add` / `echo` / `get_time`) | 2 | **96.6%** (turn 2) | $0.000254 | −94.0% |
| official `server-filesystem` | 5 | **96.7%** | $0.001235 | −97.0% |
| **both concurrently** | 5 | **81.1%** | $0.001852 | −95.9% |

---

## Non-goals

- Multi-agent orchestration (use LangGraph).
- RAG / vector stores (use LlamaIndex).
- Multi-provider abstraction (use LiteLLM).
- Web UI / SaaS.

Reasonix does DeepSeek, deeply.

---

## Development

```bash
git clone https://github.com/esengine/reasonix.git
cd reasonix
npm install
npm run dev chat        # run CLI from source via tsx
npm run build           # tsup to dist/
npm test                # vitest (444 tests)
npm run lint            # biome
npm run typecheck       # tsc --noEmit
```

---

## License

MIT
