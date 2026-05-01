import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { html } from "../lib/html.js";

interface SettingsData {
  apiKey?: string | null;
  baseUrl?: string;
  preset?: string;
  reasoningEffort?: string;
  search?: boolean;
  model?: string;
  editMode?: string;
}

export function SettingsPanel() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<SettingsData>>({});

  const load = useCallback(async () => {
    try {
      const r = await api<SettingsData>("/settings");
      setData(r);
      setDraft({});
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (fields: Partial<SettingsData>) => {
      setSaving(true);
      setError(null);
      try {
        await api("/settings", { method: "POST", body: fields });
        await load();
        setSaved(`saved: ${Object.keys(fields).join(", ")}`);
        setTimeout(() => setSaved(null), 3000);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  if (!data && !error)
    return html`<div class="card" style="color:var(--fg-3)">loading settings…</div>`;
  if (error && !data) return html`<div class="card accent-err">${error}</div>`;
  if (!data) return null;
  const v = data;

  const sectionH3 = (text: string) => html`
    <h3 style="margin:18px 0 8px;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">${text}</h3>
  `;
  const fieldRow = (
    label: string,
    control: unknown,
    note?: string,
  ) => html`
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="flex:0 0 110px;font-family:var(--font-mono);font-size:11.5px;color:var(--fg-3)">${label}</span>
      <div style="flex:1;display:flex;align-items:center;gap:8px">${control}</div>
      ${note ? html`<span style="color:var(--fg-3);font-size:11px">${note}</span>` : null}
    </div>
  `;

  return html`
    <div style="max-width:760px;display:flex;flex-direction:column;gap:6px">
      ${
        saved ? html`<div><span class="pill ok">${saved}</span></div>` : null
      }
      ${
        error ? html`<div class="card accent-err">${error}</div>` : null
      }

      ${sectionH3("DeepSeek API")}
      <div class="card">
        ${fieldRow(
          "API key",
          html`<code class="mono" style="color:var(--fg-2);font-size:11.5px">${v.apiKey ?? "(not set)"}</code>`,
        )}
        ${fieldRow(
          "replace",
          html`
            <input
              type="password"
              placeholder="paste a fresh sk-… token"
              value=${draft.apiKey ?? ""}
              onInput=${(e: Event) => setDraft({ ...draft, apiKey: (e.target as HTMLInputElement).value })}
              style="flex:1"
            />
            <button
              class="btn primary"
              disabled=${saving || !(draft.apiKey ?? "").trim()}
              onClick=${() => save({ apiKey: draft.apiKey })}
            >Save key</button>
          `,
        )}
        ${fieldRow(
          "base url",
          html`
            <input
              type="text"
              value=${draft.baseUrl ?? v.baseUrl ?? ""}
              placeholder="https://api.deepseek.com (default)"
              onInput=${(e: Event) => setDraft({ ...draft, baseUrl: (e.target as HTMLInputElement).value })}
              style="flex:1"
            />
            <button
              class="btn"
              disabled=${saving || (draft.baseUrl ?? v.baseUrl ?? "") === (v.baseUrl ?? "")}
              onClick=${() => save({ baseUrl: draft.baseUrl })}
            >Save</button>
          `,
        )}
      </div>

      ${sectionH3("Defaults")}
      <div class="card">
        ${fieldRow(
          "preset",
          html`
            <select
              value=${["auto", "flash", "pro"].includes(v.preset ?? "") ? v.preset : "auto"}
              onChange=${(e: Event) => save({ preset: (e.target as HTMLSelectElement).value })}
              disabled=${saving}
            >
              <option value="auto">auto — flash → pro on hard turns</option>
              <option value="flash">flash — always flash, no auto-escalate</option>
              <option value="pro">pro — always pro</option>
            </select>
          `,
          "applies next turn",
        )}
        ${fieldRow(
          "effort",
          html`
            <select
              value=${v.reasoningEffort}
              onChange=${(e: Event) => save({ reasoningEffort: (e.target as HTMLSelectElement).value })}
              disabled=${saving}
            >
              <option value="max">max (default — best)</option>
              <option value="high">high (cheaper / faster)</option>
            </select>
          `,
          "applies next turn",
        )}
        ${fieldRow(
          "web search",
          html`
            <button
              class=${`btn ${v.search ? "primary" : ""}`}
              onClick=${() => save({ search: !v.search })}
              disabled=${saving}
            >${v.search ? "ON" : "off"}</button>
          `,
          "web_fetch + web_search tools",
        )}
      </div>

      ${sectionH3("Runtime")}
      <div class="card">
        ${fieldRow(
          "active model",
          html`<code class="mono">${v.model ?? "—"}</code>`,
        )}
        ${fieldRow(
          "edit mode",
          html`<code class="mono">${v.editMode}</code>`,
          "switch from the Chat tab header",
        )}
      </div>
    </div>
  `;
}
