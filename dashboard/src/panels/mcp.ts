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

  if (!data && !error) return html`<div class="boot">loading MCP…</div>`;
  if (error && !data) return html`<div class="notice err">${error}</div>`;
  if (!data) return null;

  if (open) {
    return html`
      <div>
        <div class="panel-header">
          <h2 class="panel-title">MCP · ${open.label}</h2>
          <button onClick=${() => setOpen(null)} style="margin-left: auto;">← back</button>
        </div>
        <div class="card">
          <div class="row"><span class="card-title" style="margin: 0; flex: 0 0 110px;">spec</span><code>${open.spec}</code></div>
          <div class="row"><span class="card-title" style="margin: 0; flex: 0 0 110px;">server</span><span>${open.serverInfo?.name ?? "—"} ${open.serverInfo?.version ? `v${open.serverInfo.version}` : ""}</span></div>
          <div class="row"><span class="card-title" style="margin: 0; flex: 0 0 110px;">protocol</span><code>${open.protocolVersion}</code></div>
        </div>
        ${open.instructions ? html`<div class="notice">${open.instructions}</div>` : null}
        <div class="section-title">Tools (${open.tools.length})</div>
        <table>
          <thead><tr><th>name</th><th>description</th></tr></thead>
          <tbody>
            ${open.tools.map((t) => html`<tr><td><code>${t.name}</code></td><td>${t.description ?? ""}</td></tr>`)}
          </tbody>
        </table>
        ${
          open.resources.length > 0
            ? html`
          <div class="section-title">Resources (${open.resources.length})</div>
          <table>
            <thead><tr><th>name</th><th>uri</th></tr></thead>
            <tbody>
              ${open.resources.map((r) => html`<tr><td>${r.name}</td><td><code>${r.uri}</code></td></tr>`)}
            </tbody>
          </table>
        `
            : null
        }
        ${
          open.prompts.length > 0
            ? html`
          <div class="section-title">Prompts (${open.prompts.length})</div>
          <table>
            <thead><tr><th>name</th><th>description</th></tr></thead>
            <tbody>
              ${open.prompts.map((p) => html`<tr><td><code>${p.name}</code></td><td>${p.description ?? ""}</td></tr>`)}
            </tbody>
          </table>
        `
            : null
        }
      </div>
    `;
  }

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">MCP</h2>
        <span class="panel-subtitle">${data.servers.length} bridged · ${specs?.length ?? 0} in config</span>
      </div>
      ${info ? html`<div class="notice">${info}</div>` : null}
      ${error ? html`<div class="notice err">${error}</div>` : null}

      <div class="section-title">Add server</div>
      <div class="card row">
        <input
          type="text"
          placeholder='spec — e.g. "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe"'
          value=${newSpec}
          onInput=${(e: Event) => setNewSpec((e.target as HTMLInputElement).value)}
        />
        <button class="primary" disabled=${busy || !newSpec.trim()} onClick=${addSpec}>Add</button>
      </div>

      <div class="section-title">Bridged (${data.servers.length})</div>
      ${
        data.servers.length === 0
          ? html`<div class="empty">No MCP servers in this session.</div>`
          : html`
          <table>
            <thead><tr><th>label</th><th>spec</th><th class="numeric">tools</th><th></th></tr></thead>
            <tbody>
              ${data.servers.map(
                (s) => html`
                <tr key=${s.label} style="cursor: pointer;" onClick=${() => setOpen(s)}>
                  <td><code>${s.label}</code></td>
                  <td><code style="font-size: 11px;">${s.spec}</code></td>
                  <td class="numeric">${fmtNum(s.toolCount)}</td>
                  <td></td>
                </tr>
              `,
              )}
            </tbody>
          </table>
        `
      }

      <div class="section-title">Persisted specs (config.json)</div>
      ${
        (specs ?? []).length === 0
          ? html`<div class="empty">No MCP specs persisted in <code>~/.reasonix/config.json</code>.</div>`
          : html`
          <table>
            <thead><tr><th>spec</th><th></th></tr></thead>
            <tbody>
              ${(specs ?? []).map(
                (spec) => html`
                <tr key=${spec}>
                  <td><code>${spec}</code></td>
                  <td class="numeric">
                    <button class="danger" disabled=${busy} onClick=${(e: Event) => {
                      e.stopPropagation();
                      removeSpec(spec);
                    }}>remove</button>
                  </td>
                </tr>
              `,
              )}
            </tbody>
          </table>
        `
      }
    </div>
  `;
}
