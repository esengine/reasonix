import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { fmtBytes, fmtRelativeTime } from "../lib/format.js";
import { html } from "../lib/html.js";

interface MemoryFile {
  name: string;
  size: number;
  mtime: string | number;
}

interface MemoryTree {
  project: { path?: string | null; exists?: boolean };
  global: { files: MemoryFile[] };
  projectMem: { path?: string | null; files: MemoryFile[] };
}

type Scope = "project" | "global" | "project-mem";

export function MemoryPanel() {
  const [tree, setTree] = useState<MemoryTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ scope: Scope; name?: string } | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTree(await api<MemoryTree>("/memory"));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const openFile = useCallback(async (scope: Scope, name?: string) => {
    setOpen({ scope, name });
    setBusy(true);
    try {
      const path =
        scope === "project" ? "/memory/project" : `/memory/${scope}/${encodeURIComponent(name ?? "")}`;
      const r = await api<{ body: string }>(path);
      setBody(r.body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (!open) return;
    setBusy(true);
    setError(null);
    try {
      const path =
        open.scope === "project"
          ? "/memory/project"
          : `/memory/${open.scope}/${encodeURIComponent(open.name ?? "")}`;
      await api(path, { method: "POST", body: { body } });
      setInfo(`saved ${open.scope}${open.name ? `/${open.name}` : ""}`);
      setTimeout(() => setInfo(null), 3000);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [open, body, load]);

  if (!tree && !error) return html`<div class="boot">loading memory…</div>`;
  if (error && !tree) return html`<div class="notice err">${error}</div>`;
  if (!tree) return null;

  if (open) {
    return html`
      <div>
        <div class="panel-header">
          <h2 class="panel-title">Memory · ${open.scope}${open.name ? `/${open.name}` : ""}</h2>
          <button onClick=${() => setOpen(null)} style="margin-left: auto;">← back</button>
        </div>
        ${info ? html`<div class="notice">${info}</div>` : null}
        ${error ? html`<div class="notice err">${error}</div>` : null}
        <textarea
          style="width: 100%; height: 480px; font-family: var(--mono); font-size: 13px; background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px;"
          value=${body}
          onInput=${(e: Event) => setBody((e.target as HTMLTextAreaElement).value)}
          disabled=${busy}
        ></textarea>
        <div class="row" style="margin-top: 8px;">
          <button class="primary" disabled=${busy} onClick=${save}>Save</button>
          <span class="muted" style="font-size: 12px;">${body.length.toLocaleString()} chars · re-applied on next /new or session restart</span>
        </div>
      </div>
    `;
  }

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Memory</h2>
        <span class="panel-subtitle">REASONIX.md (committable) + private notes (~/.reasonix/memory)</span>
      </div>
      <div class="section-title">Project — REASONIX.md</div>
      ${
        tree.project.path
          ? html`
          <div class="card row" style="cursor: pointer;" onClick=${() => openFile("project")}>
            <span><code>${tree.project.path}</code></span>
            <span class="pill ${tree.project.exists ? "pill-ok" : "pill-dim"}" style="margin-left: auto;">
              ${tree.project.exists ? "exists" : "create"}
            </span>
          </div>
        `
          : html`<div class="empty">No active project.</div>`
      }

      <div class="section-title">Global — ~/.reasonix/memory/global</div>
      ${
        tree.global.files.length === 0
          ? html`<div class="empty">No global memory files yet.</div>`
          : html`
          <table>
            <thead><tr><th>name</th><th class="numeric">size</th><th class="numeric">touched</th></tr></thead>
            <tbody>
              ${tree.global.files.map(
                (f) => html`
                <tr key=${f.name} style="cursor: pointer;" onClick=${() => openFile("global", f.name)}>
                  <td><code>${f.name}</code></td>
                  <td class="numeric">${fmtBytes(f.size)}</td>
                  <td class="numeric muted">${fmtRelativeTime(f.mtime)}</td>
                </tr>
              `,
              )}
            </tbody>
          </table>
        `
      }

      ${
        tree.projectMem.path
          ? html`
          <div class="section-title">Project private — ~/.reasonix/memory/&lt;hash&gt;</div>
          ${
            tree.projectMem.files.length === 0
              ? html`<div class="empty">No project-private memory yet.</div>`
              : html`
              <table>
                <thead><tr><th>name</th><th class="numeric">size</th><th class="numeric">touched</th></tr></thead>
                <tbody>
                  ${tree.projectMem.files.map(
                    (f) => html`
                    <tr key=${f.name} style="cursor: pointer;" onClick=${() => openFile("project-mem", f.name)}>
                      <td><code>${f.name}</code></td>
                      <td class="numeric">${fmtBytes(f.size)}</td>
                      <td class="numeric muted">${fmtRelativeTime(f.mtime)}</td>
                    </tr>
                  `,
                  )}
                </tbody>
              </table>
            `
          }
        `
          : null
      }
    </div>
  `;
}
