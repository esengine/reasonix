/**
 * HTTP+SSE transport for MCP (spec version 2024-11-05).
 *
 * Wire shape:
 *   1. Client opens GET to the SSE URL with `Accept: text/event-stream`.
 *   2. Server's first SSE event is `event: endpoint`, `data: <url>` — the
 *      URL (relative or absolute) the client must POST JSON-RPC requests
 *      to. All subsequent server → client messages arrive as `event: message`
 *      SSE frames carrying a JSON-RPC response or server-initiated frame.
 *   3. Client POSTs each outgoing JSON-RPC frame to the endpoint URL.
 *      The POST response body is ignored — replies land on the SSE stream.
 *
 * This transport exists so Reasonix can talk to hosted/remote MCP servers
 * (e.g. a company's internal knowledge server fronted by auth). Stdio
 * covers local subprocesses; SSE covers everything else.
 *
 * Note: the newer "Streamable HTTP" transport (2025 spec) folds the POST
 * and SSE streams onto a single endpoint. We stay on 2024-11-05 here —
 * that's what `MCP_PROTOCOL_VERSION` advertises in the initialize handshake
 * and what currently-published servers implement.
 */

import { createParser } from "eventsource-parser";
import type { McpTransport } from "./stdio.js";
import type { JsonRpcMessage } from "./types.js";

export interface SseTransportOptions {
  /** SSE endpoint URL, e.g. `https://mcp.example.com/sse`. */
  url: string;
  /** Extra headers sent on both the SSE GET and the JSON-RPC POSTs (e.g. `Authorization`). */
  headers?: Record<string, string>;
}

/**
 * Open an SSE stream to `url`, parse incoming events into JsonRpcMessages,
 * POST outgoing frames to the endpoint URL the server advertises.
 */
export class SseTransport implements McpTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly queue: JsonRpcMessage[] = [];
  private readonly waiters: Array<(m: JsonRpcMessage | null) => void> = [];
  private readonly controller = new AbortController();
  private closed = false;
  private postUrl: string | null = null;
  private readonly endpointReady: Promise<string>;
  private resolveEndpoint!: (url: string) => void;
  private rejectEndpoint!: (err: Error) => void;

  constructor(opts: SseTransportOptions) {
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.endpointReady = new Promise<string>((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });
    // Swallow unhandled-rejection noise if nobody ever calls send().
    this.endpointReady.catch(() => undefined);
    void this.runStream();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("MCP SSE transport is closed");
    const postUrl = await this.endpointReady;
    const res = await fetch(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(message),
      signal: this.controller.signal,
    });
    // Drain body so the socket returns to the pool even if the server
    // elected to write one. We explicitly don't parse it — responses
    // arrive on the SSE channel.
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) {
      throw new Error(`MCP SSE POST ${postUrl} failed: ${res.status} ${res.statusText}`);
    }
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
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
    // Reject any still-pending send() that was waiting for the endpoint.
    this.rejectEndpoint(new Error("MCP SSE transport closed before endpoint was ready"));
    try {
      this.controller.abort();
    } catch {
      /* already aborted */
    }
  }

  // ---------- internals ----------

  private async runStream(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "GET",
        headers: { accept: "text/event-stream", ...this.headers },
        signal: this.controller.signal,
      });
    } catch (err) {
      this.failHandshake(`SSE connect to ${this.url} failed: ${(err as Error).message}`);
      return;
    }
    if (!res.ok || !res.body) {
      // Drain body to free the socket before giving up.
      await res.body?.cancel().catch(() => undefined);
      this.failHandshake(`SSE handshake ${this.url} → ${res.status} ${res.statusText}`);
      return;
    }

    const parser = createParser({
      onEvent: (ev) => this.handleEvent(ev.event ?? "message", ev.data),
    });
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        parser.feed(decoder.decode(chunk, { stream: true }));
      }
    } catch (err) {
      if (!this.closed) {
        this.pushError(`SSE stream error: ${(err as Error).message}`);
      }
    } finally {
      this.markClosed();
    }
  }

  private handleEvent(type: string, data: string): void {
    if (type === "endpoint") {
      if (this.postUrl) return; // ignore repeat announcements
      try {
        this.postUrl = new URL(data, this.url).toString();
        this.resolveEndpoint(this.postUrl);
      } catch (err) {
        this.failHandshake(`SSE endpoint event had bad URL "${data}": ${(err as Error).message}`);
      }
      return;
    }
    if (type === "message") {
      try {
        const parsed = JSON.parse(data) as JsonRpcMessage;
        this.pushMessage(parsed);
      } catch {
        // Malformed JSON-RPC on an SSE frame — drop it, same as stdio.
      }
      return;
    }
    // Unknown event types (server pings, custom extensions) — ignore.
  }

  private failHandshake(reason: string): void {
    this.rejectEndpoint(new Error(reason));
    this.pushError(reason);
    this.markClosed();
  }

  private pushMessage(msg: JsonRpcMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(msg);
    else this.queue.push(msg);
  }

  private pushError(message: string): void {
    this.pushMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message },
    });
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }
}
