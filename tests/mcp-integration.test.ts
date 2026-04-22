/**
 * Integration test: real subprocess + real transport + bridge + dispatch.
 *
 * Distinct from tests/mcp.test.ts (which uses an in-process fake
 * transport). This one actually spawns the bundled demo MCP server as
 * a child process, connects via StdioTransport, bridges tools into a
 * ToolRegistry, and invokes them.
 *
 * We don't put this in CI yet — subprocess tests on Windows can be
 * slow or flaky. Run locally with `npm test`. If it ever becomes
 * flaky, swap the afterEach cleanup to force-kill and move on.
 */

import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { bridgeMcpTools } from "../src/mcp/registry.js";
import { StdioTransport } from "../src/mcp/stdio.js";

// Spawning `tsx` directly needs a cross-platform approach. `node --import tsx`
// works everywhere Node 20+ is installed (which is our engines target) and
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
    expect(names).toEqual(["add", "echo", "get_time"]);

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
    expect(registeredNames.sort()).toEqual(["demo_add", "demo_echo", "demo_get_time"]);

    // Dispatch through the registry — should round-trip through MCP
    const out = await registry.dispatch("demo_add", JSON.stringify({ a: 100, b: 1 }));
    expect(out).toContain("101");
  }, 30_000);
});
