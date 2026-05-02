/** SSE transport — in-process http.Server speaking the MCP HTTP+SSE wire shape. */

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { SseTransport } from "../src/mcp/sse.js";
import { MCP_PROTOCOL_VERSION } from "../src/mcp/types.js";

interface FakeSseServer {
  url: string;
  requests: Array<{ method: string; url: string; body?: string }>;
  stop: () => Promise<void>;
}

interface FakeSseOptions {
  /** Endpoint URL announced in the first SSE event. Relative or absolute. */
  endpointPath?: string;
  /** Override the SSE GET path (default `/sse`). */
  ssePath?: string;
  /** Override the POST path (default `/messages`). */
  postPath?: string;
  /** Auto-answer incoming JSON-RPC requests on the SSE channel. */
  autoRespond?: (body: unknown) => unknown;
  /** Return this status for the initial SSE GET instead of 200. */
  handshakeStatus?: number;
}

function startFakeSseServer(opts: FakeSseOptions = {}): Promise<FakeSseServer> {
  const ssePath = opts.ssePath ?? "/sse";
  const postPath = opts.postPath ?? "/messages";
  const endpointPath = opts.endpointPath ?? postPath;
  let sseRes: ServerResponse | null = null;
  const requests: FakeSseServer["requests"] = [];

  const writeFrame = (res: ServerResponse, event: string, data: string) => {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === ssePath) {
      requests.push({ method: "GET", url: req.url ?? "" });
      if (opts.handshakeStatus && opts.handshakeStatus !== 200) {
        res.statusCode = opts.handshakeStatus;
        res.end("not ok");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseRes = res;
      writeFrame(res, "endpoint", endpointPath);
      req.on("close", () => {
        if (sseRes === res) sseRes = null;
      });
      return;
    }
    if (req.method === "POST" && req.url === postPath) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ method: "POST", url: req.url ?? "", body });
        res.writeHead(202);
        res.end();
        if (opts.autoRespond && sseRes) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return;
          }
          const reply = opts.autoRespond(parsed);
          if (reply !== undefined) {
            writeFrame(sseRes, "message", JSON.stringify(reply));
          }
        }
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}${ssePath}`,
        requests,
        stop: () =>
          new Promise<void>((r) => {
            sseRes?.end();
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

describe("SseTransport: handshake + round-trip", () => {
  let fake: FakeSseServer | null = null;

  beforeEach(() => {
    fake = null;
  });
  afterEach(async () => {
    await fake?.stop();
  });

  it("resolves a relative endpoint URL against the SSE base", async () => {
    fake = await startFakeSseServer({
      endpointPath: "/messages",
      autoRespond: (req) => ({
        jsonrpc: "2.0",
        id: (req as { id: number }).id,
        result: { ok: true },
      }),
    });
    const transport = new SseTransport({ url: fake.url });
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

    // Read one incoming message.
    const iter = transport.messages();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ id: 1, result: { ok: true } });
    await transport.close();
  });

  it("drives a full McpClient initialize → tools/list round-trip", async () => {
    fake = await startFakeSseServer({
      autoRespond: (raw) => {
        const req = raw as { id?: number; method: string };
        if (req.id === undefined) return undefined; // notification (initialized)
        if (req.method === "initialize") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              serverInfo: { name: "fake-sse", version: "0.0.0" },
              capabilities: { tools: { listChanged: false } },
            },
          };
        }
        if (req.method === "tools/list") {
          return {
            jsonrpc: "2.0",
            id: req.id,
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
          id: req.id,
          error: { code: -32601, message: `no such method ${req.method}` },
        };
      },
    });
    const client = new McpClient({ transport: new SseTransport({ url: fake.url }) });
    const info = await client.initialize();
    expect(info.serverInfo.name).toBe("fake-sse");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("ping");

    await client.close();

    // We should have exactly: GET /sse, POST initialize, POST notifications/initialized, POST tools/list
    const posts = fake.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(3);
    const methods = posts.map((p) => (JSON.parse(p.body!) as { method: string }).method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("accepts an absolute endpoint URL", async () => {
    // Spin up a first server just to get a port we can embed in the other.
    const probe = await startFakeSseServer();
    const absoluteEndpoint = new URL("/messages", probe.url).toString();
    await probe.stop();

    fake = await startFakeSseServer({
      endpointPath: absoluteEndpoint,
      autoRespond: (req) => ({
        jsonrpc: "2.0",
        id: (req as { id: number }).id,
        result: { pong: true },
      }),
    });
    // Point the SSE transport at THIS server, but have it advertise the
    // stale probe URL — we care that the client stores it verbatim
    // rather than resolving it against the base, so the POST will land
    // on the dead probe port and fail. That's the assertion.
    const t = new SseTransport({ url: fake.url });
    await expect(t.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow();
    await t.close();
  });

  it("surfaces a handshake failure as a synthetic error frame", async () => {
    fake = await startFakeSseServer({ handshakeStatus: 500 });
    const t = new SseTransport({ url: fake.url });
    // Any pending send() rejects with the handshake error.
    await expect(t.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(/500/);
    await t.close();
  });
});
