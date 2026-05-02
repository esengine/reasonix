import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { fmtBytes, fmtRelativeTime } from "../lib/format.js";
import { html } from "../lib/html.js";
import { t, useLang } from "../i18n/index.js";

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
  useLang();
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
        scope === "project"
          ? "/memory/project"
          : `/memory/${scope}/${encodeURIComponent(name ?? "")}`;
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
      setInfo(t("memory.saved", { scope: open.scope + (open.name ? `/${open.name}` : "") }));
      setTimeout(() => setInfo(null), 3000);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [open, body, load]);

  if (!tree && !error)
    return html`<div class="card" style="color:var(--fg-3)">${t("memory.loading")}</div>`;
  if (error && !tree) return html`<div class="card accent-err">${error}</div>`;
  if (!tree) return null;

  const fileRow = (scope: Scope, f: MemoryFile) => {
    const sel = open && open.scope === scope && open.name === f.name;
    return html`
      <div
        class=${`ssl-row ${sel ? "sel" : ""}`}
        onClick=${() => openFile(scope, f.name)}
      >
        <span class="name">${f.name}</span>
        <span class="meta">
          <span class="dim">${scope}</span>
          <span><span class="v">${fmtBytes(f.size)}</span></span>
          <span>${fmtRelativeTime(f.mtime)}</span>
        </span>
      </div>
    `;
  };

  const totalFiles =
    (tree.project.path ? 1 : 0) +
    tree.global.files.length +
    tree.projectMem.files.length;

  return html`
    <div class="sessions-grid">
      <div class="sessions-list">
        <div class="ssl-h" style="font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
          ${t("memory.files", { count: totalFiles })}
        </div>
        <div class="ssl-rows">
          ${
            tree.project.path
              ? html`
                <div
                  class=${`ssl-row ${open?.scope === "project" ? "sel" : ""}`}
                  onClick=${() => openFile("project")}
                >
                  <span class="name">
                    REASONIX.md
                    ${
                      tree.project.exists
                        ? html`<span class="pill ok">${t("memory.exists")}</span>`
                        : html`<span class="pill">${t("memory.create")}</span>`
                    }
                  </span>
                  <span class="preview">${tree.project.path}</span>
                  <span class="meta"><span class="dim">project</span></span>
                </div>
              `
              : null
          }
          ${tree.global.files.map((f) => fileRow("global", f))}
          ${tree.projectMem.files.map((f) => fileRow("project-mem", f))}
          ${
            (tree.global.files.length === 0 &&
              tree.projectMem.files.length === 0 &&
              !tree.project.path)
              ? html`<div style="color:var(--fg-3);padding:14px;font-size:12px">
                  ${t("memory.noFiles")}
                </div>`
              : null
          }
        </div>
      </div>

      <div class="sessions-detail">
        ${
          open == null
            ? html`<div style="color:var(--fg-3);font-size:13px;text-align:center;padding:60px 20px">
                ${t("memory.pickHint")}
                <div style="margin-top:12px;font-size:11.5px">
                  ${t("memory.pickDesc")}
                </div>
              </div>`
            : html`
                <div class="sessions-detail-h">
                  <span class="name">
                    ${open.scope}${open.name ? `/${open.name}` : ""}
                  </span>
                  <span class="ws">${t("memory.chars", { count: body.length.toLocaleString() })}</span>
                  <span class="actions">
                    <button class="btn primary" disabled=${busy} onClick=${save}>${t("common.save")}</button>
                    <button class="btn ghost" onClick=${() => setOpen(null)}>${t("common.back")}</button>
                  </span>
                </div>
                ${info ? html`<div style="margin-bottom:8px"><span class="pill ok">${info}</span></div>` : null}
                ${error ? html`<div class="card accent-err" style="margin-bottom:8px">${error}</div>` : null}
                <textarea
                  style="width:100%;min-height:480px;background:var(--bg-input);color:var(--fg-0);border:1px solid var(--bd);border-radius:var(--r);padding:12px;font-family:var(--font-mono);font-size:13px;line-height:1.55;resize:vertical"
                  value=${body}
                  onInput=${(e: Event) => setBody((e.target as HTMLTextAreaElement).value)}
                  disabled=${busy}
                ></textarea>
                <div style="margin-top:8px;color:var(--fg-3);font-size:11.5px">
                  ${t("memory.reloadHint")}
                </div>
              `
        }
      </div>
    </div>
  `;
}
