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
  type GetPromptResult,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type ListPromptsResult,
  type ListResourcesResult,
  MCP_PROTOCOL_VERSION,
  type McpTool,
  type ReadResourceResult,
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
  /** resources/list response. Optional — omit to return empty. */
  listResources?: () => ListResourcesResult;
  /** resources/read response keyed by URI. Throw-returns method-not-found for unknowns. */
  readResource?: (uri: string) => ReadResourceResult;
  /** prompts/list response. */
  listPrompts?: () => ListPromptsResult;
  /** prompts/get response keyed by name. */
  getPrompt?: (name: string, args?: Record<string, string>) => GetPromptResult;
  /** Initialize capabilities override — defaults advertise tools only. */
  capabilities?: Record<string, unknown>;
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
            capabilities: this.opts.capabilities ?? { tools: { listChanged: false } },
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
      case "resources/list":
        if (!this.opts.listResources) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: "method not found: resources/list" },
          };
        }
        return { jsonrpc: "2.0", id: req.id, result: this.opts.listResources() };
      case "resources/read": {
        if (!this.opts.readResource) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: "method not found: resources/read" },
          };
        }
        const { uri } = req.params as { uri: string };
        return { jsonrpc: "2.0", id: req.id, result: this.opts.readResource(uri) };
      }
      case "prompts/list":
        if (!this.opts.listPrompts) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: "method not found: prompts/list" },
          };
        }
        return { jsonrpc: "2.0", id: req.id, result: this.opts.listPrompts() };
      case "prompts/get": {
        if (!this.opts.getPrompt) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: "method not found: prompts/get" },
          };
        }
        const { name, arguments: a } = req.params as {
          name: string;
          arguments?: Record<string, string>;
        };
        return { jsonrpc: "2.0", id: req.id, result: this.opts.getPrompt(name, a) };
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

  it("truncates oversized results when maxChars is given, keeping head + tail", () => {
    const big = `${"X".repeat(50_000)}END_MARKER`;
    const out = flattenMcpResult({ content: [{ type: "text", text: big }] }, { maxChars: 10_000 });
    expect(out.length).toBeLessThan(11_000); // cap + a small envelope
    expect(out).toContain("truncated");
    // tail preservation: the distinctive END_MARKER at the original's end must survive
    expect(out).toContain("END_MARKER");
    // head preservation: first chars must survive
    expect(out.startsWith("X")).toBe(true);
  });

  it("does NOT truncate when below the cap", () => {
    const small = "hello world";
    const out = flattenMcpResult({ content: [{ type: "text", text: small }] }, { maxChars: 1000 });
    expect(out).toBe("hello world");
  });
});

describe("bridgeMcpTools: result-size cap", () => {
  it("caps a giant MCP tool result before handing it to the registry", async () => {
    // Minimal local fake — just enough to exercise the dispatch path.
    const transport: McpTransport = {
      async send() {},
      async *messages() {},
      async close() {},
    };
    const big = "A".repeat(200_000);
    const client = {
      listTools: async () => ({
        tools: [
          {
            name: "dump",
            description: "returns a massive string",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool: async () => ({ content: [{ type: "text" as const, text: big }] }),
    } as unknown as McpClient;
    // Default cap (32k): enough to confirm the feature bites.
    const { registry } = await bridgeMcpTools(client, { namePrefix: "x_" });
    const out = await registry.dispatch("x_dump", "{}");
    expect(out.length).toBeLessThan(33_000);
    expect(out).toContain("truncated");
    // Sanity-silence TS about the unused transport binding.
    void transport;
  });
});

describe("McpClient: progress notifications", () => {
  /**
   * Build a transport where tools/call takes multiple "ticks" before
   * responding — each tick emits a notifications/progress frame tied
   * to the token the client sent in `_meta.progressToken`.
   */
  function makeProgressTransport(
    progressFrames: Array<{ progress: number; total?: number; message?: string }>,
  ): { transport: McpTransport; received: JsonRpcRequest[] } {
    const received: JsonRpcRequest[] = [];
    const queue: JsonRpcMessage[] = [];
    const waiters: Array<(m: JsonRpcMessage | null) => void> = [];
    let closed = false;
    const push = (m: JsonRpcMessage) => {
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    };
    const transport: McpTransport = {
      async send(msg) {
        if (closed) throw new Error("closed");
        if (!("id" in msg) || !("method" in msg)) return;
        const req = msg as JsonRpcRequest;
        received.push(req);
        if (req.method === "initialize") {
          push({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              serverInfo: { name: "fake", version: "0" },
              capabilities: { tools: {} },
            },
          });
          return;
        }
        if (req.method === "tools/call") {
          const token = (req.params as { _meta?: { progressToken?: string | number } })._meta
            ?.progressToken;
          // Emit progress frames first (all with the same token), then
          // the final response.
          for (const frame of progressFrames) {
            push({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken: token, ...frame },
            });
          }
          push({
            jsonrpc: "2.0",
            id: req.id,
            result: { content: [{ type: "text" as const, text: "done" }] },
          });
          return;
        }
        push({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: "method not found" },
        });
      },
      async *messages() {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (closed) return;
          const next = await new Promise<JsonRpcMessage | null>((resolve) => {
            waiters.push(resolve);
          });
          if (next === null) return;
          yield next;
        }
      },
      async close() {
        closed = true;
        while (waiters.length > 0) waiters.shift()!(null);
      },
    };
    return { transport, received };
  }

  it("routes progress notifications to the per-call onProgress callback", async () => {
    const { transport } = makeProgressTransport([
      { progress: 1, total: 3, message: "reading..." },
      { progress: 2, total: 3 },
      { progress: 3, total: 3, message: "done" },
    ]);
    const client = new McpClient({ transport });
    await client.initialize();

    const received: Array<{ progress: number; total?: number; message?: string }> = [];
    const result = await client.callTool("scan", {}, { onProgress: (info) => received.push(info) });
    expect(result.content[0]).toEqual({ type: "text", text: "done" });
    expect(received).toEqual([
      { progress: 1, total: 3, message: "reading..." },
      { progress: 2, total: 3, message: undefined },
      { progress: 3, total: 3, message: "done" },
    ]);
    await client.close();
  });

  it("omits _meta.progressToken when no onProgress callback is provided", async () => {
    const { transport, received } = makeProgressTransport([]);
    const client = new McpClient({ transport });
    await client.initialize();
    await client.callTool("x", { k: 1 });
    const callReq = received.find((r) => r.method === "tools/call")!;
    expect((callReq.params as { _meta?: unknown })._meta).toBeUndefined();
    await client.close();
  });

  it("sets a distinct _meta.progressToken when onProgress IS provided", async () => {
    const { transport, received } = makeProgressTransport([]);
    const client = new McpClient({ transport });
    await client.initialize();
    await client.callTool("x", {}, { onProgress: () => {} });
    const callReq = received.find((r) => r.method === "tools/call")!;
    const token = (callReq.params as { _meta?: { progressToken?: number } })._meta?.progressToken;
    expect(token).toBeTypeOf("number");
  });

  it("late progress frames after the call resolved are dropped silently", async () => {
    // Use the handler-transport shape from progress-transport: we
    // send the final result, THEN push a trailing progress frame.
    // The client must not throw when the handler map is already empty.
    const received: JsonRpcRequest[] = [];
    const queue: JsonRpcMessage[] = [];
    const waiters: Array<(m: JsonRpcMessage | null) => void> = [];
    let closed = false;
    const push = (m: JsonRpcMessage) => {
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    };
    let lastToken: string | number | undefined;
    const transport: McpTransport = {
      async send(msg) {
        if (!("id" in msg) || !("method" in msg)) return;
        const req = msg as JsonRpcRequest;
        received.push(req);
        if (req.method === "initialize") {
          push({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              serverInfo: { name: "fake", version: "0" },
              capabilities: {},
            },
          });
        } else if (req.method === "tools/call") {
          lastToken = (req.params as { _meta?: { progressToken?: string | number } })._meta
            ?.progressToken;
          // Final response first, then a trailing progress — mimics
          // a race where the server finished but a progress frame
          // was already in flight.
          push({
            jsonrpc: "2.0",
            id: req.id,
            result: { content: [] },
          });
          push({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: lastToken, progress: 42 },
          });
        }
      },
      async *messages() {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (closed) return;
          const next = await new Promise<JsonRpcMessage | null>((resolve) => {
            waiters.push(resolve);
          });
          if (next === null) return;
          yield next;
        }
      },
      async close() {
        closed = true;
        while (waiters.length > 0) waiters.shift()!(null);
      },
    };
    const client = new McpClient({ transport });
    await client.initialize();
    const seen: number[] = [];
    await client.callTool("x", {}, { onProgress: (i) => seen.push(i.progress) });
    // Give the reader loop a tick to process the trailing
    // notification — should be swallowed, not thrown.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([]); // the trailing frame was dropped
    await client.close();
  });
});

describe("bridgeMcpTools: progress pass-through", () => {
  it("threads per-tool progress callbacks with the registered (prefixed) name", async () => {
    const { transport } = (function makeProgressTransport(
      frames: Array<{ progress: number; total?: number }>,
    ) {
      const queue: JsonRpcMessage[] = [];
      const waiters: Array<(m: JsonRpcMessage | null) => void> = [];
      let closed = false;
      const push = (m: JsonRpcMessage) => {
        const w = waiters.shift();
        if (w) w(m);
        else queue.push(m);
      };
      const t: McpTransport = {
        async send(msg) {
          if (!("id" in msg) || !("method" in msg)) return;
          const req = msg as JsonRpcRequest;
          if (req.method === "initialize") {
            push({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: { name: "fs", version: "0" },
                capabilities: { tools: {} },
              },
            });
          } else if (req.method === "tools/list") {
            push({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                tools: [{ name: "scan", description: "", inputSchema: { type: "object" } }],
              },
            });
          } else if (req.method === "tools/call") {
            const token = (req.params as { _meta?: { progressToken?: string | number } })._meta
              ?.progressToken;
            for (const f of frames) {
              push({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: { progressToken: token, ...f },
              });
            }
            push({
              jsonrpc: "2.0",
              id: req.id,
              result: { content: [{ type: "text" as const, text: "ok" }] },
            });
          }
        },
        async *messages() {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift()!;
              continue;
            }
            if (closed) return;
            const next = await new Promise<JsonRpcMessage | null>((resolve) => {
              waiters.push(resolve);
            });
            if (next === null) return;
            yield next;
          }
        },
        async close() {
          closed = true;
          while (waiters.length > 0) waiters.shift()!(null);
        },
      };
      return { transport: t };
    })([{ progress: 5, total: 10 }]);

    const client = new McpClient({ transport });
    await client.initialize();
    const observed: Array<{ toolName: string; progress: number; total?: number }> = [];
    const { registry } = await bridgeMcpTools(client, {
      namePrefix: "fs_",
      onProgress: ({ toolName, progress, total }) => observed.push({ toolName, progress, total }),
    });
    await registry.dispatch("fs_scan", "{}");
    expect(observed).toEqual([{ toolName: "fs_scan", progress: 5, total: 10 }]);
    await client.close();
  });
});

describe("McpClient: resources", () => {
  it("lists resources and reads one by URI", async () => {
    const transport = new FakeMcpTransport({
      tools: [],
      capabilities: { tools: {}, resources: { listChanged: false } },
      listResources: () => ({
        resources: [
          { uri: "file:///a.md", name: "a", mimeType: "text/markdown" },
          { uri: "custom://b", name: "b" },
        ],
      }),
      readResource: (uri) => ({
        contents: [{ uri, mimeType: "text/plain", text: `body of ${uri}` }],
      }),
    });
    const client = new McpClient({ transport });
    await client.initialize();

    const list = await client.listResources();
    expect(list.resources).toHaveLength(2);
    expect(list.resources[0]!.uri).toBe("file:///a.md");

    const read = await client.readResource("file:///a.md");
    expect(read.contents).toHaveLength(1);
    const block = read.contents[0]!;
    expect("text" in block ? block.text : "").toBe("body of file:///a.md");
    expect(block.mimeType).toBe("text/plain");

    await client.close();
  });

  it("surfaces method-not-found as an error when the server lacks resources support", async () => {
    // Default FakeMcpTransport (no listResources handler) → −32601.
    const transport = new FakeMcpTransport({ tools: [] });
    const client = new McpClient({ transport });
    await client.initialize();
    await expect(client.listResources()).rejects.toThrow(/-32601/);
    await client.close();
  });

  it("advertises resources + prompts in the initialize capabilities payload", async () => {
    const received: JsonRpcRequest[] = [];
    const transport = new FakeMcpTransport({ tools: [], received });
    const client = new McpClient({ transport });
    await client.initialize();
    const init = received.find((r) => r.method === "initialize")!;
    const params = init.params as { capabilities: Record<string, unknown> };
    // The client now claims to support all three method families.
    expect(params.capabilities).toHaveProperty("tools");
    expect(params.capabilities).toHaveProperty("resources");
    expect(params.capabilities).toHaveProperty("prompts");
    await client.close();
  });

  it("propagates the pagination cursor to resources/list", async () => {
    const received: JsonRpcRequest[] = [];
    const transport = new FakeMcpTransport({
      tools: [],
      received,
      listResources: () => ({ resources: [], nextCursor: undefined }),
    });
    const client = new McpClient({ transport });
    await client.initialize();
    await client.listResources("page2");
    const listReq = received.find((r) => r.method === "resources/list")!;
    expect((listReq.params as { cursor?: string }).cursor).toBe("page2");
    await client.close();
  });
});

describe("McpClient: prompts", () => {
  it("lists prompts and fetches a rendered one with arguments", async () => {
    const transport = new FakeMcpTransport({
      tools: [],
      capabilities: { tools: {}, prompts: { listChanged: false } },
      listPrompts: () => ({
        prompts: [
          {
            name: "summarize",
            description: "summarize a document",
            arguments: [{ name: "lang", required: true }],
          },
        ],
      }),
      getPrompt: (name, args) => ({
        description: `rendered ${name}`,
        messages: [
          {
            role: "user",
            content: { type: "text", text: `please summarize in ${args?.lang ?? "?"}` },
          },
        ],
      }),
    });
    const client = new McpClient({ transport });
    await client.initialize();

    const list = await client.listPrompts();
    expect(list.prompts).toHaveLength(1);
    expect(list.prompts[0]!.name).toBe("summarize");
    expect(list.prompts[0]!.arguments?.[0]?.required).toBe(true);

    const got = await client.getPrompt("summarize", { lang: "zh" });
    expect(got.messages).toHaveLength(1);
    const msg = got.messages[0]!;
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");
    if (msg.content.type === "text") {
      expect(msg.content.text).toContain("zh");
    }

    await client.close();
  });

  it("omits the arguments field when caller passes no args", async () => {
    const received: JsonRpcRequest[] = [];
    const transport = new FakeMcpTransport({
      tools: [],
      received,
      getPrompt: () => ({ messages: [] }),
    });
    const client = new McpClient({ transport });
    await client.initialize();
    await client.getPrompt("hello");
    const getReq = received.find((r) => r.method === "prompts/get")!;
    expect(getReq.params).toEqual({ name: "hello" });
    await client.close();
  });
});
