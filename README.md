# Reasonix

**The DeepSeek-native agent framework.** TypeScript. Ink TUI. No LangChain.

Reasonix is not another generic agent framework. It does one thing: take DeepSeek's
unusual economic and behavioral profile — dirt-cheap tokens, R1 reasoning traces,
automatic prefix caching — and turn them into agent-loop superpowers that generic
frameworks leave on the table.

```bash
npm install reasonix       # or: npm i -g reasonix for the CLI
export DEEPSEEK_API_KEY=sk-...
npx reasonix chat          # live TUI with real-time cache-hit and cost panel
```

## Why Reasonix?

Every other framework treats DeepSeek as an OpenAI-compatible endpoint with a
different base URL. That works, but it leaves most of DeepSeek's advantages
unused. Reasonix is opinionated about three things:

### 1. Cache-First Loop
DeepSeek bills cached input tokens at **~10% of the miss rate**. Reasonix
structures the agent loop as `[Immutable Prefix] + [Append-Only Log] +
[Volatile Scratch]` so every turn reuses the exact byte prefix.

**Validated on real DeepSeek API (`deepseek-chat`):**

| scenario | turns | cache hit | cost | cost on Claude Sonnet 4.6 | savings |
|---|---|---|---|---|---|
| Chinese multi-turn chat | 5 | **85.2%** | $0.000923 | $0.015174 | **93.9%** |
| Tool-use (calculator) | 2 | **94.9%** | $0.000142 | $0.003351 | **95.8%** |

### 2. R1 Thought Harvesting
R1's `reasoning_content` contains a *plan*, not just trivia to display. Reasonix
parses it into typed plan state (subgoals, hypotheses, uncertainties, rejected
paths) and feeds that state to the orchestrator — branching decisions are made
on structured signals, not regex-brittle prompt hacks. *(v0.2)*

### 3. Tool-Call Repair
R1/V3 have known quirks — tool calls leaking into `<think>`, dropped arguments
on deep schemas, truncated JSON, call-storm loops. Reasonix ships a full repair
pipeline: **scavenge + flatten + truncation recovery + storm breaker**.

## Usage

### Library

```ts
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix, ToolRegistry } from "reasonix";

const client = new DeepSeekClient();
const tools = new ToolRegistry();

tools.register({
  name: "add",
  description: "Add two integers",
  parameters: {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "integer" } },
    required: ["a", "b"],
  },
  fn: ({ a, b }) => a + b,
});

const loop = new CacheFirstLoop({
  client,
  prefix: new ImmutablePrefix({
    system: "You are a math helper.",
    toolSpecs: tools.specs(),
  }),
  tools,
});

for await (const ev of loop.step("What is 17 + 25?")) {
  console.log(ev);
}
console.log(loop.stats.summary());
```

### CLI / TUI

```bash
reasonix chat             # full-screen Ink TUI, live cache/cost panel
reasonix run "task"       # one-shot, streaming output
reasonix stats <file>     # summarize transcript JSONL
reasonix version
```

## Status

Pre-alpha. v0.0.1 ships Pillar 1 and Pillar 3 working end-to-end; Pillar 2 is a
stub with a stable surface. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Non-goals

- Multi-agent orchestration (use LangGraph if you need it).
- RAG / vector stores.
- Multi-provider abstraction. **Reasonix does DeepSeek, deeply.**
- Web UI / SaaS.

## Development

```bash
npm install
npm run dev chat          # run CLI directly from TS (tsx)
npm run build             # bundle to dist/
npm test                  # vitest
npm run lint              # biome
```

## License

MIT
