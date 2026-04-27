<p align="center">
  <img src="docs/logo.svg" alt="Reasonix — DeepSeek 原生的 agent 框架" width="640"/>
</p>

<p align="center">
  <em>为 DeepSeek V4（flash + pro）打造的缓存优先 agent 循环 — Ink TUI、原生 MCP、不依赖 LangChain。</em>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong> · <a href="https://esengine.github.io/reasonix/">官方网站</a>
</p>

# Reasonix

[![npm version](https://img.shields.io/npm/v/reasonix.svg)](https://www.npmjs.com/package/reasonix)
[![CI](https://github.com/esengine/reasonix/actions/workflows/ci.yml/badge.svg)](https://github.com/esengine/reasonix/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/reasonix.svg)](./LICENSE)
[![downloads](https://img.shields.io/npm/dm/reasonix.svg)](https://www.npmjs.com/package/reasonix)
[![node](https://img.shields.io/node/v/reasonix.svg)](./package.json)

**DeepSeek 原生的终端 AI 编程代理。** 单次任务成本约为 Claude Code 的
1/30，缓存优先的循环是为 DeepSeek 的定价模型量身打造的。编辑以可审查的
SEARCH/REPLACE 块呈现，落盘前必须确认。MIT 许可、不绑 IDE、原生 MCP。

---

## 60 秒快速上手

**1. 获取 DeepSeek API Key。** 注册即送免费额度：
<https://platform.deepseek.com/api_keys>

**2. 切到项目目录运行。** 无需安装。

```bash
cd my-project
npx reasonix code
```

首次运行会走 30 秒向导（粘贴 API key → 选预设 → 多选 MCP 服务器）。
之后每次直接进入。

**3. 让它改代码。** 模型会以 SEARCH/REPLACE 块的形式提出编辑——
你不 `/apply`，磁盘不会被改。

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

▸ 1 处待应用编辑（1 个文件）— /apply 写入 · /discard 丢弃

reasonix code › /apply
▸ ✓ applied src/users.ts
```

要求 Node ≥ 20.10。支持 macOS、Linux、Windows（PowerShell · Git Bash ·
Windows Terminal）。任何时候按 `Esc` 中断；`/help` 查看完整命令列表。

---

## 为什么选 Reasonix？（vs Cursor / Claude Code / Cline / Aider）

三件事，别家不会同时都给你：

- **成本节省落到账单上。** DeepSeek V4 的 token 单价大约是 Claude Sonnet
  的 1/30。光便宜还不够 —— *便宜的 token 配上 90%+ 的前缀缓存命中*才是关键。
  Reasonix 的循环按 append-only 增长设计，缓存稳定的前缀在每次工具调用之间
  都活着，下面的 benchmark 章节端到端验证过：实测 94.4% 缓存命中，对照组通用
  框架只有 46.6%。`/stats` 面板每轮都跟踪 "vs Claude Sonnet 4.6" 的节省额，
  你可以亲眼看着账单不涨。

- **它住在终端里。** 纯 CLI —— 没有 Electron，没有 VS Code 插件，没有要
  塞进编辑器的 IDE 插件。和 git、tmux、shell 历史并排。macOS / Linux /
  Windows（PowerShell、Git Bash、Windows Terminal 都测过）。唯一的网络
  请求就是 DeepSeek API 本身，中间没有厂商服务器。

- **开源且彻底可改。** MIT 许可的 TypeScript。整个循环、工具注册表、
  缓存稳定前缀、TUI、MCP 桥接 —— 全部在 `src/` 下，不到 3 万行。Fork
  它、做私有构建、塞进 CI 都可以。没有 SaaS 层，没有企业版，没有功能闸门。

| | Reasonix | Claude Code | Cursor | Cline | Aider |
|---|---|---|---|---|---|
| 后端 | 仅 DeepSeek V4 | 仅 Anthropic | OpenAI / Anthropic | 任意（OpenRouter）| 任意（OpenRouter）|
| 单次任务成本 | **~$0.001–$0.005** | ~$0.05–$0.50 | $20/月 + 用量 | 视情况 | 视情况 |
| 运行环境 | 终端 | 终端 + IDE | IDE（Electron）| 仅 VS Code | 终端 |
| 开源协议 | **MIT** | 闭源 | 闭源 | Apache 2 | Apache 2 |
| 缓存优先前缀循环 | **工程化（94% 命中）** | 基础 | n/a | n/a | 基础 |
| MCP 服务器 | **原生支持** | 原生支持 | — | 测试中 | — |
| 计划模式（只读审计闸门）| **支持** | 支持 | — | 支持 | — |
| 用户编写的 skills | **支持** | 支持 | — | — | — |
| 编辑审阅（不自动落盘）| **支持**（`/apply`）| 支持 | 部分 | 支持 | 支持 |
| 工作区切换（`/cwd`、`change_workspace`）| **支持** | — | n/a（每窗一项目）| — | — |
| 跨会话成本面板 | **支持**（`/stats`）| — | — | — | — |
| 沙箱边界强制 | **严格**（拒绝 `..` 逃逸）| 支持 | 部分 | 支持 | 部分 |

### 这些情况下应该选别的

- **你想要多模型混用**（在一个工具里同时切 Claude / GPT / Gemini / 本地 Llama）。
  试试 [Aider](https://aider.chat) 或 [Cline](https://cline.bot)。Reasonix
  故意只绑 DeepSeek —— 每一层（缓存优先循环、R1 harvest、JSON 模式的工具
  调用修复、reasoning_effort 上限）都是为 DeepSeek 的具体行为和经济模型
  调出来的。绑死后端是设计选择，不是早晚要解决的限制。
- **你想要 IDE 集成**（编辑器侧边栏 inline diff、多光标、ghost text、重构
  预览）。试试 [Cursor](https://cursor.com) 或 Claude Code 的 IDE 模式。
  Reasonix 是终端优先的：diff 在 `git diff` 里、文件树在 `ls` 里、对话
  在 shell 里。
- **你在追最难的推理 benchmark**。Claude Opus 4.6 还是赢一些榜单的。
  DeepSeek V4-pro 在大多数编程任务上都很有竞争力，但不是每个 benchmark
  都领先。如果你的任务是"证明这个 PhD 级别的数学命题"而不是"修这个
  auth bug"，从 Claude 起步更合适。
- **你需要完全本地 / 永远免费**。DeepSeek API 注册送额度，但不是永久
  免费。要真正离线/永久免费，看看 Aider + Ollama 或者
  [Continue](https://continue.dev)。

---

## `reasonix code` — 终端里的结对编程

作用域为启动目录。模型自带 `read_file` / `write_file` / `edit_file` /
`list_directory` / `search_files` / `directory_tree` / `get_file_info` /
`create_directory` / `move_file`，全部在沙箱内 —— 任何解析后落到启动根目录之外
的路径（包括 `..` 或符号链接逃逸）都会被拒绝。再加上带只读白名单的
`run_command`；任何会修改状态的命令（`npm install`、`git commit` 等）都要走
确认弹窗。

### 流程演示：先看再改

对于"这段代码做什么用？"这类问题，模型会用读取类工具，然后用散文回答 ——
不会出 SEARCH/REPLACE 块、也不会写文件。只有你明确要求修改时它才动手：

```
reasonix code › 这个项目的路由是怎么组织的？
assistant
  ▸ tool<directory_tree> → (src/ tree, 47 entries)
  ▸ tool<read_file> → (src/router.ts, 1.2 KB)
  ▸ 路由分三层：顶层 AppRouter 注册 tab，每个 tab 用 React Router 的
    nested routes 写子路径，最后 …
```

`edit_file` 的 SEARCH 块如果没有按字节精确匹配文件内容，编辑会被显式拒绝
而不是模糊匹配。模型能看到错误并自行重试 —— 比起"静默改错"，"显式拒绝"
是更安全的失败方式。

### Plan 模式 —— 执行前先审阅

任何比"改个 typo"更大的改动，模型会被引导先提交一份 markdown 计划。
你会看到 **批准 / 重做 / 取消** 三选一：

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

**强制启用** 用 `/plan` —— 进入显式只读阶段：模型必须先提交计划，否则任何
编辑或非白名单 shell 调用都不会执行。适合那些你想先审一遍再让模型动手的
高风险改动。`/plan off` 或在弹窗里选 Approve/Cancel 退出。

### 输入前缀 —— `!cmd` 与 `@path`

两个不需要斜杠的内联快捷方式：

**`!<cmd>` —— 在沙箱里跑 shell 命令并把结果喂给模型。** 像 bash 一样在
prompt 里直接打。输出既会进入可见日志，也会进入会话 —— 模型下一轮会基于它
推理：

```
reasonix code › !git status --short
▸ M src/users.ts
▸ M src/users.test.ts

reasonix code › 把这两个文件的改动说明一下
assistant
  ▸ tool<read_file> → src/users.ts, src/users.test.ts
  ▸ …
```

无白名单门 —— 用户主动输入的 shell 命令就是显式同意。60 秒超时、32k 字符
上限，0.5.14 起会话恢复后依然保留。

**`@path/to/file` —— 内联一个文件作为 "Referenced files"。** 输入 `@`
弹出选择器（↑/↓ 切换、Tab/Enter 插入）。比让模型 `read_file` 后再问更省事：
"@src/users.ts 这个文件做什么用？"。沙箱限定：仅相对路径、不允许 `..`、单
文件 64KB 上限。最近用过的文件排在前面。

### `/commit` —— 一步暂存 + 提交

```
reasonix code › /commit "fix: findByEmail case-insensitive"
▸ git add -A && git commit -m "fix: findByEmail case-insensitive"
  [main a1b2c3d] fix: findByEmail case-insensitive
```

### 一些值得试试的命令

- `/tool 1` —— 打印最后一次工具调用的完整输出（当 400 字内联剪辑不够看时）。
- `/think` —— 看上一轮模型的完整推理（思考模式：v4-flash / v4-pro / reasoner 别名）。
- `/undo` —— 回滚上一批已应用的编辑。
- `/new` —— 在同一目录开新会话，但不丢失旧会话文件。
- `/effort high` —— 从默认 `max` agent 推理强度降一档，简单任务更省更快。
- `npx reasonix code --preset max` —— v4-pro + 三路 self-consistency 分支，
  适合疑难重构。
- `npx reasonix code src/` —— 更窄的沙箱（只有 `src/` 可写）。
- `npx reasonix code --no-session` —— 临时会话，什么都不存。

### `reasonix stats` —— 你到底省了多少？

每次 `reasonix chat|code|run` 跑完都会往
`~/.reasonix/usage.jsonl` 追加一条精简记录（token + 成本 + Claude Sonnet
4.6 同负载下的等价价格）。`reasonix stats` 不带参数会把日志聚合成今日 /
本周 / 本月 / 历史 四个窗口：

```
Reasonix usage — /Users/you/.reasonix/usage.jsonl

            turns  cache hit    cost (USD)      vs Claude     saved
----------------------------------------------------------------------
today           8      95.1%     $0.004821        $0.1348      96.4%
week           34      93.8%     $0.023104        $0.6081      96.2%
month         127      94.2%     $0.081530        $2.1452      96.2%
all-time      342      94.0%     $0.210881        $5.8934      96.4%
```

隐私：日志里只有 token、成本和你自己取的 session 名。没有 prompt、没有
completion、没有工具参数。`reasonix stats <transcript>` 仍兼容老用法
（按文件出 assistant turn + tool call 摘要）。

### 保持最新

面板顶栏在 `Reasonix` 旁边显示当前版本（如
`Reasonix v0.5.21 · deepseek-v4-pro · harvest · max …`，最后那个 `max` 是
推理强度徽章 —— `/effort high` 可降一档）。后台每 24 小时静默查询一次 npm
registry，发现新版会在同一行右侧显示黄色 `update: X.Y.Z`。不阻塞、不烦人，
每天最多查一次，离线 / 防火墙下静默失败。

```bash
reasonix update             # 打印当前 vs 最新，并执行 `npm i -g reasonix@latest`
reasonix update --dry-run   # 只打印计划，不实际安装
```

通过 `npx` 用？命令会识别这种情况并改为打印 cache 刷新提示 —— npx 在下次
调用时会自动取最新版本。

### 项目约定 —— `REASONIX.md`

把 `REASONIX.md` 放到项目根目录，每次启动都会被钉进 system prompt。可提交
的团队记忆 —— 房间约定、领域词表、模型老忘的事情：

```bash
cat > REASONIX.md <<'EOF'
# Notes for Reasonix
- Use snake_case for new Python modules; legacy camelCase modules keep their style.
- `cargo check` is in the auto-run allowlist; full `cargo test` needs confirmation.
- The `api/` dir mirrors `backend/` — keep schemas in sync.
EOF
```

重启（或 `/new`）后生效；前缀每会话只哈希一次，让 DeepSeek 的缓存保持热。
`/memory` 打印当前已钉的内容。`REASONIX_MEMORY=off` 在 CI / 离线复现时关闭
所有记忆来源。

### 用户记忆 —— `~/.reasonix/memory/`

第二层 **私人按用户** 的记忆放在你的 home 目录。不像 `REASONIX.md` 会被
提交，模型自己也能通过 `remember` 工具往里写。两个作用域：

- `~/.reasonix/memory/global/` —— 跨项目（你的偏好、工具链）。
- `~/.reasonix/memory/<project-hash>/` —— 限定一个 `reasonix code` 沙箱
  根目录（决策、本地事实、按仓库的快捷方式）。

每个作用域都维护一个总是加载的 `MEMORY.md` 索引（一行一条）+ 零或多个
`<name>.md` 详情文件（按需通过 `recall_memory` 加载）。写入立刻生效；钉进
system prompt 在下一次 `/new` 或重启时生效，以保证当前会话的缓存前缀稳定。

```
reasonix code › 我用 bun 而不是 npm，请以后都用 bun 跑构建

assistant
  ▸ tool<remember> → project/bun_build saved
    "Build command on this machine is `bun run build`"
```

**斜杠**：`/memory` · `/memory list` · `/memory show <name>` ·
`/memory forget <name>` · `/memory clear <scope> confirm`。
**模型工具**：`remember(type, scope, name, description, content)` ·
`forget(scope, name)` · `recall_memory(scope, name)`。

项目作用域只在 `reasonix code` 里可用（需要真实的沙箱根来计算哈希）；纯
`reasonix` 只有全局作用域。

### Skills —— 用户自定义的 prompt 包

Skill 就是你写在磁盘上的散文指令块。Reasonix 把它们的名字 + 一行描述钉
进 system prompt；模型可以在合适时机自动调 `run_skill({name: "..."})`，
你也可以打 `/skill <name> [args]` 手动触发。

两个作用域，与用户记忆同样的布局：

- `<project>/.reasonix/skills/` —— 按项目（提交进 git 给团队，或加入
  `.gitignore` 做个人草稿）。
- `~/.reasonix/skills/` —— 全局，到处可用。

两种文件结构都行：`<name>/SKILL.md`（推荐 —— 可同时打包附带资源）或扁平
`<name>.md`。

```markdown
---
name: review
description: Review uncommitted changes and flag risks
---

Run `git diff` on staged and unstaged changes. Summarize what each
hunk does, call out potential regressions, and list files that might
need additional tests. Don't propose edits unless I ask.
```

用法：

```
reasonix code › /skill review
▸ running skill: review
assistant
  ▸ tool<run_command> → git diff --cached
  ▸ 3 改动，1 个需要回归测试 …
```

或者让模型自己挑 —— 因为 skill 名字 + 描述都在前缀里，问 "帮我看下未提交
的改动有没有风险" 就会触发 `run_skill({name: "review"})`，不用你打斜杠。

**斜杠**：`/skill`（列出） · `/skill show <name>` · `/skill <name>
[args]`（把 body 作为用户轮注入）。

**故意不绑死** 任何其他客户端的目录约定（`.claude/skills` 等等）——
Reasonix 在对话层是模型无关的。任何 SKILL.md 都能用；body 是散文，所以
为别的工具写的 skill 多半能直接用（Reasonix 工具名不同 —— `filesystem`
/ `shell` / `web` —— 但模型读到指令后会挑我们的等价工具）。

### Hooks —— 围绕工具调用与轮次自动化

在 `.reasonix/`（项目或 `~/`）放一个 `settings.json`，Reasonix 会在
循环里四个常见的点触发 shell 命令：工具运行前、工具返回后、prompt 到达
模型前、轮次结束后。

```json
// <project>/.reasonix/settings.json   ← 可提交
// ~/.reasonix/settings.json           ← 按用户
{
  "hooks": {
    "PreToolUse":       [{ "match": "edit_file|write_file", "command": "bun scripts/guard.ts" }],
    "PostToolUse":      [{ "match": "edit_file", "command": "biome format --write" }],
    "UserPromptSubmit": [{ "command": "echo $(date +%s) >> ~/.reasonix/prompts.log" }],
    "Stop":             [{ "command": "bun test --run", "timeout": 60000 }]
  }
}
```

每个 hook 都是 shell 命令。Reasonix 调用时通过 stdin 传一份 JSON 信封，
描述事件：

```json
{ "event": "PreToolUse", "cwd": "/path/to/project",
  "toolName": "edit_file", "toolArgs": { "path": "src/x.ts", "..." } }
```

退出码决定走向：

- **0** —— 通过；循环正常继续
- **2** —— 阻断（仅对 `PreToolUse` / `UserPromptSubmit` 生效）；hook 的
  stderr 会作为合成工具结果让模型看到，或者整条 prompt 直接被丢弃
- **其他** —— 警告；循环继续，stderr 渲染为黄色行内提示

`match` 是对工具名的锚定正则；`*` 或省略匹配所有工具。项目 hook 先于全局
hook 触发。默认超时：阻断类事件 5 秒，日志类事件 30 秒；可在每条 hook 里
用 `timeout` 覆盖。

**斜杠**：`/hooks`（列出当前生效的 hook）· `/hooks reload`（不丢会话从磁盘
重读 `settings.json`）。

### 在 TUI 里保持最新

`/update` 在运行中的会话里会显示当前版本、最近一次后台 24h 检查取到的最新
版本，以及实际安装命令。这条斜杠 **不会** 直接 spawn `npm install` ——
stdio:inherit 进入正在跑的 Ink 渲染器会把显示搞乱。要真正升级请退出会话，
在新 shell 里执行 `reasonix update`。

---

## `reasonix` —— 也能当通用聊天

同一套 TUI，没有文件系统工具（除非你通过 MCP 主动接入）。适合起草、问答、
schema 设计、架构讨论，或者驱动你自己的 MCP 服务器。会话按名字保存在
`~/.reasonix/sessions/`。

```bash
npx reasonix                             # 用已保存配置 + 向导选过的 MCP
npx reasonix --preset smart              # 这次跑用 reasoner + R1 harvest
npx reasonix --session design            # 命名会话 — 之后 --session design 续聊
```

临时挂 MCP 服务器：

```bash
npx reasonix \
  --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe" \
  --mcp "kb=https://mcp.example.com/sse"
```

MCP 工具走和原生工具一样的 Cache-First + 修复 + 上下文安全管线 —— 32k
结果上限、实时进度通知渲染、自动重试。

---

## 会话内命令

**核心**

| 命令 | 作用 |
|---|---|
| `/help` · `/?` | 完整命令参考（带提示） |
| `/status` | 当前模型 · flag · 上下文 · 会话 |
| `/new` · `/reset` | 同会话内开新对话 |
| `/clear` | 仅清空可见 scrollback（日志保留） |
| `/retry` | 截断并重发上一条消息（重新采样） |
| `/exit` · `/quit` | 退出 |

**模型**

| 命令 | 作用 |
|---|---|
| `/preset <fast\|smart\|max>` | 一键预设（model + harvest + branch） |
| `/model <id>` | 切换 DeepSeek 模型（`deepseek-v4-flash`、`deepseek-v4-pro`，加上 `deepseek-chat` / `deepseek-reasoner` 兼容别名） |
| `/models` | 列出 DeepSeek `/models` 端点的可用模型 |
| `/harvest [on\|off]` | 切换 R1 plan-state 提取 |
| `/branch <N\|off>` | 每轮跑 N 路并行采样，挑最佳（N ≥ 2） |
| `/effort <high\|max>` | reasoning_effort 上限 —— `max` 是 agent 默认，`high` 更便宜更快 |
| `/think` | 打印上一轮的完整 thinking-mode 推理 |

**上下文与工具**

| 命令 | 作用 |
|---|---|
| `/mcp` | 列出已挂载的 MCP 服务器及其 tool / resource / prompt |
| `/resource [uri]` | 浏览 + 读取 MCP resource（无参 → 列 URI；`<uri>` → 拉取） |
| `/prompt [name]` | 浏览 + 拉取 MCP prompt |
| `/tool [N]` | 打印第 N 次工具调用的完整输出（1 = 最近） |
| `/compact [tokens]` | 压缩日志里超大的工具结果（默认每条结果 4000 tokens） |
| `/context` | 看上下文 token 都花在哪（system / tools / log） |
| `/stats` | 跨会话成本仪表盘（today / week / month / all-time） |
| `/keys` | 键盘快捷键 + 输入前缀（`!` / `@` / `/`）速查 |

**记忆与 Skill**

| 命令 | 作用 |
|---|---|
| `/memory` | 显示已钉记忆（REASONIX.md + ~/.reasonix/memory） |
| `/memory list` · `show <name>` · `forget <name>` · `clear <scope> confirm` | 管理记忆库 |
| `/skill` · `/skill list` | 列出已发现的 skill（项目 + 全局） |
| `/skill show <name>` | 打印某个 skill 的 body |
| `/skill <name> [args]` | 运行 skill（把 body 作为用户轮注入） |

**会话**

| 命令 | 作用 |
|---|---|
| `/sessions` | 列出已保存的会话（当前用 `▸` 标记） |
| `/forget` | 从磁盘删除当前会话 |
| `/setup` | 重新配置（退出后跑 `reasonix setup`） |

**只在 code 模式下** (`reasonix code`)

| 命令 | 作用 |
|---|---|
| `/apply` | 把待应用的 SEARCH/REPLACE 块写入磁盘 |
| `/discard` | 丢弃待应用的编辑块 |
| `/undo` | 回滚最后一批已应用的编辑 |
| `/commit "msg"` | `git add -A && git commit -m "msg"` |
| `/plan [on\|off]` | 切换只读 plan 模式 |
| `/apply-plan` | 强制批准当前待审计划 |

**键盘**

- `Enter` —— 提交
- `Shift+Enter` / `Ctrl+J` —— 换行（多行粘贴也行；
  `\` + Enter 是跨平台兜底）
- `↑` / `↓` —— 空闲时翻 prompt 历史；在斜杠自动补全里上下选
- `/foo` 前缀下按 `Tab` / `Enter` —— 接受高亮的建议
- `Esc` —— 中断当前轮（停 API 调用、取消进行中的工具、拒绝待响应的 MCP 请求）
- 确认弹窗里的 `y` / `n` —— 快捷接受 / 拒绝

---

## 会话与安全网

- 会话以 JSONL 形式保存在 `~/.reasonix/sessions/<name>.jsonl`（`reasonix
  code` 按目录分）。每条消息都原子追加；`Ctrl+C` 不会丢上下文。
- 工具结果每次调用最多 32k 字符。超大会话加载时自动自愈（缩小并重写文件）。
- 每次出站 API 调用前会校验 `assistant.tool_calls` / `tool` 的配对，损坏的
  会话不会一直 400。
- 上下文仪表 50% 变黄、80% 变红并提示 `/compact`。接近 1M token 上限
  （V4 flash + pro）会先尝试自动压缩，再退化为强制总结。
- `reasonix code` 沙箱拒绝任何解析后落到启动目录之外的路径（含符号链接
  逃逸和 `..` 穿越）。

### 故障排查：重复行 / 鬼影渲染

有些 Windows 终端（Git Bash / MINTTY / winpty 包装的 shell）没完整实现
Ink 用的 ANSI cursor-up 转义。表现：spinner、流式预览、工具结果行不在原地
覆盖刷新，反而在 scrollback 里印出多份。

遇到了就用 plain 模式：

```bash
REASONIX_UI=plain npx reasonix code
```

Plain 模式抑制了实时 / 动画行，关掉了内部 tick 计时器。代价是失去流式预览
和 spinner，但 scrollback 稳定。Windows Terminal、Windows Terminal 里的
PowerShell 7、WezTerm 不需要这个开关。

---

## Web 搜索 —— 默认开

模型一启动就有两个 web 工具：`web_search` 和 `web_fetch`。无 flag、无 API
key、无注册。当你问到模型训练时没见过的事（新发布、最近事件、冷门 API），
它会自己决定调 `web_search`；snippet 不够就跟一个 `web_fetch`。

底层是 **Mojeek** 的公开搜索页 —— 独立 web 索引，bot 友好，无 cookie /
session。冷门或非常新的查询覆盖率比 Google/Bing 薄一些，但脚本里很可靠。
（DDG 是原始后端，但 2026 年开始上反机器人页。）

**关掉**（离线 / 隐私 / CI）：

```json
// ~/.reasonix/config.json
{ "apiKey": "sk-…", "search": false }
```

```bash
REASONIX_SEARCH=off npx reasonix code
```

**接自己的**（Kagi、SearXNG、内部缓存）：实现 `WebSearchProvider` 接口
然后自己调 `registerWebTools(registry, { provider })`，或通过 `--mcp`
桥接已有的 MCP 搜索服务器。

---

## MCP —— 自带工具

任意 [MCP](https://spec.modelcontextprotocol.io/) 服务器都能用。向导内置
目录可选，或用 flag 直接挂：

```bash
# stdio（本地子进程）
npx reasonix --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe"

# 同时挂多个
npx reasonix \
  --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe" \
  --mcp "demo=npx tsx examples/mcp-server-demo.ts"

# HTTP+SSE（远程 / 托管）
npx reasonix --mcp "kb=https://mcp.example.com/sse"
```

`reasonix mcp list` 显示精选目录。`reasonix mcp inspect <spec>` 不开聊天，
直接连一次并打印服务器的 tool / resource / prompt。长任务的进度通知
（2025-03-26 spec）会以进度条形式实时渲染在 spinner 里。

支持的传输：**stdio**（本地命令）和 **HTTP+SSE**（远程，MCP 2024-11-05
spec）。

---

## CLI 参考

```bash
npx reasonix code [path]                 # 编程模式，作用域 path（默认 cwd）
npx reasonix                             # 聊天（用已保存配置）
npx reasonix setup                       # 重跑配置向导
npx reasonix chat --session work         # 命名会话
npx reasonix chat --no-session           # 临时会话
npx reasonix run "ask anything"          # 一次性运行，结果流到 stdout
npx reasonix stats session.jsonl         # 总结一份 transcript
npx reasonix replay chat.jsonl           # 从 transcript 重建成本/缓存视图
npx reasonix diff a.jsonl b.jsonl --md   # 对比两份 transcript
npx reasonix mcp list                    # 精选 MCP 目录
npx reasonix mcp inspect <spec>          # 探测单个 MCP 服务器
npx reasonix sessions                    # 列已保存会话
```

常用 flag：

```bash
--preset <fast|smart|max>   # 预设组合（model + harvest + branch）
--model <id>                # 显式指定模型 ID
--harvest / --no-harvest    # R1 plan-state 提取
--branch <N>                # self-consistency 预算
--mcp "name=cmd args…"      # 挂 MCP 服务器（可重复）
--transcript path.jsonl     # 同时旁路写一份 JSONL transcript
--session <name>            # 命名会话（code 模式默认按目录）
--no-session                # 临时会话
--no-config                 # 忽略 ~/.reasonix/config.json（CI 友好）
```

环境变量（覆盖 config）：

```bash
export DEEPSEEK_API_KEY=sk-...
export DEEPSEEK_BASE_URL=https://...   # 可选的备用端点
export REASONIX_MEMORY=off              # 关闭 REASONIX.md + 用户记忆
export REASONIX_SEARCH=off              # 关闭 web_search / web_fetch
export REASONIX_UI=plain                # 关闭实时行（鬼影绕开）
```

---

## 库用法

```ts
import {
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
  ToolRegistry,
} from "reasonix";

const client = new DeepSeekClient(); // 从环境变量读 DEEPSEEK_API_KEY
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

`ChatOptions.seedTools` 接受一个预置好的 `ToolRegistry`，如果你只想要
`reasonix code` 的 loop 接线、不要 CLI 包装。详见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 性能对比 —— 缓存命中率自己也能验证

这里每个抽象都对应 DeepSeek 的一个具体特性 —— 极低 token 价、R1 推理轨
迹、自动前缀缓存、JSON 模式。通用框架把这些机会全留在桌上。

| | Reasonix 默认 | 通用框架 |
|---|---|---|
| 前缀稳定的循环（→ 85–95% 缓存命中） | 是 | 否（每轮重建 prompt） |
| 自动展平深层 tool schema | 是 | 否（DeepSeek 会丢参数） |
| 带 jitter 退避的 429/503 重试 | 是 | 否（要自己写回调） |
| 抢救泄到 `<think>` 里的 tool call | 是 | 否 |
| 同参数重复爆发熔断 | 是 | 否 |
| 实时缓存命中 / 成本 / vs Claude 面板 | 是 | 否 |

同一 τ-bench-lite 负载（8 个多轮工具调用任务 × 3 次重复 = 每边 48 次运行），
实测 DeepSeek `deepseek-chat`，唯一变量是前缀稳定性：

| 指标 | 基线（缓存敌对） | Reasonix | 差值 |
|---|---:|---:|---:|
| 缓存命中 | 46.6% | **94.4%** | +47.7 pp |
| 单任务成本 | $0.002599 | $0.001579 | **−39%** |
| 通过率 | 96% (23/24) | **100% (24/24)** | — |

**无需消耗 API 额度即可复现：**

```bash
git clone https://github.com/esengine/reasonix.git && cd reasonix && npm install
npx reasonix replay benchmarks/tau-bench/transcripts/t01_address_happy.reasonix.r1.jsonl
npx reasonix diff \
  benchmarks/tau-bench/transcripts/t01_address_happy.baseline.r1.jsonl \
  benchmarks/tau-bench/transcripts/t01_address_happy.reasonix.r1.jsonl
```

提交进仓库的 JSONL 文件每轮带 `usage`、`cost`、`prefixHash`。Reasonix
的前缀哈希在每次模型调用时都字节稳定；基线则每轮都变。缓存差距是从日志稳
定性 **机械可推导** 的，不依赖于 prompt 写得不一样。

完整 48 次运行报告：
[`benchmarks/tau-bench/report.md`](./benchmarks/tau-bench/report.md)。
用自己的 API key 复现：`npx tsx benchmarks/tau-bench/runner.ts --repeats 3`。

MCP 参考运行（即使两个 MCP 子进程并发，整 5 轮也只有一个前缀哈希）：

| 服务器 | 轮次 | 缓存命中 | 成本 | vs Claude |
|---|---:|---:|---:|---:|
| 内置 demo（`add` / `echo` / `get_time`） | 2 | **96.6%**（第 2 轮） | $0.000254 | −94.0% |
| 官方 `server-filesystem` | 5 | **96.7%** | $0.001235 | −97.0% |
| **两者并发** | 5 | **81.1%** | $0.001852 | −95.9% |

---

## Non-goals（明确不做）

- **多 agent 编排 / 子 agent**（用 LangGraph）。
- **工作流 DSL / DAG 调度 / 并行分支引擎** —— skill 是散文，模型靠正常的
  tool-use 循环串起来。这样保住了单循环 + append-only + cache-first 三大
  不变量。
- **多供应商抽象**（用 LiteLLM）。Reasonix 故意只做 DeepSeek —— 每个支柱
  （cache-first 循环、R1 抢救、tool-call 修复）都针对 DeepSeek 的具体行为
  和经济性做了调优。绑死一家后端是特性。
- **RAG / 向量库**（用 LlamaIndex）。
- **Web UI / SaaS。**

Reasonix 只做 DeepSeek，做到底。

---

## 开发

```bash
git clone https://github.com/esengine/reasonix.git
cd reasonix
npm install
npm run dev code        # 用 tsx 直接从源码跑 CLI
npm run build           # tsup 打包到 dist/
npm test                # vitest（1482 个测试）
npm run lint            # biome
npm run typecheck       # tsc --noEmit
```

---

## License

MIT
