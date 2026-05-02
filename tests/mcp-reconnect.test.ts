import { describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { reconnectMcpServer } from "../src/mcp/reconnect.js";
import type { McpClientHost } from "../src/mcp/registry.js";
import { StdioTransport } from "../src/mcp/stdio.js";

/** A throwaway client we can hand to the host without bothering to initialize — reconnect won't touch it on the parse-failure path. */
function dummyHost(): McpClientHost {
  const transport = new StdioTransport({ command: "true", args: [], shell: false });
  return { client: new McpClient({ transport, requestTimeoutMs: 1_000 }) };
}

describe("reconnectMcpServer — early-return paths", () => {
  it("returns spec_parse when the spec string is empty", async () => {
    const host = dummyHost();
    const r = await reconnectMcpServer({ host, spec: "", beforeTools: [] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("spec_parse");
    expect(r.message).toMatch(/empty MCP spec/);
    await host.client.close();
  });

  it("returns spec_parse when the spec has a name but no command", async () => {
    const host = dummyHost();
    const r = await reconnectMcpServer({ host, spec: "fs=", beforeTools: [] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("spec_parse");
    expect(r.message).toMatch(/has name but no command/);
    await host.client.close();
  });

  // Handshake-failure path is platform-sensitive (Windows shell:true doesn't
  // surface ENOENT synchronously). Exercised in mcp-integration.test.ts via
  // the live demo server instead.
});
