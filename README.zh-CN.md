<p align="center">
  <img src="docs/logo.svg" alt="Reasonix — DeepSeek 原生的 agent 框架" width="640"/>
</p>

<p align="center">
  <em>为 DeepSeek V4 打造的缓存优先 agent 循环 — 终端原生、原生 MCP、不依赖 LangChain。</em>
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

**DeepSeek 原生的终端 AI 编程代理。** 单次任务成本约为 Claude Code 的 1/30，整个循环围绕 DeepSeek 的前缀缓存机制打造，所以省钱是真省（94% 真实命中率，不是理论值）。MIT 许可，不绑 IDE，原生支持 MCP。

---

## 快速上手

```bash
cd my-project
npx reasonix code
```

首次运行：粘贴一个 [DeepSeek API Key](https://platform.deepseek.com/api_keys)、选预设、可选地多选 MCP 服务器。之后每次直接进入。

```
reasonix code › 修一下 findByEmail 对大小写敏感的登录 bug

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

▸ 1 处待应用编辑 · /apply 写入 · /discard 丢弃
```

不 `/apply`，磁盘不会被改。要求 Node ≥ 20.10。已在 macOS、Linux、Windows（PowerShell · Git Bash · Windows Terminal）测过。

---

## 横向对比

|                                  | Reasonix          | Claude Code     | Cursor             | Aider             |
|----------------------------------|-------------------|-----------------|--------------------|-------------------|
| 后端                             | DeepSeek V4       | Anthropic       | OpenAI / Anthropic | 任意（OpenRouter）|
| **单任务成本**                   | **~¥0.01–0.04**   | ~¥0.40–4        | ¥150/月 + 用量     | 不一              |
| 运行环境                         | 终端              | 终端 + IDE      | IDE (Electron)     | 终端              |
| 协议                             | **MIT**           | 闭源            | 闭源               | Apache 2          |
| **DeepSeek 前缀缓存命中**        | **94%**（实测）   | 不适用          | 不适用             | ~33%（基线）      |
| 计划模式（只读审计闸）           | 支持              | 支持            | —                  | 支持              |
| 编辑审查（`/apply`，不自动落盘） | 支持              | 支持            | 部分               | 支持              |
| MCP servers                      | 一等公民          | 一等公民        | —                  | —                 |
| 用户自定义 skill                 | 支持              | 支持            | —                  | —                 |
| 内嵌 web 仪表盘                  | 支持              | —               | 不适用 (IDE)       | —                 |
| Hooks（`PreToolUse` 等）         | 支持              | 支持            | —                  | —                 |
| 沙箱边界                         | 严格              | 支持            | 部分               | 支持              |
| 持久化的工作区会话               | 支持              | 部分            | 不适用             | —                 |

数据来自 `benchmarks/tau-bench-lite`（8 个多轮任务 × 3 次重放，真实 `deepseek-chat`）。[完整 transcript →](./benchmarks/)

<details>
<summary><strong>为什么只支持 DeepSeek？— 缓存经济学</strong></summary>

便宜的 token 只是故事的一半。DeepSeek 的前缀缓存是**字节稳定**的：缓存指纹从 prompt 第 0 字节开始算。Reasonix 整个循环都围绕这一点设计——只追加、不重排、不做基于标记的 compaction，所以缓存前缀能跨过每一次工具调用存活下来。

对比一下：Claude Code 是围绕 Anthropic 的 `cache_control` 标记构建的（完全不同的机制）。把 Claude Code 指向 DeepSeek 的 Anthropic 兼容端点，能拿到便宜的 token，但缓存命中没了——标记被忽略，底下的前缀本来就不字节稳定。通用后端工具（Aider / Cline / Continue）从另一个方向撞上同一堵墙：它们的 compaction 模式会破坏字节稳定。

按 DeepSeek 的定价 —— $0.07/Mtok 未命中、$0.014/Mtok 命中 —— **50% 命中和 94% 命中之间的差距，光是输入成本就大约 2.5 倍。** 同模型、同 API；变的只是循环本身的不变量。

通用循环漏掉的几个 DeepSeek 专属修复：

| 通用循环假设的 | DeepSeek 实际表现 | Reasonix 的处理 |
|---|---|---|
| reasoning 在结构化的 `thinking` 块里 | R1 偶尔把 tool-call JSON 漏在 `<think>` 标签里 | 一个 `scavenge` pass 把逃逸的 tool call 拉回来 |
| 工具 schema 严格校验 | DeepSeek 会静默丢掉深层嵌套的 object/array 参数 | 自动 flatten——嵌套参数被改写成单层带前缀的名字 |
| tool-call 参数是合法 JSON | DeepSeek 偶尔吐 `string="false"` 之类的破碎片段 | 专门的 `ToolCallRepair` 在 dispatch 前把常见形状修好 |
| reasoning 深度靠系统级开关调 | V4 暴露了 `reasoning_effort` 旋钮（`max` / `high`） | `/effort` 斜杠 + `--effort` flag，便宜回合可以降档 |

缓存稳定不是个开关，是循环要围绕设计的不变量。这就是 Reasonix 只支持 DeepSeek 的根本原因。

</details>

---

## 功能一览

### 缓存优先的 agent 循环
跨工具调用保持前缀稳定。支持 R1 风格的推理，配 `scavenge` pass 把逃逸到 `<think>` 块里的 tool call 拉回来。`ToolCallRepair` 在 dispatch 前修复畸形参数。`/effort` 让你给便宜回合降推理深度。

### 工具注册表
原生：`read_file`、`write_file`、`edit_file`（SEARCH/REPLACE）、`list_directory`、`search_files`、`grep_files`、`run_command`、`run_background`、`web_search`、`web_fetch`。全部沙箱在启动目录内。**MCP 一等公民** —— `--mcp 'name=cmd args'` 加外部服务器（stdio / Streamable HTTP / SSE），工具按前缀合入注册表。

### 计划模式 + 编辑审查
`/plan` 进只读审计闸，模型在你批准书面计划之前不能下发编辑。编辑以 SEARCH/REPLACE 块的形式出现；不 `/apply` 不落盘。`/walk` 一次过一处编辑。`/discard` 全部丢弃。

### 工作区作用域的会话
会话存在 `~/.reasonix/sessions/`，按启动目录过滤。`--new` 会用时间戳保留旧会话；`--resume` 找最新的。会话中途用 `/sessions` 切换，不必退出。

### 内嵌 web 仪表盘
`/dashboard` 打开一个本地 SPA，镜像运行中的 TUI —— chat（在老 PowerShell 上 TUI 渲染崩了时也能完整接管）、editor（文件树 + CodeMirror）、Sessions / Plans / Usage / Tools / MCP / Memory / Hooks / Settings。token 鉴权、CSRF 校验、临时端口。[设计稿 →](./design/agent-dashboard.html)

### Hooks
可配置的 shell 脚本，在 `PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`、`Notification`、`SessionEnd` 触发。配置在 `.reasonix/settings.json`（项目级）或 `~/.reasonix/settings.json`（用户级）。harness 来执行，不是模型。

### Memory + Skills
两层：项目作用域的 `REASONIX.md`（提交进 git，写仓库约定），和用户作用域的 `~/.reasonix/memory/`（私有，模型可以通过 `remember` 工具自己写）。Skills 是用户编写的 prompt 包，可选用 sub-agent 执行。

### 权限
`allow` / `ask` / `deny` 模式匹配命令和工具。`npm publish` 默认 `ask`；`rm -rf *` 和 `git push --force *` 默认 `deny`。"批准一次"的决定可以按前缀记住。

[官网完整文档 →](https://esengine.github.io/reasonix/) · [架构文档 →](./docs/ARCHITECTURE.md) · [TUI 设计稿 →](./design/agent-tui-terminal.html)

---

## 参与贡献

Reasonix 现在主要是单人维护，但是为协作设计的。给新手准备的几个 issue：

- [#15 — 给 `reasonix doctor` 加 `--json` flag](https://github.com/esengine/reasonix/issues/15) · CLI · 2-3 小时
- [#16 — 让 `web_search` / `web_fetch` 的错误信息可执行](https://github.com/esengine/reasonix/issues/16) · tools · 2-3 小时
- [#17 — Slash 命令的 "did you mean?" 建议](https://github.com/esengine/reasonix/issues/17) · TUI · 2-3 小时
- [#18 — `clipboard.ts` 的单元测试](https://github.com/esengine/reasonix/issues/18) · 测试 · 2-3 小时

每个 issue 都有背景说明、代码定位、验收标准、提示。所有 [`good first issue`](https://github.com/esengine/reasonix/labels/good%20first%20issue) 在这。

**正在征集意见的 Discussions：**
- [#20 · CLI / TUI 设计](https://github.com/esengine/reasonix/discussions/20) — 哪里坏了、哪里少东西、哪里你会怎么改？
- [#21 · Dashboard 设计](https://github.com/esengine/reasonix/discussions/21) — 对着[设计稿](./design/agent-dashboard.html)拍砖
- [#22 · 未来功能愿望单](https://github.com/esengine/reasonix/discussions/22) — 你希望 Reasonix 长出什么功能？

**第一次提 PR 之前**：先读 [`CLAUDE.md`](./CLAUDE.md)。短小、严格的项目规则；`tests/comment-policy.test.ts` 静态强制执行，`npm run verify` 是 push 前的闸。

```bash
git clone https://github.com/esengine/reasonix.git
cd reasonix
npm install
npm run dev code        # 用 tsx 从源码跑
npm run verify          # lint + typecheck + 1665 个测试
```

---

## 不做的事

- **多供应商灵活性。** 故意只做 DeepSeek —— 每一层都为 DeepSeek 特定的缓存机制和定价调过。绑死一个后端是 feature，不是要克服的限制。
- **IDE 集成。** 终端优先；diff 在 `git diff`，文件树在 `ls`。仪表盘是 TUI 的伴生，不是 Cursor 的替代。
- **追最难的 reasoning 榜单。** Claude Opus 在某些榜单上还是赢家。DeepSeek V4 在编程任务上有竞争力；如果你的工作是"解一个 PhD 级证明"而不是"修个 auth bug"，先用 Claude。
- **完全离线 / 永远免费。** DeepSeek API 注册送免费额度，但不会一直免费。要离线，看 Aider + Ollama 或 [Continue](https://continue.dev)。

---

## 协议

MIT —— 见 [LICENSE](./LICENSE)。
