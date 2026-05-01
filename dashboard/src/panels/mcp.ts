import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { fmtNum } from "../lib/format.js";
import { html } from "../lib/html.js";

interface McpServer {
  label: string;
  spec: string;
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
  instructions?: string;
  toolCount: number;
  tools: { name: string; description?: string }[];
  resources: { name: string; uri: string }[];
  prompts: { name: string; description?: string }[];
}

interface McpData {
  servers: McpServer[];
}

export function McpPanel() {
  const [data, setData] = useState<McpData | null>(null);
  const [specs, setSpecs] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [newSpec, setNewSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<McpServer | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<McpData>("/mcp"));
      setSpecs((await api<{ specs: string[] }>("/mcp/specs")).specs);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const addSpec = useCallback(async () => {
    if (!newSpec.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ requiresRestart?: boolean }>("/mcp/specs", {
        method: "POST",
        body: { spec: newSpec.trim() },
      });
      setInfo(
        r.requiresRestart ? "saved — restart `reasonix code` to bridge this server" : "saved",
      );
      setTimeout(() => setInfo(null), 4000);
      setNewSpec("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [newSpec, load]);

  const removeSpec = useCallback(
    async (spec: string) => {
      if (!confirm(`Remove MCP spec from config?\n\n${spec}`)) return;
      setBusy(true);
      try {
        await api("/mcp/specs", { method: "DELETE", body: { spec } });
        setInfo("removed — restart to drop the live bridge");
        setTimeout(() => setInfo(null), 4000);
        await load();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!data && !error) return html`<div class="card" style="color:var(--fg-3)">loading MCP…</div>`;
  if (error && !data) return html`<div class="card accent-err">${error}</div>`;
  if (!data) return null;

  return html`
    <div class="sessions-grid">
      <div class="sessions-list">
        <div class="ssl-h" style="font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
          MCP servers · ${data.servers.length} bridged
        </div>
        <div style="padding:8px 12px;display:flex;gap:6px">
          <input
            type="text"
            placeholder='spec — e.g. fs=npx -y @modelcontextprotocol/...'
            value=${newSpec}
            onInput=${(e: Event) => setNewSpec((e.target as HTMLInputElement).value)}
            style="flex:1;font-size:11px"
          />
          <button class="btn primary" disabled=${busy || !newSpec.trim()} onClick=${addSpec}>+</button>
        </div>
        ${info ? html`<div style="padding:0 12px 8px"><span class="pill ok">${info}</span></div>` : null}
        ${error ? html`<div class="card accent-err" style="margin:0 12px 8px">${error}</div>` : null}

        <div class="ssl-rows">
          ${data.servers.length === 0
            ? html`<div style="color:var(--fg-3);padding:14px;font-size:12px">
                No MCP servers in this session.
              </div>`
            : data.servers.map((s) => html`
              <div
                class=${`ssl-row ${open?.label === s.label ? "sel" : ""}`}
                onClick=${() => setOpen(s)}
              >
                <span class="name">${s.label} <span class="pill ok">live</span></span>
                <span class="preview">${s.spec}</span>
                <span class="meta"><span><span class="v">${fmtNum(s.toolCount)}</span> tools</span></span>
              </div>
            `)}
          ${(specs ?? [])
            .filter((spec) => !data.servers.some((s) => s.spec === spec))
            .map((spec) => html`
              <div class="ssl-row" style="cursor:default">
                <span class="name">(unbridged) <span class="pill">config</span></span>
                <span class="preview">${spec}</span>
                <span class="meta">
                  <button
                    class="btn ghost"
                    style="font-size:10.5px;padding:2px 6px;color:var(--c-err);border-color:var(--c-err)"
                    disabled=${busy}
                    onClick=${(e: Event) => {
                      e.stopPropagation();
                      removeSpec(spec);
                    }}
                  >remove</button>
                </span>
              </div>
            `)}
        </div>
      </div>

      <div class="sessions-detail">
        ${
          open == null
            ? html`<div style="color:var(--fg-3);font-size:13px;text-align:center;padding:60px 20px">
                Pick an MCP server on the left to inspect tools / resources / prompts.
              </div>`
            : html`
                <div class="sessions-detail-h">
                  <span class="name">${open.label}</span>
                  <span class="ws">${open.serverInfo?.name ?? "—"} ${open.serverInfo?.version ? `v${open.serverInfo.version}` : ""} · ${open.protocolVersion ?? "—"}</span>
                  <span class="actions">
                    <button class="btn ghost" onClick=${() => setOpen(null)}>← back</button>
                  </span>
                </div>

                <div class="card" style="margin-bottom:12px">
                  <div class="card-h"><span class="title">spec</span></div>
                  <code class="mono" style="font-size:11.5px;color:var(--fg-2)">${open.spec}</code>
                </div>

                ${
                  open.instructions
                    ? html`<div class="card accent-brand" style="margin-bottom:12px">
                        <div class="card-b">${open.instructions}</div>
                      </div>`
                    : null
                }

                <h3 style="margin:18px 0 6px;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
                  Tools · ${open.tools.length}
                </h3>
                <div class="card" style="padding:0;overflow:hidden">
                  <table class="tbl">
                    <thead><tr><th>name</th><th>description</th></tr></thead>
                    <tbody>
                      ${open.tools.map(
                        (t) => html`<tr><td><code class="mono">${t.name}</code></td><td class="dim">${t.description ?? ""}</td></tr>`,
                      )}
                    </tbody>
                  </table>
                </div>

                ${
                  open.resources.length > 0
                    ? html`
                      <h3 style="margin:18px 0 6px;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
                        Resources · ${open.resources.length}
                      </h3>
                      <div class="card" style="padding:0;overflow:hidden">
                        <table class="tbl">
                          <thead><tr><th>name</th><th>uri</th></tr></thead>
                          <tbody>
                            ${open.resources.map(
                              (r) => html`<tr><td>${r.name}</td><td class="path">${r.uri}</td></tr>`,
                            )}
                          </tbody>
                        </table>
                      </div>
                    `
                    : null
                }

                ${
                  open.prompts.length > 0
                    ? html`
                      <h3 style="margin:18px 0 6px;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
                        Prompts · ${open.prompts.length}
                      </h3>
                      <div class="card" style="padding:0;overflow:hidden">
                        <table class="tbl">
                          <thead><tr><th>name</th><th>description</th></tr></thead>
                          <tbody>
                            ${open.prompts.map(
                              (p) => html`<tr><td><code class="mono">${p.name}</code></td><td class="dim">${p.description ?? ""}</td></tr>`,
                            )}
                          </tbody>
                        </table>
                      </div>
                    `
                    : null
                }
              `
        }
      </div>
    </div>
  `;
}
