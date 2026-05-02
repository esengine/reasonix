/** MCP integration — spawns the demo MCP server, bridges tools, invokes them end-to-end. */

import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { bridgeMcpTools } from "../src/mcp/registry.js";
import { StdioTransport } from "../src/mcp/stdio.js";
import { ToolRegistry } from "../src/tools.js";

// Spawning `tsx` directly needs a cross-platform approach. `node --import tsx`
// works everywhere Node 22+ is installed (which is our engines target) and
// avoids the Windows `.cmd` resolution gotcha in child_process.spawn.
const NODE_CMD = process.execPath;
const DEMO_SERVER_ARGS = ["--import", "tsx", "examples/mcp-server-demo.ts"];

describe("MCP integration — real subprocess against bundled demo server", () => {
  let client: McpClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
  });

  it("initializes, lists tools, and calls echo/add end-to-end", async () => {
    const transport = new StdioTransport({
      command: NODE_CMD,
      args: DEMO_SERVER_ARGS,
      // We're spawning node.exe directly — bypass the shell-true default
      // that exists for .cmd wrappers (npx etc.). Saves a cmd.exe hop
      // and the quoting concerns that come with it.
      shell: false,
    });
    client = new McpClient({ transport, requestTimeoutMs: 15_000 });
    const info = await client.initialize();
    expect(info.serverInfo.name).toBe("reasonix-demo-mcp");
    expect(info.capabilities.tools).toBeDefined();

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add", "echo", "get_time", "slow_count"]);

    const echoResult = await client.callTool("echo", { msg: "hello" });
    const echoText = echoResult.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(echoText).toContain("hello");

    const addResult = await client.callTool("add", { a: 17, b: 25 });
    const addText = addResult.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(addText).toContain("42");
  }, 30_000);

  it("bridges real MCP tools into a Reasonix ToolRegistry", async () => {
    const transport = new StdioTransport({
      command: NODE_CMD,
      args: DEMO_SERVER_ARGS,
      shell: false,
    });
    client = new McpClient({ transport, requestTimeoutMs: 15_000 });
    await client.initialize();

    const { registry, registeredNames } = await bridgeMcpTools(client, { namePrefix: "demo_" });
    expect(registeredNames.sort()).toEqual([
      "demo_add",
      "demo_echo",
      "demo_get_time",
      "demo_slow_count",
    ]);

    // Dispatch through the registry — should round-trip through MCP
    const out = await registry.dispatch("demo_add", JSON.stringify({ a: 100, b: 1 }));
    expect(out).toContain("101");
  }, 30_000);

  it("bridges two MCP servers into a shared registry with different prefixes", async () => {
    // Two instances of the same demo server, namespaced `a_` and `b_`.
    // Proves the multi-server CLI wiring: both dispatches go through
    // their respective subprocesses without cross-talk.
    const tA = new StdioTransport({ command: NODE_CMD, args: DEMO_SERVER_ARGS, shell: false });
    const a = new McpClient({ transport: tA, requestTimeoutMs: 15_000 });
    const tB = new StdioTransport({ command: NODE_CMD, args: DEMO_SERVER_ARGS, shell: false });
    const b = new McpClient({ transport: tB, requestTimeoutMs: 15_000 });
    try {
      await a.initialize();
      await b.initialize();
      const shared = new ToolRegistry();
      const resA = await bridgeMcpTools(a, { registry: shared, namePrefix: "a_" });
      const resB = await bridgeMcpTools(b, { registry: shared, namePrefix: "b_" });
      expect(resA.registeredNames).toHaveLength(4);
      expect(resB.registeredNames).toHaveLength(4);
      expect(shared.size).toBe(8);

      const outA = await shared.dispatch("a_add", JSON.stringify({ a: 10, b: 20 }));
      expect(outA).toContain("30");
      const outB = await shared.dispatch("b_add", JSON.stringify({ a: 1, b: 2 }));
      expect(outB).toContain("3");
    } finally {
      await a.close();
      await b.close();
    }
  }, 30_000);
});
