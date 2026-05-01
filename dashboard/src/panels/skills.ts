import { useCallback, useEffect, useState } from "https://esm.sh/preact@10.22.0/hooks";
import { api } from "../lib/api.js";
import { html } from "../lib/html.js";

interface SkillEntry {
  name: string;
  description?: string;
}

interface SkillsData {
  paths: { project?: string };
  project: SkillEntry[];
  global: SkillEntry[];
  builtin: SkillEntry[];
}

type Scope = "project" | "global" | "builtin";

export function SkillsPanel() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ scope: Scope; name: string } | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<"global" | "project">("global");

  const load = useCallback(async () => {
    try {
      setData(await api<SkillsData>("/skills"));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const openSkill = useCallback(async (scope: Scope, name: string) => {
    setOpen({ scope, name });
    setBusy(true);
    try {
      const r = await api<{ body: string }>(`/skills/${scope}/${encodeURIComponent(name)}`);
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
    try {
      await api(`/skills/${open.scope}/${encodeURIComponent(open.name)}`, {
        method: "POST",
        body: { body },
      });
      setInfo(`saved ${open.scope}/${open.name}`);
      setTimeout(() => setInfo(null), 3000);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [open, body, load]);

  const remove = useCallback(async () => {
    if (!open) return;
    if (!confirm(`Delete skill ${open.scope}/${open.name}?`)) return;
    setBusy(true);
    try {
      await api(`/skills/${open.scope}/${encodeURIComponent(open.name)}`, { method: "DELETE" });
      setOpen(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [open, load]);

  const create = useCallback(async () => {
    if (!newName.trim()) return;
    setBusy(true);
    const stub = `---\nname: ${newName.trim()}\ndescription: TODO — one-line description that helps the model match this skill\n---\n\n# ${newName.trim()}\n\n`;
    try {
      await api(`/skills/${newScope}/${encodeURIComponent(newName.trim())}`, {
        method: "POST",
        body: { body: stub },
      });
      setNewName("");
      await load();
      openSkill(newScope, newName.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [newName, newScope, load, openSkill]);

  if (!data && !error) return html`<div class="boot">loading skills…</div>`;
  if (error && !data) return html`<div class="notice err">${error}</div>`;
  if (!data) return null;

  if (open) {
    return html`
      <div>
        <div class="panel-header">
          <h2 class="panel-title">Skill · ${open.scope}/${open.name}</h2>
          <button onClick=${() => setOpen(null)} style="margin-left: auto;">← back</button>
        </div>
        ${info ? html`<div class="notice">${info}</div>` : null}
        ${error ? html`<div class="notice err">${error}</div>` : null}
        <textarea
          style="width: 100%; height: 520px; font-family: var(--mono); font-size: 13px; background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px;"
          value=${body}
          onInput=${(e: Event) => setBody((e.target as HTMLTextAreaElement).value)}
          disabled=${busy}
        ></textarea>
        <div class="row" style="margin-top: 8px;">
          <button class="primary" disabled=${busy} onClick=${save}>Save</button>
          <button class="danger" disabled=${busy} onClick=${remove}>Delete</button>
          <span class="muted" style="font-size: 12px; margin-left: auto;">re-loaded on next /new or session restart</span>
        </div>
      </div>
    `;
  }

  const renderList = (label: string, items: SkillEntry[], scope: Scope) => html`
    <div class="section-title">${label} (${items.length})</div>
    ${
      items.length === 0
        ? html`<div class="empty">none</div>`
        : html`
        <table>
          <thead><tr><th>name</th><th>description</th><th></th></tr></thead>
          <tbody>
            ${items.map(
              (s) => html`
              <tr key=${s.name} style="cursor: ${scope === "builtin" ? "default" : "pointer"};" onClick=${() => scope !== "builtin" && openSkill(scope, s.name)}>
                <td><code>${s.name}</code></td>
                <td>${s.description ?? html`<span class="muted">(no description)</span>`}</td>
                <td>${scope === "builtin" ? html`<span class="pill pill-dim">builtin</span>` : null}</td>
              </tr>
            `,
            )}
          </tbody>
        </table>
      `
    }
  `;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Skills</h2>
        <span class="panel-subtitle">click to edit · creates land in next /new</span>
      </div>
      ${error ? html`<div class="notice err">${error}</div>` : null}

      <div class="section-title">Create new</div>
      <div class="card row">
        <select value=${newScope} onChange=${(e: Event) => setNewScope((e.target as HTMLSelectElement).value as "global" | "project")}>
          <option value="global">global</option>
          ${data.paths.project ? html`<option value="project">project</option>` : null}
        </select>
        <input
          type="text"
          placeholder="skill-name"
          value=${newName}
          onInput=${(e: Event) => setNewName((e.target as HTMLInputElement).value)}
        />
        <button class="primary" disabled=${busy || !newName.trim()} onClick=${create}>Create</button>
      </div>

      ${renderList("Project", data.project, "project")}
      ${renderList("Global", data.global, "global")}
      ${renderList("Builtin (read-only)", data.builtin, "builtin")}
    </div>
  `;
}
