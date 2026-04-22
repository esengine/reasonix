/**
 * MCP client + bridge tests.
 *
 * Strategy: fake the McpTransport with an in-process pair. The fake
 * server understands initialize / tools/list / tools/call and returns
 * canned responses, letting us verify the client side without spawning
 * a real process.
 */

import { describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { bridgeMcpTools, flattenMcpResult } from "../src/mcp/registry.js";
import type { McpTransport } from "../src/mcp/stdio.js";
import {
  type CallToolResult,
  type JsonRpcMessage,
  type JsonRpcRequest,
  MCP_PROTOCOL_VERSION,
  type McpTool,
} from "../src/mcp/types.js";

// ---------- fake transport ----------

interface FakeServerOptions {
  tools: McpTool[];
  /** Server's response per (name, args). Called for tools/call. */
  callHandler?: (name: string, args: Record<string, unknown>) => CallToolResult;
  /** Return an error from tools/call instead of a result. */
  errorFor?: Set<string>;
  /** Track every call the server received. */
  received?: JsonRpcRequest[];
}

/**
 * In-process MCP server. Responds directly in `send()` by pushing a
 * response onto the messages queue. Synchronous-enough to make tests
 * deterministic.
 */
class FakeMcpTransport implements McpTransport {
  private readonly queue: JsonRpcMessage[] = [];
  private readonly waiters: Array<(m: JsonRpcMessage | null) => void> = [];
  private closed = false;
  constructor(private readonly opts: FakeServerOptions) {
    opts.received = opts.received ?? [];
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("fake transport closed");
    if (!("method" in msg)) return; // response frames from client? never happens
    if (!("id" in msg)) {
      // notification — e.g. notifications/initialized — acknowledge silently
      this.opts.received!.push(msg as JsonRpcRequest);
      return;
    }
    const req = msg as JsonRpcRequest;
    this.opts.received!.push(req);
    const response = this.handle(req);
    this.push(response);
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

  private handle(req: JsonRpcRequest): JsonRpcMessage {
    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            serverInfo: { name: "fake-mcp", version: "0.0.0" },
            capabilities: { tools: { listChanged: false } },
          },
        };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: { tools: this.opts.tools },
        };
      case "tools/call": {
        const params = req.params as { name: string; arguments?: Record<string, unknown> };
        if (this.opts.errorFor?.has(params.name)) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32001, message: `server-side error for ${params.name}` },
          };
        }
        const result = this.opts.callHandler
          ? this.opts.callHandler(params.name, params.arguments ?? {})
          : { content: [{ type: "text" as const, text: `called ${params.name}` }] };
        return { jsonrpc: "2.0", id: req.id, result };
      }
      default:
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `method not found: ${req.method}` },
        };
    }
  }

  private push(msg: JsonRpcMessage): void {
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.queue.push(msg);
  }
}

// ---------- tests ----------

describe("McpClient: initialize handshake", () => {
  it("completes initialize and sends notifications/initialized", async () => {
    const received: JsonRpcRequest[] = [];
    const transport = new FakeMcpTransport({ tools: [], received });
    const client = new McpClient({ transport });
    const info = await client.initialize();
    expect(info.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(info.serverInfo.name).toBe("fake-mcp");

    // Client should have sent two messages: initialize + notifications/initialized
    expect(received).toHaveLength(2);
    expect(received[0]!.method).toBe("initialize");
    expect(received[1]!.method).toBe("notifications/initialized");

    await client.close();
  });

  it("refuses listTools before initialize", async () => {
    const client = new McpClient({ transport: new FakeMcpTransport({ tools: [] }) });
    await expect(client.listTools()).rejects.toThrow(/not initialized/);
    await client.close();
  });

  it("refuses a second initialize call", async () => {
    const client = new McpClient({ transport: new FakeMcpTransport({ tools: [] }) });
    await client.initialize();
    await expect(client.initialize()).rejects.toThrow(/already initialized/);
    await client.close();
  });
});

describe("McpClient: tools/list + tools/call", () => {
  const SAMPLE_TOOLS: McpTool[] = [
    {
      name: "echo",
      description: "echoes its input",
      inputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
    },
    {
      name: "add",
      description: "a+b",
      inputSchema: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
    },
  ];

  it("lists tools and invokes them", async () => {
    const transport = new FakeMcpTransport({
      tools: SAMPLE_TOOLS,
      callHandler: (name, args) => {
        if (name === "echo") {
          return { content: [{ type: "text", text: String(args.msg ?? "") }] };
        }
        if (name === "add") {
          const sum = Number(args.a) + Number(args.b);
          return { content: [{ type: "text", text: String(sum) }] };
        }
        return { content: [{ type: "text", text: "?" }] };
      },
    });
    const client = new McpClient({ transport });
    await client.initialize();

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);

    const echoResult = await client.callTool("echo", { msg: "hi" });
    expect(echoResult.content[0]).toEqual({ type: "text", text: "hi" });

    const addResult = await client.callTool("add", { a: 17, b: 25 });
    expect(addResult.content[0]).toEqual({ type: "text", text: "42" });

    await client.close();
  });

  it("surfaces server errors as rejected promises", async () => {
    const transport = new FakeMcpTransport({
      tools: SAMPLE_TOOLS,
      errorFor: new Set(["echo"]),
    });
    const client = new McpClient({ transport });
    await client.initialize();
    await expect(client.callTool("echo", { msg: "x" })).rejects.toThrow(/MCP -32001/);
    await client.close();
  });
});

describe("bridgeMcpTools (MCP → ToolRegistry)", () => {
  it("registers every MCP tool into a ToolRegistry and dispatch calls through the client", async () => {
    const transport = new FakeMcpTransport({
      tools: [
        {
          name: "echo",
          description: "echoes",
          inputSchema: {
            type: "object",
            properties: { msg: { type: "string" } },
            required: ["msg"],
          },
        },
      ],
      callHandler: (_name, args) => ({
        content: [{ type: "text", text: `you said: ${args.msg}` }],
      }),
    });
    const client = new McpClient({ transport });
    await client.initialize();

    const { registry, registeredNames } = await bridgeMcpTools(client);
    expect(registeredNames).toEqual(["echo"]);
    expect(registry.has("echo")).toBe(true);

    // Dispatching through the registry should go through the MCP transport
    const result = await registry.dispatch("echo", JSON.stringify({ msg: "hello" }));
    expect(result).toContain("you said: hello");

    await client.close();
  });

  it("applies a name prefix when collisions could happen", async () => {
    const transport = new FakeMcpTransport({
      tools: [
        {
          name: "search",
          description: "fs search",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const client = new McpClient({ transport });
    await client.initialize();

    const { registeredNames, registry } = await bridgeMcpTools(client, { namePrefix: "fs_" });
    expect(registeredNames).toEqual(["fs_search"]);
    expect(registry.has("fs_search")).toBe(true);
    expect(registry.has("search")).toBe(false);

    await client.close();
  });
});

describe("flattenMcpResult", () => {
  it("joins text blocks with newlines", () => {
    const out = flattenMcpResult({
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    });
    expect(out).toBe("line one\nline two");
  });

  it("prefixes error results", () => {
    const out = flattenMcpResult({
      content: [{ type: "text", text: "bad input" }],
      isError: true,
    });
    expect(out).toMatch(/^ERROR: /);
    expect(out).toContain("bad input");
  });

  it("renders image blocks as placeholders", () => {
    const out = flattenMcpResult({
      content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
    });
    expect(out).toContain("[image image/png");
  });
});
