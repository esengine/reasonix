import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { html } from "../lib/html.js";

interface SkillEntry {
  name: string;
  description?: string;
  runs7d?: number;
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
  const [filter, setFilter] = useState("");

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
    if (scope === "builtin") {
      setBody("");
      return;
    }
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

  if (!data && !error)
    return html`<div class="card" style="color:var(--fg-3)">loading skills…</div>`;
  if (error && !data) return html`<div class="card accent-err">${error}</div>`;
  if (!data) return null;

  const allWith = [
    ...data.project.map((s) => ({ scope: "project" as Scope, ...s })),
    ...data.global.map((s) => ({ scope: "global" as Scope, ...s })),
    ...data.builtin.map((s) => ({ scope: "builtin" as Scope, ...s })),
  ];
  const filtered = filter.trim()
    ? allWith.filter(
        (s) =>
          s.name.toLowerCase().includes(filter.toLowerCase()) ||
          (s.description ?? "").toLowerCase().includes(filter.toLowerCase()),
      )
    : allWith;

  return html`
    <div class="sessions-grid">
      <div class="sessions-list">
        <div class="ssl-h">
          <input
            type="text"
            placeholder="filter skills"
            value=${filter}
            onInput=${(e: Event) => setFilter((e.target as HTMLInputElement).value)}
            style="flex:1"
          />
        </div>
        <div class="chips" style="padding:0 12px 8px">
          <span class="chip-f active">all <span class="ct">${allWith.length}</span></span>
          <span class="chip-f">project <span class="ct">${data.project.length}</span></span>
          <span class="chip-f">global <span class="ct">${data.global.length}</span></span>
          <span class="chip-f">builtin <span class="ct">${data.builtin.length}</span></span>
        </div>

        <div style="padding:0 12px 8px;display:flex;gap:6px;flex-wrap:wrap">
          <select
            value=${newScope}
            onChange=${(e: Event) => setNewScope((e.target as HTMLSelectElement).value as "global" | "project")}
            style="flex:0 0 auto;font-size:11.5px;padding:5px 6px"
          >
            <option value="global">global</option>
            ${data.paths.project ? html`<option value="project">project</option>` : null}
          </select>
          <input
            type="text"
            placeholder="new skill"
            value=${newName}
            onInput=${(e: Event) => setNewName((e.target as HTMLInputElement).value)}
            style="flex:1;min-width:0"
          />
          <button class="btn primary" disabled=${busy || !newName.trim()} onClick=${create} style="flex:0 0 auto">+</button>
        </div>

        <div class="ssl-rows">
          ${filtered.map((s) => {
            const sel = open?.scope === s.scope && open?.name === s.name;
            return html`
              <div
                class=${`ssl-row ${sel ? "sel" : ""}`}
                onClick=${() => openSkill(s.scope, s.name)}
              >
                <span class="name">
                  ${s.name}
                  ${s.scope === "builtin" ? html`<span class="pill">builtin</span>` : null}
                </span>
                <span class="preview">${s.description ?? "(no description)"}</span>
                <span class="meta">
                  ${
                    typeof s.runs7d === "number" && s.runs7d > 0
                      ? html`<span><span class="v">${s.runs7d}</span> runs · 7d</span>`
                      : null
                  }
                  <span class="dim">${s.scope}</span>
                </span>
              </div>
            `;
          })}
        </div>
      </div>

      <div class="sessions-detail">
        ${
          open == null
            ? html`<div style="color:var(--fg-3);font-size:13px;text-align:center;padding:60px 20px">
                Pick a skill on the left, or create a new one above.
              </div>`
            : open.scope === "builtin"
              ? (() => {
                  const builtin = data.builtin.find((b) => b.name === open.name);
                  return html`
                    <div class="sessions-detail-h">
                      <span class="name">${open.scope}/${open.name}</span>
                      <span class="ws"><span class="pill">read-only · builtin</span></span>
                      <span class="actions">
                        <button class="btn ghost" onClick=${() => setOpen(null)}>← back</button>
                      </span>
                    </div>
                    <div style="color:var(--fg-2);font-size:13px;line-height:1.6">
                      ${builtin?.description ?? "(no description)"}
                    </div>
                    <div style="margin-top:14px;color:var(--fg-3);font-size:11.5px">
                      Built-in skills ship with Reasonix; the model picks them up automatically. To customize, create a project- or global-scoped skill with the same name.
                    </div>
                  `;
                })()
              : html`
                <div class="sessions-detail-h">
                  <span class="name">${open.scope}/${open.name}</span>
                  <span class="ws">${body.length.toLocaleString()} chars</span>
                  <span class="actions">
                    <button class="btn primary" disabled=${busy} onClick=${save}>Save</button>
                    <button class="btn" disabled=${busy} onClick=${remove}
                      style="border-color:var(--c-err);color:var(--c-err)">Delete</button>
                    <button class="btn ghost" onClick=${() => setOpen(null)}>← back</button>
                  </span>
                </div>
                ${info ? html`<div style="margin-bottom:8px"><span class="pill ok">${info}</span></div>` : null}
                ${error ? html`<div class="card accent-err" style="margin-bottom:8px">${error}</div>` : null}
                <textarea
                  style="width:100%;min-height:520px;background:var(--bg-input);color:var(--fg-0);border:1px solid var(--bd);border-radius:var(--r);padding:12px;font-family:var(--font-mono);font-size:13px;line-height:1.55;resize:vertical"
                  value=${body}
                  onInput=${(e: Event) => setBody((e.target as HTMLTextAreaElement).value)}
                  disabled=${busy}
                ></textarea>
                <div style="margin-top:8px;color:var(--fg-3);font-size:11.5px">
                  re-loaded on next <code class="mono">/new</code> or session restart
                </div>
              `
        }
      </div>
    </div>
  `;
}
