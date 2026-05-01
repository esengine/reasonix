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

function specLabel(spec: string): string {
  const eq = spec.indexOf("=");
  return eq > 0 ? spec.slice(0, eq) : spec;
}

function specCommand(spec: string): string {
  const eq = spec.indexOf("=");
  return eq > 0 ? spec.slice(eq + 1) : spec;
}

type McpFilter = "all" | "live" | "unbridged";

export function McpPanel() {
  const [data, setData] = useState<McpData | null>(null);
  const [specs, setSpecs] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [newSpec, setNewSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<McpServer | null>(null);
  const [openUnbridged, setOpenUnbridged] = useState<string | null>(null);
  const [filter, setFilter] = useState<McpFilter>("all");

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

  const liveCount = data.servers.length;
  const unbridgedSpecs = (specs ?? []).filter((spec) => !data.servers.some((s) => s.spec === spec));
  const unbridgedCount = unbridgedSpecs.length;
  const showLive = filter !== "unbridged";
  const showUnbridged = filter !== "live";

  return html`
    <div class="sessions-grid">
      <div class="sessions-list">
        <div class="ssl-h" style="font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
          MCP servers · ${liveCount} bridged
        </div>
        <div style="padding:8px 12px 4px">
          <div class="chips">
            <span class=${`chip-f ${filter === "all" ? "active" : ""}`} onClick=${() => setFilter("all")}>all <span class="ct">${liveCount + unbridgedCount}</span></span>
            <span class=${`chip-f ${filter === "live" ? "active" : ""}`} onClick=${() => setFilter("live")}>live <span class="ct">${liveCount}</span></span>
            <span class=${`chip-f ${filter === "unbridged" ? "active" : ""}`} onClick=${() => setFilter("unbridged")}>unbridged <span class="ct">${unbridgedCount}</span></span>
          </div>
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
          ${
            liveCount === 0 && unbridgedCount === 0
              ? html`<div style="color:var(--fg-3);padding:14px;font-size:12px">
                No MCP servers in this session.
              </div>`
              : null
          }
          ${
            showLive
              ? data.servers.map(
                  (s) => html`
                  <div
                    class=${`ssl-row ${open?.label === s.label ? "sel" : ""}`}
                    onClick=${() => {
                      setOpen(s);
                      setOpenUnbridged(null);
                    }}
                  >
                    <span class="name">${s.label} <span class="pill ok">live</span></span>
                    <span class="preview">${specCommand(s.spec)}</span>
                    <span class="meta"><span><span class="v">${fmtNum(s.toolCount)}</span> tools</span></span>
                  </div>
                `,
                )
              : null
          }
          ${
            showUnbridged
              ? unbridgedSpecs.map(
                  (spec) => html`
                  <div
                    class=${`ssl-row ${openUnbridged === spec ? "sel" : ""}`}
                    onClick=${() => {
                      setOpenUnbridged(spec);
                      setOpen(null);
                    }}
                  >
                    <span class="name">${specLabel(spec)} <span class="pill">unbridged</span></span>
                    <span class="preview">${specCommand(spec)}</span>
                    <span class="meta"><span class="dim">in config · not loaded</span></span>
                  </div>
                `,
                )
              : null
          }
        </div>
      </div>

      <div class="sessions-detail">
        ${
          openUnbridged != null
            ? html`
              <div class="sessions-detail-h">
                <span class="name">${specLabel(openUnbridged)}</span>
                <span class="ws"><span class="pill">unbridged · in config</span></span>
                <span class="actions">
                  <button class="btn" disabled=${busy} onClick=${() => removeSpec(openUnbridged)}
                    style="border-color:var(--c-err);color:var(--c-err)">Remove</button>
                  <button class="btn ghost" onClick=${() => setOpenUnbridged(null)}>← back</button>
                </span>
              </div>
              <div class="card" style="margin-bottom:12px">
                <div class="card-h"><span class="title">spec</span></div>
                <code class="mono" style="font-size:11.5px;color:var(--fg-2);word-break:break-all">${openUnbridged}</code>
              </div>
              <div class="card accent-warn">
                <div class="card-h"><span class="title" style="color:var(--c-warn)">Why unbridged?</span></div>
                <div class="card-b" style="font-size:13px;line-height:1.6">
                  This spec lives in your <code class="mono">config.json</code> but isn't bridged into the live session.
                  MCP servers attach when <code class="mono">reasonix code</code> starts; the dashboard alone can't
                  spawn the child process.
                  <div style="margin-top:10px;color:var(--fg-3);font-size:12px">
                    To activate: restart <code class="mono">reasonix code</code>, then refresh this dashboard.
                  </div>
                </div>
              </div>
            `
            : open == null
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
                        (t) =>
                          html`<tr><td><code class="mono">${t.name}</code></td><td class="dim">${t.description ?? ""}</td></tr>`,
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
                              (r) =>
                                html`<tr><td>${r.name}</td><td class="path">${r.uri}</td></tr>`,
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
                              (p) =>
                                html`<tr><td><code class="mono">${p.name}</code></td><td class="dim">${p.description ?? ""}</td></tr>`,
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
