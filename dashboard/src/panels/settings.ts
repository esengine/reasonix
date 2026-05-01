import { useCallback, useEffect, useState } from "https://esm.sh/preact@10.22.0/hooks";
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

  if (!data && !error) return html`<div class="boot">loading settings…</div>`;
  if (error && !data) return html`<div class="notice err">${error}</div>`;
  if (!data) return null;
  const v = data;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Settings</h2>
        <span class="panel-subtitle">~/.reasonix/config.json · most fields apply next session</span>
      </div>
      ${saved ? html`<div class="notice">${saved}</div>` : null}
      ${error ? html`<div class="notice err">${error}</div>` : null}

      <div class="section-title">DeepSeek API</div>
      <div class="card">
        <div class="row">
          <span class="card-title" style="margin: 0;">API key</span>
          <code style="margin-left: auto;">${v.apiKey ?? "(not set)"}</code>
        </div>
        <div class="row" style="margin-top: 8px;">
          <input
            type="password"
            placeholder="paste a fresh sk-… token to replace"
            value=${draft.apiKey ?? ""}
            onInput=${(e: Event) => setDraft({ ...draft, apiKey: (e.target as HTMLInputElement).value })}
          />
          <button
            class="primary"
            disabled=${saving || !(draft.apiKey ?? "").trim()}
            onClick=${() => save({ apiKey: draft.apiKey })}
          >Save key</button>
        </div>
        <div class="row" style="margin-top: 12px;">
          <span class="card-title" style="margin: 0;">Base URL</span>
          <input
            type="text"
            value=${draft.baseUrl ?? v.baseUrl ?? ""}
            placeholder="https://api.deepseek.com (default)"
            onInput=${(e: Event) => setDraft({ ...draft, baseUrl: (e.target as HTMLInputElement).value })}
          />
          <button
            disabled=${saving || (draft.baseUrl ?? v.baseUrl ?? "") === (v.baseUrl ?? "")}
            onClick=${() => save({ baseUrl: draft.baseUrl })}
          >Save</button>
        </div>
      </div>

      <div class="section-title">Defaults</div>
      <div class="card">
        <div class="row">
          <span class="card-title" style="margin: 0; flex: 0 0 110px;">Preset</span>
          <select
            value=${["auto", "flash", "pro"].includes(v.preset ?? "") ? v.preset : "auto"}
            onChange=${(e: Event) => save({ preset: (e.target as HTMLSelectElement).value })}
            disabled=${saving}
          >
            <option value="auto">auto — flash → pro on hard turns (default)</option>
            <option value="flash">flash — always flash, no auto-escalate</option>
            <option value="pro">pro — always pro</option>
          </select>
          <span class="muted" style="margin-left: auto; font-size: 12px;">applies next turn</span>
        </div>
        <div class="row" style="margin-top: 12px;">
          <span class="card-title" style="margin: 0; flex: 0 0 110px;">Effort</span>
          <select
            value=${v.reasoningEffort}
            onChange=${(e: Event) => save({ reasoningEffort: (e.target as HTMLSelectElement).value })}
            disabled=${saving}
          >
            <option value="max">max (default — best)</option>
            <option value="high">high (cheaper / faster)</option>
          </select>
          <span class="muted" style="margin-left: auto; font-size: 12px;">applies next turn</span>
        </div>
        <div class="row" style="margin-top: 12px;">
          <span class="card-title" style="margin: 0; flex: 0 0 110px;">Web search</span>
          <button
            class=${v.search ? "primary" : ""}
            onClick=${() => save({ search: !v.search })}
            disabled=${saving}
          >${v.search ? "ON" : "off"}</button>
          <span class="muted" style="margin-left: auto; font-size: 12px;">web_fetch + web_search tools</span>
        </div>
      </div>

      <div class="section-title">Runtime</div>
      <div class="card">
        <div class="row">
          <span class="card-title" style="margin: 0; flex: 0 0 110px;">Active model</span>
          <code>${v.model ?? "—"}</code>
        </div>
        <div class="row" style="margin-top: 8px;">
          <span class="card-title" style="margin: 0; flex: 0 0 110px;">Edit mode</span>
          <code>${v.editMode}</code>
          <span class="muted" style="margin-left: auto; font-size: 12px;">switch from the Chat tab header</span>
        </div>
      </div>
    </div>
  `;
}
