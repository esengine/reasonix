/** inspectMcpServer — runs against the fake transport. */

import { describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { inspectMcpServer } from "../src/mcp/inspect.js";
import type { McpTransport } from "../src/mcp/stdio.js";
import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  MCP_PROTOCOL_VERSION,
} from "../src/mcp/types.js";

// A minimal in-process transport that answers methods from a handler
// map. Simpler than the FakeMcpTransport in mcp.test.ts — we only
// care about shape-of-response here, not call ordering.
class HandlerTransport implements McpTransport {
  private readonly queue: JsonRpcMessage[] = [];
  private readonly waiters: Array<(m: JsonRpcMessage | null) => void> = [];
  private closed = false;
  constructor(private readonly handlers: Record<string, (req: JsonRpcRequest) => JsonRpcMessage>) {}

  async send(msg: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("closed");
    if (!("id" in msg) || !("method" in msg)) return; // notification from client
    const req = msg as JsonRpcRequest;
    const handler = this.handlers[req.method];
    const response = handler
      ? handler(req)
      : {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `method not found: ${req.method}` },
        };
    const w = this.waiters.shift();
    if (w) w(response as JsonRpcMessage);
    else this.queue.push(response as JsonRpcMessage);
  }

  async *messages(): AsyncIterableIterator<JsonRpcMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<JsonRpcMessage | null>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next === null) return;
      yield next;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }
}

function initOk(req: JsonRpcRequest): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: "test-server", version: "1.2.3" },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: "Use tool X before Y.",
    },
  };
}

describe("inspectMcpServer", () => {
  it("reports server info, capabilities, tools, resources, prompts — full-support server", async () => {
    const transport = new HandlerTransport({
      initialize: initOk,
      "tools/list": (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [
            { name: "echo", description: "echoes", inputSchema: { type: "object" } },
            { name: "add", description: "a+b", inputSchema: { type: "object" } },
          ],
        },
      }),
      "resources/list": (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          resources: [
            { uri: "file:///a.md", name: "a", mimeType: "text/markdown" },
            { uri: "custom://b", name: "b" },
          ],
        },
      }),
      "prompts/list": (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          prompts: [
            {
              name: "summarize",
              description: "summarize a doc",
              arguments: [{ name: "lang", required: true }],
            },
          ],
        },
      }),
    });
    const client = new McpClient({ transport });
    await client.initialize();
    const report = await inspectMcpServer(client);

    expect(report.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(report.serverInfo).toEqual({ name: "test-server", version: "1.2.3" });
    expect(report.instructions).toBe("Use tool X before Y.");
    expect(report.tools).toEqual({
      supported: true,
      items: expect.arrayContaining([expect.objectContaining({ name: "echo" })]),
    });
    expect(report.resources.supported).toBe(true);
    if (report.resources.supported) {
      expect(report.resources.items.map((r) => r.name)).toEqual(["a", "b"]);
    }
    expect(report.prompts.supported).toBe(true);
    if (report.prompts.supported) {
      expect(report.prompts.items[0]!.arguments?.[0]?.name).toBe("lang");
    }

    await client.close();
  });

  it("marks resources+prompts as not supported when server returns -32601", async () => {
    // Tools-only server: init returns, tools/list works, resources/list
    // + prompts/list fall through to the default -32601 in HandlerTransport.
    const transport = new HandlerTransport({
      initialize: initOk,
      "tools/list": (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: [] },
      }),
    });
    const client = new McpClient({ transport });
    await client.initialize();
    const report = await inspectMcpServer(client);

    expect(report.tools.supported).toBe(true);
    expect(report.resources.supported).toBe(false);
    expect(report.prompts.supported).toBe(false);
    if (!report.resources.supported) {
      expect(report.resources.reason).toMatch(/-32601/);
    }
    if (!report.prompts.supported) {
      expect(report.prompts.reason).toMatch(/-32601/);
    }

    await client.close();
  });

  it("forwards non-32601 errors as the section reason so user sees real diagnostics", async () => {
    const transport = new HandlerTransport({
      initialize: initOk,
      "tools/list": (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "server is overloaded" },
      }),
      "resources/list": (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        result: { resources: [] },
      }),
      "prompts/list": (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        result: { prompts: [] },
      }),
    });
    const client = new McpClient({ transport });
    await client.initialize();
    const report = await inspectMcpServer(client);

    expect(report.tools.supported).toBe(false);
    if (!report.tools.supported) {
      expect(report.tools.reason).toMatch(/overloaded/);
    }
    // Resources and prompts are supported and empty — should not be affected.
    expect(report.resources.supported).toBe(true);
    expect(report.prompts.supported).toBe(true);

    await client.close();
  });
});

describe("McpClient: initialize records serverInfo + protocolVersion + instructions", () => {
  it("exposes server info, protocol version, instructions from the handshake", async () => {
    const transport = new HandlerTransport({ initialize: initOk });
    const client = new McpClient({ transport });
    await client.initialize();
    expect(client.serverInfo).toEqual({ name: "test-server", version: "1.2.3" });
    expect(client.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(client.serverInstructions).toBe("Use tool X before Y.");
    await client.close();
  });

  it("leaves serverInstructions undefined when absent from the init result", async () => {
    const transport = new HandlerTransport({
      initialize: (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: "minimal", version: "0" },
          capabilities: { tools: {} },
        },
      }),
    });
    const client = new McpClient({ transport });
    await client.initialize();
    expect(client.serverInstructions).toBeUndefined();
    await client.close();
  });
});
