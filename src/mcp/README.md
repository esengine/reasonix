# MCP client (v0.3 foundation)

Minimal [Model Context Protocol](https://spec.modelcontextprotocol.io/)
client, hand-rolled in TypeScript. Lets Reasonix consume tools from any
MCP server (filesystem, github, slack, puppeteer, …) while applying the
Cache-First Loop and tool-call repair to the whole thing automatically.

## Design choice: roll-our-own, not @modelcontextprotocol/sdk

Same reasoning that drove `client.ts` (DeepSeek) rather than `openai`:

- **Zero runtime deps** for this module. Consistent with Reasonix's
  policy of owning the wire format where it matters.
- **Surface tuning**: we only implement what Reasonix actually uses —
  initialize + tools/list + tools/call. Resources, prompts, sampling,
  and progress notifications are deferred.
- **Insulation** from SDK breaking changes. The spec is more stable
  than any single SDK release.

Swappable if needed: `McpClient` depends on the `McpTransport` interface,
so the day we do want the official SDK's transport layer we can adapt
it and keep everything else.

## What's shipped here

```
src/mcp/
├── types.ts      JSON-RPC 2.0 + MCP-specific message types
├── stdio.ts      McpTransport interface + StdioTransport (spawn child)
├── sse.ts        SseTransport (HTTP+SSE for remote/hosted servers)
├── spec.ts       parseMcpSpec — parses --mcp CLI arg into transport-tagged spec
├── catalog.ts    curated list of popular official MCP servers
├── client.ts     McpClient: initialize / listTools / callTool
├── registry.ts   bridgeMcpTools: MCP → ToolRegistry
└── README.md     (this file)

tests/mcp.test.ts — in-process fake transport, no child processes
tests/mcp-sse.test.ts — in-process http.Server fake for SSE
```

## What's NOT here (yet)

| feature | status | note |
|---|---|---|
| CLI wiring (`reasonix chat --mcp <cmd>`) | ✅ shipped | see Usage below |
| Bundled demo server | ✅ shipped | `examples/mcp-server-demo.ts`, exposes echo/add/get_time |
| Real-subprocess integration test | ✅ shipped | `tests/mcp-integration.test.ts` |
| Resources / `resources/list` / `resources/read` | deferred | Reasonix doesn't surface resources today |
| Prompts / `prompts/list` | deferred | ditto |
| Progress notifications | deferred | long-running tool support comes with the CLI work |
| Streaming results | deferred | current shape returns one CallToolResult per call |
| SSE transport | ✅ shipped | `src/mcp/sse.ts` — pass `http(s)://…` to `--mcp` |
| Streamable HTTP (2025-03-26 spec) | deferred | waiting for a real server to validate against |
| MCP server that Reasonix exposes | never | out of scope — Reasonix is a client |

## Usage (CLI)

`--mcp` is repeatable — attach one or many MCP servers; their tools become
first-class citizens of the loop.

```bash
# Single server, anonymous (tools use native names):
reasonix chat --mcp "node --import tsx examples/mcp-server-demo.ts"

# Official filesystem server:
reasonix chat --mcp "npx -y @modelcontextprotocol/server-filesystem /tmp/safe-dir"

# Multiple servers, each namespaced. Syntax: "name=command args..."
# Tools land in a shared registry as fs_read_file, demo_add, etc.
reasonix chat \
  --mcp "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe" \
  --mcp "demo=node --import tsx examples/mcp-server-demo.ts"

# Global prefix (only honored when there's ONE anonymous server):
reasonix chat \
  --mcp "npx -y @modelcontextprotocol/server-filesystem /tmp" \
  --mcp-prefix fs_

# Same flag works with one-shot run:
reasonix run "list files in /tmp/safe-dir" \
  --mcp "npx -y @modelcontextprotocol/server-filesystem /tmp/safe-dir"
```

Each spec is shell-split (spaces separate args; use quotes for paths with
spaces). Windows-friendly: backslashes pass through literally outside
quotes, so `C:\path\to\dir` works. Tools get folded into the
`ImmutablePrefix` for the model, and every call goes through Reasonix's
Cache-First loop + tool-call repair (scavenge / flatten / storm)
automatically.

## Usage (library)

```ts
import {
  McpClient,
  StdioTransport,
  bridgeMcpTools,
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
} from "reasonix";

// 1. Spawn + connect to an MCP server
const transport = new StdioTransport({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/safe-dir"],
});
const mcp = new McpClient({ transport });
await mcp.initialize();

// 2. Bridge its tools into a Reasonix ToolRegistry
const { registry } = await bridgeMcpTools(mcp, { namePrefix: "fs_" });

// 3. Use them with the Cache-First Loop — same as any native tool
const client = new DeepSeekClient();
const loop = new CacheFirstLoop({
  client,
  prefix: new ImmutablePrefix({
    system: "You can use the filesystem tools to help the user.",
    toolSpecs: registry.specs(),
  }),
  tools: registry,
});

for await (const ev of loop.step("List the files in /tmp/safe-dir.")) {
  if (ev.role === "assistant_final") console.log(ev.content);
}

// 4. Clean up
await mcp.close();
```

The payoff: the filesystem server's tools now inherit Reasonix's
cache-first prefix stability + repair (schema flatten, tool-call
scavenge, call-storm break) without the MCP server knowing anything
about it.

## Wire protocol notes (stdio)

- **Framing**: newline-delimited JSON. One JSON-RPC message per line,
  UTF-8, no Content-Length header (that's LSP, not MCP stdio).
- **Stderr**: forwarded to the parent's stderr. Servers often print
  startup banners there; that's fine.
- **Shutdown**: `close()` calls `child.stdin.end()` then SIGTERM if the
  process hasn't exited.
- **Malformed lines**: dropped silently. Some servers emit non-JSON
  during startup; logging every dropped line would be noise.
