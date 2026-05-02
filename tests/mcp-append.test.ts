import { describe, expect, it, vi } from "vitest";
import { applyMcpAppend } from "../src/cli/ui/mcp-append.js";
import type { McpServerSummary } from "../src/cli/ui/slash/types.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../src/index.js";
import { McpClient } from "../src/mcp/client.js";
import type { BridgeEnv, McpClientHost } from "../src/mcp/registry.js";
import { StdioTransport } from "../src/mcp/stdio.js";
import type { McpTool } from "../src/mcp/types.js";
import { ToolRegistry } from "../src/tools.js";

function makeLoop() {
  const tools = new ToolRegistry();
  const prefix = new ImmutablePrefix({ system: "s" });
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  return { loop: new CacheFirstLoop({ client, prefix, tools }), tools, prefix };
}

function makeFakeMcp(): { host: McpClientHost; env: BridgeEnv; registry: ToolRegistry } {
  // The host's client is a real McpClient pointing at a never-spawned transport;
  // applyMcpAppend doesn't actually call the tool, so this is fine.
  const transport = new StdioTransport({ command: "true", args: [], shell: false });
  const host: McpClientHost = { client: new McpClient({ transport, requestTimeoutMs: 1_000 }) };
  const registry = new ToolRegistry();
  const env: BridgeEnv = {
    registry,
    host,
    prefix: "fs_",
    maxResultChars: 32_000,
    tracker: null,
  };
  return { host, env, registry };
}

function summary(env: BridgeEnv, host: McpClientHost): McpServerSummary {
  return {
    label: "fs",
    spec: "fs=cmd",
    toolCount: 0,
    host,
    bridgeEnv: env,
    report: {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "fs", version: "1.0" },
      capabilities: {},
      tools: { supported: true, items: [] },
      resources: { supported: false, reason: "" },
      prompts: { supported: false, reason: "" },
      elapsedMs: 50,
    },
  };
}

const newTool: McpTool = {
  name: "delete_file",
  description: "Remove a file at the given path.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

describe("applyMcpAppend", () => {
  it("registers the new tool in the registry under the prefix", async () => {
    const { loop, prefix } = makeLoop();
    const { env, host, registry } = makeFakeMcp();
    // Re-bind the bridgeEnv's registry to the loop's so the mutation lands there.
    env.registry = loop.tools;
    const target = summary(env, host);

    expect(loop.tools.has("fs_delete_file")).toBe(false);
    applyMcpAppend(loop, target, [newTool]);
    expect(loop.tools.has("fs_delete_file")).toBe(true);
    // Sanity: the unused `registry` shows we're not mutating the wrong place.
    expect(registry.has("fs_delete_file")).toBe(false);
    // Prefix gained the spec, with the prefixed name.
    const names = prefix.toolSpecs.map((t) => t.function.name);
    expect(names).toContain("fs_delete_file");
  });

  it("invalidates the prefix fingerprint (cache key changes for next turn)", () => {
    const { loop, prefix } = makeLoop();
    const { env, host } = makeFakeMcp();
    env.registry = loop.tools;
    const target = summary(env, host);

    const before = prefix.fingerprint;
    applyMcpAppend(loop, target, [newTool]);
    expect(prefix.fingerprint).not.toBe(before);
  });

  it("updates the summary's tool count + report.tools.items", () => {
    const { loop } = makeLoop();
    const { env, host } = makeFakeMcp();
    env.registry = loop.tools;
    const target = summary(env, host);

    applyMcpAppend(loop, target, [newTool]);
    expect(target.toolCount).toBe(1);
    if (!target.report.tools.supported) throw new Error("unreachable");
    expect(target.report.tools.items.map((t) => t.name)).toContain("delete_file");
  });

  it("skips MCP tools without a name (defensive)", () => {
    const { loop } = makeLoop();
    const { env, host } = makeFakeMcp();
    env.registry = loop.tools;
    const target = summary(env, host);

    applyMcpAppend(loop, target, [{ name: "", inputSchema: { type: "object" } } as McpTool]);
    expect(loop.tools.size).toBe(0);
    expect(target.toolCount).toBe(0);
  });
});
