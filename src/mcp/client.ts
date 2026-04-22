/**
 * MCP client — request/response correlation, initialize handshake,
 * tools/list, tools/call. Built on top of a McpTransport so the same
 * logic works against a real stdio server or an in-process fake.
 */

import type { McpTransport } from "./stdio.js";
import {
  type CallToolParams,
  type CallToolResult,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ListToolsResult,
  MCP_PROTOCOL_VERSION,
  type McpClientInfo,
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

  constructor(opts: McpClientOptions) {
    this.transport = opts.transport;
    this.clientInfo = opts.clientInfo ?? { name: "reasonix", version: "0.3.0-dev" };
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  }

  /** Server's advertised capabilities, available after initialize(). */
  get serverCapabilities(): InitializeResult["capabilities"] {
    return this._serverCapabilities;
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
      capabilities: { tools: {} },
      clientInfo: this.clientInfo,
    } satisfies InitializeParams);
    this._serverCapabilities = result.capabilities ?? {};
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

  /** Invoke a tool by name. Returns the raw MCP result (caller unwraps content). */
  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    this.assertInitialized();
    return this.request<CallToolResult>("tools/call", {
      name,
      arguments: args ?? {},
    } satisfies CallToolParams);
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
    // We only care about responses (have an `id`) for now. Server-initiated
    // notifications are dropped until we support resources/prompts.
    if (!("id" in msg) || msg.id === null || msg.id === undefined) return;
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
