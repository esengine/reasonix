/**
 * MCP client — request/response correlation, initialize handshake,
 * tools/list, tools/call. Built on top of a McpTransport so the same
 * logic works against a real stdio server or an in-process fake.
 */

import type { McpTransport } from "./stdio.js";
import {
  type CallToolParams,
  type CallToolResult,
  type GetPromptParams,
  type GetPromptResult,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ListPromptsParams,
  type ListPromptsResult,
  type ListResourcesParams,
  type ListResourcesResult,
  type ListToolsResult,
  MCP_PROTOCOL_VERSION,
  type McpClientInfo,
  type McpProgressHandler,
  type ProgressNotificationParams,
  type ReadResourceParams,
  type ReadResourceResult,
  isJsonRpcError,
} from "./types.js";

export interface McpClientOptions {
  transport: McpTransport;
  clientInfo?: McpClientInfo;
  /** Per-request timeout. Default 60s. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

export class McpClient {
  private readonly transport: McpTransport;
  private readonly clientInfo: McpClientInfo;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private readerStarted = false;
  private initialized = false;
  private _serverCapabilities: InitializeResult["capabilities"] = {};
  private _serverInfo: InitializeResult["serverInfo"] = { name: "", version: "" };
  private _protocolVersion = "";
  private _instructions: string | undefined;
  // Progress-token → handler for notifications/progress routing. Tokens
  // are minted per call when the caller supplies an onProgress
  // callback; cleared when the final response lands (or the pending
  // request rejects). No leaks — the `try/finally` in callTool
  // guarantees cleanup even on timeout.
  private readonly progressHandlers = new Map<string | number, McpProgressHandler>();
  private nextProgressToken = 1;

  constructor(opts: McpClientOptions) {
    this.transport = opts.transport;
    this.clientInfo = opts.clientInfo ?? { name: "reasonix", version: "0.3.0-dev" };
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  }

  /** Server's advertised capabilities, available after initialize(). */
  get serverCapabilities(): InitializeResult["capabilities"] {
    return this._serverCapabilities;
  }

  /** Server's self-reported name + version, available after initialize(). */
  get serverInfo(): InitializeResult["serverInfo"] {
    return this._serverInfo;
  }

  /** Protocol version the server agreed to during the handshake. */
  get protocolVersion(): string {
    return this._protocolVersion;
  }

  /** Optional free-form instructions the server provides at handshake. */
  get serverInstructions(): string | undefined {
    return this._instructions;
  }

  /**
   * Complete the initialize → initialized handshake. Must be called
   * before any other method (otherwise compliant servers reject).
   */
  async initialize(): Promise<InitializeResult> {
    if (this.initialized) throw new Error("MCP client already initialized");
    this.startReaderIfNeeded();
    const result = await this.request<InitializeResult>("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      // Advertise every method the client can consume so servers know
      // they can send listChanged notifications etc. Sub-feature flags
      // (e.g. `resources.subscribe`) are omitted — we don't implement
      // those yet and the empty object means "method-level support, no
      // sub-features."
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: this.clientInfo,
    } satisfies InitializeParams);
    this._serverCapabilities = result.capabilities ?? {};
    this._serverInfo = result.serverInfo ?? { name: "", version: "" };
    this._protocolVersion = result.protocolVersion ?? "";
    this._instructions = result.instructions;
    // Per spec: client sends notifications/initialized after receiving the
    // initialize response. Only then is the connection live for other
    // methods.
    await this.transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    this.initialized = true;
    return result;
  }

  /** List tools the server exposes. */
  async listTools(): Promise<ListToolsResult> {
    this.assertInitialized();
    return this.request<ListToolsResult>("tools/list", {});
  }

  /**
   * Invoke a tool by name. When `onProgress` is supplied, attaches a
   * fresh progress token so the server can send incremental updates
   * via `notifications/progress`; they're routed to the callback until
   * the final response arrives (or the request times out, in which
   * case the handler is simply dropped — no extra notification).
   */
  async callTool(
    name: string,
    args?: Record<string, unknown>,
    opts: { onProgress?: McpProgressHandler } = {},
  ): Promise<CallToolResult> {
    this.assertInitialized();
    const params: CallToolParams = { name, arguments: args ?? {} };
    let token: number | undefined;
    if (opts.onProgress) {
      token = this.nextProgressToken++;
      this.progressHandlers.set(token, opts.onProgress);
      params._meta = { progressToken: token };
    }
    try {
      return await this.request<CallToolResult>("tools/call", params);
    } finally {
      if (token !== undefined) this.progressHandlers.delete(token);
    }
  }

  /**
   * List resources the server exposes. Supports a pagination cursor;
   * callers interested in the full set should loop on `nextCursor`.
   * Servers that don't support resources respond with method-not-found
   * (−32601) — we surface that as a thrown Error so callers can gate
   * on the `serverCapabilities.resources` field first.
   */
  async listResources(cursor?: string): Promise<ListResourcesResult> {
    this.assertInitialized();
    return this.request<ListResourcesResult>("resources/list", {
      ...(cursor ? { cursor } : {}),
    } satisfies ListResourcesParams);
  }

  /** Read the contents of a resource by URI. */
  async readResource(uri: string): Promise<ReadResourceResult> {
    this.assertInitialized();
    return this.request<ReadResourceResult>("resources/read", {
      uri,
    } satisfies ReadResourceParams);
  }

  /** List prompt templates the server exposes. */
  async listPrompts(cursor?: string): Promise<ListPromptsResult> {
    this.assertInitialized();
    return this.request<ListPromptsResult>("prompts/list", {
      ...(cursor ? { cursor } : {}),
    } satisfies ListPromptsParams);
  }

  /**
   * Fetch a rendered prompt by name. `args` supplies values for any
   * required template arguments; the server validates. Returns messages
   * ready to prepend to the model's input.
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    this.assertInitialized();
    return this.request<GetPromptResult>("prompts/get", {
      name,
      ...(args ? { arguments: args } : {}),
    } satisfies GetPromptParams);
  }

  /** Close the transport and reject any outstanding requests. */
  async close(): Promise<void> {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("MCP client closed"));
    }
    this.pending.clear();
    await this.transport.close();
  }

  // ---------- internals ----------

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("MCP client not initialized — call initialize() first");
  }

  private async request<R>(method: string, params: unknown): Promise<R> {
    const id = this.nextId++;
    const frame: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<R>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`MCP request ${method} (id=${id}) timed out after ${this.requestTimeoutMs}ms`),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
    });
    await this.transport.send(frame);
    return promise;
  }

  private startReaderIfNeeded(): void {
    if (this.readerStarted) return;
    this.readerStarted = true;
    // Fire-and-forget: the reader runs for the lifetime of the client.
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const msg of this.transport.messages()) {
        this.dispatch(msg);
      }
    } catch (err) {
      // Surface as rejections on all pending requests so nobody hangs.
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(err as Error);
      }
      this.pending.clear();
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    // Notifications (no `id`): route by method. Progress notifications
    // go to the per-call handler if one was registered; everything
    // else is dropped silently (we don't yet handle tools/list_changed
    // or resources/list_changed).
    if (!("id" in msg) || msg.id === null || msg.id === undefined) {
      if ("method" in msg && msg.method === "notifications/progress") {
        const p = msg.params as ProgressNotificationParams | undefined;
        if (!p || p.progressToken === undefined) return;
        const handler = this.progressHandlers.get(p.progressToken);
        if (!handler) return; // late notification after the call resolved
        handler({ progress: p.progress, total: p.total, message: p.message });
      }
      return;
    }
    if (!("result" in msg) && !("error" in msg)) return; // it's a request from server
    const pending = this.pending.get(msg.id);
    if (!pending) return; // late response after timeout; drop
    this.pending.delete(msg.id);
    clearTimeout(pending.timeout);
    const resp = msg as JsonRpcResponse;
    if (isJsonRpcError(resp)) {
      pending.reject(new Error(`MCP ${resp.error.code}: ${resp.error.message}`));
    } else {
      pending.resolve(resp.result);
    }
  }
}
