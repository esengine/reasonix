/** Streamable HTTP transport — in-process fake server speaking the Streamable HTTP wire shape. */

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { StreamableHttpTransport } from "../src/mcp/streamable-http.js";
import { MCP_PROTOCOL_VERSION } from "../src/mcp/types.js";

interface FakeServer {
  url: string;
  requests: Array<{
    method: string;
    url: string;
    body?: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
  stop: () => Promise<void>;
}

interface FakeOptions {
  /** Override path (default `/mcp`). */
  path?: string;
  /** Hand back this session id on the initialize response. Default "sess-1". */
  sessionId?: string;
  /** `{ stream: [...] }` → SSE frames; `undefined` → 202 ack; else single application/json body. */
  reply?: (body: unknown) => unknown | { stream: unknown[] } | undefined;
  /** Failure injection lookup runs after `reply` so it can short-circuit the normal path. */
  forceStatus?: (body: unknown) => { status: number; body?: string } | undefined;
}

function startFakeServer(opts: FakeOptions = {}): Promise<FakeServer> {
  const path = opts.path ?? "/mcp";
  const sessionId = opts.sessionId ?? "sess-1";
  const requests: FakeServer["requests"] = [];
  let mintedSession = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !req.url.startsWith(path)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({
          method: "POST",
          url: req.url ?? "",
          body,
          headers: req.headers,
        });
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end("bad json");
          return;
        }

        const forced = opts.forceStatus?.(parsed);
        if (forced) {
          res.writeHead(forced.status);
          res.end(forced.body ?? "");
          return;
        }

        const reply = opts.reply?.(parsed);

        // The session id is minted on the first response that has a
        // body — i.e. the initialize response. Notifications (202) and
        // unknown methods don't get a session header until then.
        const responseHeaders: Record<string, string> = {};
        const isInitialize =
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { method?: string }).method === "initialize";
        if (isInitialize && !mintedSession) {
          responseHeaders["mcp-session-id"] = sessionId;
          mintedSession = true;
        }

        if (reply === undefined) {
          // notification → 202 Accepted, no body
          res.writeHead(202, responseHeaders);
          res.end();
          return;
        }
        if (
          typeof reply === "object" &&
          reply !== null &&
          Array.isArray((reply as { stream?: unknown[] }).stream)
        ) {
          const frames = (reply as { stream: unknown[] }).stream;
          res.writeHead(200, {
            ...responseHeaders,
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          for (const frame of frames) {
            res.write(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
          }
          res.end();
          return;
        }
        res.writeHead(200, {
          ...responseHeaders,
          "content-type": "application/json",
        });
        res.end(JSON.stringify(reply));
      });
      return;
    }

    res.writeHead(405);
    res.end("method not allowed");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}${path}`,
        requests,
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

describe("StreamableHttpTransport: POST round-trip", () => {
  let fake: FakeServer | null = null;

  beforeEach(() => {
    fake = null;
  });
  afterEach(async () => {
    await fake?.stop();
  });

  it("delivers a single application/json response back through messages()", async () => {
    fake = await startFakeServer({
      reply: (req) => ({
        jsonrpc: "2.0",
        id: (req as { id: number }).id,
        result: { ok: true },
      }),
    });
    const transport = new StreamableHttpTransport({ url: fake.url });
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

    const iter = transport.messages();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ id: 1, result: { ok: true } });
    await transport.close();
  });

  it("treats 202 Accepted as a no-op (notification ack, no message yielded)", async () => {
    fake = await startFakeServer({
      reply: (req) => {
        // Notifications have no id — return undefined → 202.
        if ((req as { id?: number }).id === undefined) return undefined;
        return { jsonrpc: "2.0", id: (req as { id: number }).id, result: {} };
      },
    });
    const transport = new StreamableHttpTransport({ url: fake.url });
    await transport.send({ jsonrpc: "2.0", method: "notifications/cancelled" });
    // Now send a real request so we can prove the iterator only got
    // the response (one message), not the notification (no message).
    await transport.send({ jsonrpc: "2.0", id: 42, method: "ping" });
    const iter = transport.messages();
    const first = await iter.next();
    expect(first.value).toMatchObject({ id: 42 });
    await transport.close();
  });

  it("captures Mcp-Session-Id from the initialize response and echoes it on subsequent POSTs", async () => {
    fake = await startFakeServer({
      sessionId: "alpha-session",
      reply: (req) => {
        const r = req as { id?: number; method: string };
        if (r.method === "initialize") {
          return {
            jsonrpc: "2.0",
            id: r.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              serverInfo: { name: "fake", version: "0.0.0" },
              capabilities: {},
            },
          };
        }
        if (r.id === undefined) return undefined;
        return { jsonrpc: "2.0", id: r.id, result: { echoed: r.method } };
      },
    });
    const transport = new StreamableHttpTransport({ url: fake.url });
    const client = new McpClient({ transport });
    await client.initialize();
    expect(transport.getSessionId()).toBe("alpha-session");

    await client.listTools().catch(() => undefined);
    await client.close();

    // First POST = initialize: no session header yet (we don't have one).
    // Second POST = notifications/initialized: should have session id.
    // Third POST = tools/list: should have session id.
    const posts = fake.requests.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts[0]!.headers["mcp-session-id"]).toBeUndefined();
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i]!.headers["mcp-session-id"]).toBe("alpha-session");
    }
  });

  it("delivers SSE-streamed responses with multiple frames in order", async () => {
    fake = await startFakeServer({
      reply: (req) => {
        const r = req as { id: number };
        return {
          stream: [
            // a progress notification first
            { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 50 } },
            // then the real response
            { jsonrpc: "2.0", id: r.id, result: { done: true } },
          ],
        };
      },
    });
    const transport = new StreamableHttpTransport({ url: fake.url });
    await transport.send({ jsonrpc: "2.0", id: 7, method: "slow_tool" });
    const iter = transport.messages();
    const first = await iter.next();
    expect(first.value).toMatchObject({ method: "notifications/progress" });
    const second = await iter.next();
    expect(second.value).toMatchObject({ id: 7, result: { done: true } });
    await transport.close();
  });

  it("drives a full McpClient initialize → tools/list round-trip", async () => {
    fake = await startFakeServer({
      reply: (raw) => {
        const r = raw as { id?: number; method: string };
        if (r.id === undefined) return undefined;
        if (r.method === "initialize") {
          return {
            jsonrpc: "2.0",
            id: r.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              serverInfo: { name: "fake-streamable", version: "0.0.0" },
              capabilities: { tools: { listChanged: false } },
            },
          };
        }
        if (r.method === "tools/list") {
          return {
            jsonrpc: "2.0",
            id: r.id,
            result: {
              tools: [
                {
                  name: "ping",
                  description: "responds pong",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id: r.id,
          error: { code: -32601, message: `no such method ${r.method}` },
        };
      },
    });
    const transport = new StreamableHttpTransport({ url: fake.url });
    const client = new McpClient({ transport });
    const info = await client.initialize();
    expect(info.serverInfo.name).toBe("fake-streamable");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("ping");
    await client.close();

    // initialize + notifications/initialized + tools/list = 3 POSTs.
    const posts = fake.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(3);
    const methods = posts.map((p) => (JSON.parse(p.body!) as { method: string }).method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("surfaces a 404 with an existing session id as 'session expired'", async () => {
    fake = await startFakeServer({
      reply: (req) => {
        const r = req as { id?: number; method: string };
        if (r.method === "initialize") {
          return {
            jsonrpc: "2.0",
            id: r.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              serverInfo: { name: "fake", version: "0.0.0" },
              capabilities: {},
            },
          };
        }
        if (r.id === undefined) return undefined;
        return { jsonrpc: "2.0", id: r.id, result: {} };
      },
      forceStatus: (req) => {
        const r = req as { method?: string };
        if (r.method === "tools/list") {
          return { status: 404, body: "session expired" };
        }
        return undefined;
      },
    });
    const transport = new StreamableHttpTransport({ url: fake.url });
    const client = new McpClient({ transport });
    await client.initialize();
    expect(transport.getSessionId()).not.toBeNull();
    // Once the session id is set, a 404 should surface as a clear error.
    await expect(client.listTools()).rejects.toThrow(/session expired/i);
    await client.close();
  });

  it("surfaces a non-OK response as an error from send()", async () => {
    fake = await startFakeServer({
      forceStatus: () => ({ status: 500, body: "boom" }),
    });
    const transport = new StreamableHttpTransport({ url: fake.url });
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(/500/);
    await transport.close();
  });

  it("close() unblocks an idle messages() iterator", async () => {
    fake = await startFakeServer({ reply: () => undefined });
    const transport = new StreamableHttpTransport({ url: fake.url });
    const iter = transport.messages();
    const next = iter.next();
    await transport.close();
    const settled = await next;
    expect(settled.done).toBe(true);
  });
});
