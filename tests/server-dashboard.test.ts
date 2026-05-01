/**
 * Dashboard server tests — drive the real http server on an ephemeral
 * port and assert on responses. Covers:
 *   - Token + CSRF gating (header-only for mutations)
 *   - Each v0.12 endpoint's shape (overview / usage / tools / permissions)
 *   - Permissions CRUD round-trip with a temp config file
 *
 * Skipping browser-driven e2e (Playwright) until v0.13 — for v0.12 the
 * SPA is small enough that endpoint contract + the markup file's
 * existence is enough confidence.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProjectShellAllowed, loadProjectShellAllowed } from "../src/config.js";
import type { DashboardContext } from "../src/server/context.js";
import {
  type DashboardServerHandle,
  constantTimeEquals,
  startDashboardServer,
} from "../src/server/index.js";
import { ToolRegistry } from "../src/tools.js";

interface FetchResult {
  status: number;
  body: any;
  headers: Headers;
}

async function call(
  url: string,
  opts: { method?: string; token?: string; tokenInHeader?: boolean; body?: unknown } = {},
): Promise<FetchResult> {
  const method = opts.method ?? "GET";
  const u = new URL(url);
  if (opts.token && !opts.tokenInHeader) {
    u.searchParams.set("token", opts.token);
  }
  const headers: Record<string, string> = {};
  if (opts.token && opts.tokenInHeader) {
    headers["X-Reasonix-Token"] = opts.token;
  }
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(u.toString(), {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

describe("constantTimeEquals", () => {
  it("returns true for matching strings", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
  });
  it("returns false for length mismatch (short-circuit)", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });
  it("returns false for content mismatch", () => {
    expect(constantTimeEquals("abc", "abd")).toBe(false);
  });
});

describe("dashboard server: auth + CSRF", () => {
  let dir: string;
  let cfgPath: string;
  let usagePath: string;
  let handle: DashboardServerHandle | null = null;
  const TOKEN = "deadbeefcafebabe1234567890abcdefdeadbeefcafebabe1234567890abcdef";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-dashtest-"));
    cfgPath = join(dir, "config.json");
    usagePath = join(dir, "usage.jsonl");
    handle = await startDashboardServer(
      {
        mode: "standalone",
        configPath: cfgPath,
        usageLogPath: usagePath,
      },
      { token: TOKEN },
    );
  });

  afterEach(async () => {
    await handle?.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects /api/overview without a token", async () => {
    const r = await call(`${handle!.url.split("?")[0]}api/overview`);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/token/i);
  });

  it("accepts /api/overview with token in query", async () => {
    const r = await call(`${handle!.url.split("?")[0]}api/overview`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("standalone");
    expect(typeof r.body.version).toBe("string");
  });

  it("accepts /api/overview with token in header", async () => {
    const r = await call(`${handle!.url.split("?")[0]}api/overview`, {
      token: TOKEN,
      tokenInHeader: true,
    });
    expect(r.status).toBe(200);
  });

  it("rejects POST mutations when token is in query (CSRF defence)", async () => {
    // Add an entry first via the helper so the project has something to
    // be mutated against. Mutations require codeRoot anyway, so this
    // ALSO doubles as the standalone-mode rejection test.
    addProjectShellAllowed("/some/proj", "lint", cfgPath);
    const r = await call(`${handle!.url.split("?")[0]}api/permissions`, {
      method: "POST",
      token: TOKEN,
      // tokenInHeader: false → token only in query
      body: { prefix: "test" },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/CSRF|header/i);
  });

  it("rejects POST mutations with no token", async () => {
    const r = await call(`${handle!.url.split("?")[0]}api/permissions`, {
      method: "POST",
      body: { prefix: "test" },
    });
    expect(r.status).toBe(403);
  });

  it("rejects /api with a wrong token (constant-time mismatch)", async () => {
    const r = await call(`${handle!.url.split("?")[0]}api/overview`, {
      token: "0".repeat(TOKEN.length),
    });
    expect(r.status).toBe(401);
  });

  it("404s an unknown endpoint (token-gated)", async () => {
    const r = await call(`${handle!.url.split("?")[0]}api/nonsuch`, { token: TOKEN });
    expect(r.status).toBe(404);
  });

  it("405s on wrong method (e.g. POST overview)", async () => {
    const r = await call(`${handle!.url.split("?")[0]}api/overview`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: {},
    });
    expect(r.status).toBe(405);
  });
});

describe("dashboard server: endpoints", () => {
  let dir: string;
  let cfgPath: string;
  let usagePath: string;
  let handle: DashboardServerHandle | null = null;
  const TOKEN = "f".repeat(64);
  const PROJ = "/test/project";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-dash-ep-"));
    cfgPath = join(dir, "config.json");
    usagePath = join(dir, "usage.jsonl");
  });

  afterEach(async () => {
    await handle?.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  async function boot(extra: Partial<DashboardContext> = {}): Promise<string> {
    handle = await startDashboardServer(
      {
        mode: "attached",
        configPath: cfgPath,
        usageLogPath: usagePath,
        ...extra,
      },
      { token: TOKEN },
    );
    return handle.url.split("?")[0]!;
  }

  it("GET /api/overview returns the live overview shape", async () => {
    const tools = new ToolRegistry();
    const base = await boot({
      tools,
      getCurrentCwd: () => PROJ,
      getEditMode: () => "review",
      getPlanMode: () => false,
      getPendingEditCount: () => 0,
    });
    const r = await call(`${base}api/overview`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("attached");
    expect(r.body.cwd).toBe(PROJ);
    expect(r.body.editMode).toBe("review");
    expect(r.body.planMode).toBe(false);
    expect(r.body.pendingEdits).toBe(0);
    expect(r.body.toolCount).toBe(0);
  });

  it("GET /api/usage returns aggregateUsage + record count", async () => {
    const base = await boot();
    const r = await call(`${base}api/usage`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.recordCount).toBe(0);
    expect(r.body.buckets).toHaveLength(4);
    expect(r.body.byModel).toEqual([]);
  });

  it("GET /api/tools returns 503 in standalone mode", async () => {
    handle = await startDashboardServer(
      { mode: "standalone", configPath: cfgPath, usageLogPath: usagePath },
      { token: TOKEN },
    );
    const base = handle.url.split("?")[0]!;
    const r = await call(`${base}api/tools`, { token: TOKEN });
    expect(r.status).toBe(503);
    expect(r.body.available).toBe(false);
  });

  it("GET /api/tools enumerates registered tools when attached", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echoes back",
      readOnly: true,
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    const base = await boot({ tools });
    const r = await call(`${base}api/tools`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.tools[0].name).toBe("echo");
    expect(r.body.tools[0].readOnly).toBe(true);
  });

  it("GET /api/permissions lists builtin always; project list when cwd is set", async () => {
    addProjectShellAllowed(PROJ, "npm run build", cfgPath);
    const base = await boot({ getCurrentCwd: () => PROJ, getEditMode: () => "review" });
    const r = await call(`${base}api/permissions`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.builtin.length).toBeGreaterThan(10); // we ship 30+ builtin entries
    expect(r.body.project).toContain("npm run build");
    expect(r.body.editMode).toBe("review");
  });

  it("POST /api/permissions adds a prefix and audits the action", async () => {
    const audited: Array<{ action: string; payload?: unknown }> = [];
    const base = await boot({
      getCurrentCwd: () => PROJ,
      getEditMode: () => "review",
      audit: (e) => audited.push({ action: e.action, payload: e.payload }),
    });
    const r = await call(`${base}api/permissions`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { prefix: "deploy.sh" },
    });
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(true);
    expect(loadProjectShellAllowed(PROJ, cfgPath)).toContain("deploy.sh");
    expect(audited[0]?.action).toBe("add-allowlist");
  });

  it("POST /api/permissions rejects a builtin entry (409)", async () => {
    const base = await boot({ getCurrentCwd: () => PROJ });
    const r = await call(`${base}api/permissions`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { prefix: "git status" },
    });
    expect(r.status).toBe(409);
  });

  it("DELETE /api/permissions removes a prefix", async () => {
    addProjectShellAllowed(PROJ, "deploy.sh", cfgPath);
    const base = await boot({ getCurrentCwd: () => PROJ });
    const r = await call(`${base}api/permissions`, {
      method: "DELETE",
      token: TOKEN,
      tokenInHeader: true,
      body: { prefix: "deploy.sh" },
    });
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(true);
    expect(loadProjectShellAllowed(PROJ, cfgPath)).not.toContain("deploy.sh");
  });

  it("POST /api/permissions/clear without confirm:true returns 400", async () => {
    addProjectShellAllowed(PROJ, "x", cfgPath);
    const base = await boot({ getCurrentCwd: () => PROJ });
    const r = await call(`${base}api/permissions/clear`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: {},
    });
    expect(r.status).toBe(400);
  });

  it("POST /api/permissions/clear with confirm:true wipes the project list", async () => {
    addProjectShellAllowed(PROJ, "x", cfgPath);
    addProjectShellAllowed(PROJ, "y", cfgPath);
    const base = await boot({ getCurrentCwd: () => PROJ });
    const r = await call(`${base}api/permissions/clear`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { confirm: true },
    });
    expect(r.status).toBe(200);
    expect(r.body.dropped).toBe(2);
    expect(loadProjectShellAllowed(PROJ, cfgPath)).toEqual([]);
  });

  it("Permissions mutations refuse without a current project (503)", async () => {
    const base = await boot({}); // no getCurrentCwd
    const r = await call(`${base}api/permissions`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { prefix: "x" },
    });
    expect(r.status).toBe(503);
  });
});

describe("dashboard server: SPA shell", () => {
  let handle: DashboardServerHandle | null = null;
  let dir: string;
  const TOKEN = "a".repeat(64);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-dash-spa-"));
    handle = await startDashboardServer(
      {
        mode: "standalone",
        configPath: join(dir, "config.json"),
        usageLogPath: join(dir, "usage.jsonl"),
      },
      { token: TOKEN },
    );
  });

  afterEach(async () => {
    await handle?.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("GET / serves index.html with the token + mode injected", async () => {
    const r = await call(handle!.url, { token: TOKEN });
    expect(r.status).toBe(200);
    const html = String(r.body);
    expect(html).toContain(TOKEN); // token interpolated into <meta>
    expect(html).toContain("standalone"); // mode interpolated
    expect(html).toContain("<title>Reasonix</title>");
  });

  it("rendered index.html replaces ALL token placeholders, not just the first", async () => {
    // Regression: String.replace(s, r) only swaps the first occurrence.
    // The HTML template has __REASONIX_TOKEN__ in three spots (meta,
    // css href, script src). Browser hits 401 on every asset fetch
    // when only the meta tag gets the real token.
    const r = await call(handle!.url, { token: TOKEN });
    const html = String(r.body);
    expect(html).not.toContain("__REASONIX_TOKEN__");
    expect(html).not.toContain("__REASONIX_MODE__");
    // Sanity: every asset URL should embed the live token, not the placeholder.
    const assetMatches = html.match(/\/assets\/[^"]+/g) ?? [];
    for (const url of assetMatches) {
      expect(url).toContain(`token=${TOKEN}`);
    }
  });

  it("GET /assets/app.js requires the token", async () => {
    const noToken = await call(`${handle!.url.split("?")[0]}assets/app.js`);
    expect(noToken.status).toBe(401);
  });

  const dashAppExists = existsSync(join(process.cwd(), "dashboard", "dist", "app.js"));
  (dashAppExists ? it : it.skip)("GET /assets/app.js serves the script when authed", async () => {
    const r = await call(`${handle!.url.split("?")[0]}assets/app.js`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/javascript/);
  });
});

describe("dashboard server: chat bridge", () => {
  let dir: string;
  let cfgPath: string;
  let usagePath: string;
  let handle: DashboardServerHandle | null = null;
  const TOKEN = "c".repeat(64);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-dash-chat-"));
    cfgPath = join(dir, "config.json");
    usagePath = join(dir, "usage.jsonl");
  });

  afterEach(async () => {
    await handle?.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  async function boot(extra: Partial<DashboardContext> = {}): Promise<string> {
    handle = await startDashboardServer(
      {
        mode: "attached",
        configPath: cfgPath,
        usageLogPath: usagePath,
        ...extra,
      },
      { token: TOKEN },
    );
    return handle.url.split("?")[0]!;
  }

  it("GET /api/messages returns the snapshot from getMessages()", async () => {
    const base = await boot({
      getMessages: () => [
        { id: "u1", role: "user", text: "hello" },
        { id: "a1", role: "assistant", text: "hi" },
      ],
      isBusy: () => false,
    });
    const r = await call(`${base}api/messages`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.messages).toHaveLength(2);
    expect(r.body.messages[0].text).toBe("hello");
    expect(r.body.busy).toBe(false);
  });

  it("GET /api/messages returns [] when no callback wired (standalone)", async () => {
    const base = await boot({});
    const r = await call(`${base}api/messages`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.messages).toEqual([]);
  });

  it("POST /api/submit accepts a prompt when not busy", async () => {
    const submitted: string[] = [];
    const base = await boot({
      isBusy: () => false,
      submitPrompt: (text) => {
        submitted.push(text);
        return { accepted: true };
      },
    });
    const r = await call(`${base}api/submit`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { prompt: "build me a thing" },
    });
    expect(r.status).toBe(202);
    expect(r.body.accepted).toBe(true);
    expect(submitted).toEqual(["build me a thing"]);
  });

  it("POST /api/submit returns 409 when the loop is busy", async () => {
    const base = await boot({
      submitPrompt: () => ({ accepted: false, reason: "loop is busy" }),
    });
    const r = await call(`${base}api/submit`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { prompt: "x" },
    });
    expect(r.status).toBe(409);
    expect(r.body.accepted).toBe(false);
    expect(r.body.reason).toMatch(/busy/i);
  });

  it("POST /api/submit rejects empty prompts (400)", async () => {
    const base = await boot({ submitPrompt: () => ({ accepted: true }) });
    const r = await call(`${base}api/submit`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { prompt: "   " },
    });
    expect(r.status).toBe(400);
  });

  it("POST /api/submit returns 503 when no submitPrompt callback wired", async () => {
    const base = await boot({});
    const r = await call(`${base}api/submit`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { prompt: "x" },
    });
    expect(r.status).toBe(503);
  });

  it("POST /api/abort fires the abortTurn callback", async () => {
    let aborted = 0;
    const base = await boot({ abortTurn: () => aborted++ });
    const r = await call(`${base}api/abort`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
    });
    expect(r.status).toBe(202);
    expect(aborted).toBe(1);
  });

  it("GET /api/events streams events from subscribeEvents", async () => {
    let activeHandler: ((ev: any) => void) | null = null;
    const base = await boot({
      isBusy: () => false,
      subscribeEvents: (h) => {
        activeHandler = h;
        return () => {
          activeHandler = null;
        };
      },
    });

    // Open SSE in a fetch request — abort signal lets us close it.
    const ac = new AbortController();
    const res = await fetch(`${base}api/events?token=${TOKEN}`, {
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/event-stream/);
    expect(activeHandler).not.toBeNull();

    // Read one chunk — should contain the bootstrapping busy-change
    // frame the SSE handler emits to seed initial client state.
    const reader = res.body!.getReader();
    const { value: firstChunk } = await reader.read();
    const firstText = new TextDecoder().decode(firstChunk!);
    expect(firstText).toContain("busy-change");

    // Push a synthetic event, expect the next chunk to contain it.
    activeHandler!({ kind: "info", id: "x", text: "hello world" });
    const { value: secondChunk } = await reader.read();
    const secondText = new TextDecoder().decode(secondChunk!);
    expect(secondText).toContain("hello world");

    // Tear down. Disconnect cleanup is an integration concern not
    // worth a flaky timing-dependent assertion; the events.ts cleanup
    // logic is straightforward (unsubscribe in `req.on("close")`).
    reader.cancel().catch(() => undefined);
    ac.abort();
  });

  it("GET /api/events without a subscribeEvents callback returns 503", async () => {
    const base = await boot({});
    const r = await fetch(`${base}api/events?token=${TOKEN}`);
    expect(r.status).toBe(503);
    await r.body?.cancel();
  });
});

describe("dashboard server: v0.13 panels", () => {
  let dir: string;
  let cfgPath: string;
  let usagePath: string;
  let handle: DashboardServerHandle | null = null;
  const TOKEN = "d".repeat(64);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-dash-v013-"));
    cfgPath = join(dir, "config.json");
    usagePath = join(dir, "usage.jsonl");
    handle = await startDashboardServer(
      {
        mode: "attached",
        configPath: cfgPath,
        usageLogPath: usagePath,
      },
      { token: TOKEN },
    );
  });

  afterEach(async () => {
    await handle?.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/health returns disk + version + jobs shape", async () => {
    const base = handle!.url.split("?")[0]!;
    const r = await call(`${base}api/health`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(typeof r.body.version).toBe("string");
    expect(r.body.sessions).toBeDefined();
    expect(typeof r.body.sessions.totalBytes).toBe("number");
    expect(r.body.memory).toBeDefined();
    expect(r.body.semantic).toBeDefined();
    expect(r.body.usageLog).toBeDefined();
  });

  it("GET /api/sessions returns an empty list when nothing's stored", async () => {
    const base = handle!.url.split("?")[0]!;
    const r = await call(`${base}api/sessions`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.sessions)).toBe(true);
  });

  it("GET /api/sessions/<missing> returns 404", async () => {
    const base = handle!.url.split("?")[0]!;
    const r = await call(`${base}api/sessions/no-such-session`, { token: TOKEN });
    expect(r.status).toBe(404);
  });

  it("GET /api/plans returns empty array when no archives exist", async () => {
    const base = handle!.url.split("?")[0]!;
    const r = await call(`${base}api/plans`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.plans)).toBe(true);
  });

  it("GET /api/usage/series returns the daily roll-up shape", async () => {
    const base = handle!.url.split("?")[0]!;
    const r = await call(`${base}api/usage/series`, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.days)).toBe(true);
    expect(typeof r.body.recordCount).toBe("number");
  });
});

describe("dashboard server: modal mirroring (workspace / checkpoint / revision)", () => {
  let dir: string;
  let cfgPath: string;
  let usagePath: string;
  let handle: DashboardServerHandle | null = null;
  const TOKEN = "e".repeat(64);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-dash-modal-"));
    cfgPath = join(dir, "config.json");
    usagePath = join(dir, "usage.jsonl");
  });

  afterEach(async () => {
    await handle?.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  async function boot(extra: Partial<DashboardContext> = {}): Promise<string> {
    handle = await startDashboardServer(
      { mode: "attached", configPath: cfgPath, usageLogPath: usagePath, ...extra },
      { token: TOKEN },
    );
    return handle.url.split("?")[0]!;
  }

  it("POST /api/modal/resolve forwards a checkpoint revise + feedback", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const base = await boot({
      resolveCheckpointConfirm: (c, t) => calls.push([c, t]),
    });
    const r = await call(`${base}api/modal/resolve`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { kind: "checkpoint", choice: "revise", text: "tighten the loop" },
    });
    expect(r.status).toBe(200);
    expect(calls).toEqual([["revise", "tighten the loop"]]);
  });

  it("POST /api/modal/resolve passes plain checkpoint continue without text", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const base = await boot({
      resolveCheckpointConfirm: (c, t) => calls.push([c, t]),
    });
    const r = await call(`${base}api/modal/resolve`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { kind: "checkpoint", choice: "continue" },
    });
    expect(r.status).toBe(200);
    expect(calls).toEqual([["continue", undefined]]);
  });

  it("POST /api/modal/resolve routes revision accept / reject", async () => {
    const calls: string[] = [];
    const base = await boot({
      resolveReviseConfirm: (c) => calls.push(c),
    });
    const accept = await call(`${base}api/modal/resolve`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { kind: "revision", choice: "accept" },
    });
    expect(accept.status).toBe(200);
    const reject = await call(`${base}api/modal/resolve`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { kind: "revision", choice: "reject" },
    });
    expect(reject.status).toBe(200);
    expect(calls).toEqual(["accept", "reject"]);
  });

  it("POST /api/modal/resolve returns 503 when a resolver isn't wired", async () => {
    const base = await boot({});
    const r = await call(`${base}api/modal/resolve`, {
      method: "POST",
      token: TOKEN,
      tokenInHeader: true,
      body: { kind: "checkpoint", choice: "continue" },
    });
    expect(r.status).toBe(503);
  });
});
