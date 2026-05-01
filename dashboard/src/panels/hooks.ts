import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { html } from "../lib/html.js";

interface ScopeMeta {
  path?: string | null;
  hooks?: Record<string, unknown>;
}

interface HooksData {
  resolved: unknown[];
  events: string[];
  project: ScopeMeta;
  global: ScopeMeta;
}

export function HooksPanel() {
  const [data, setData] = useState<HooksData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<HooksData>("/hooks");
      setData(r);
      setDrafts({
        project: JSON.stringify(r.project.hooks ?? {}, null, 2),
        global: JSON.stringify(r.global.hooks ?? {}, null, 2),
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveScope = useCallback(
    async (scope: "project" | "global") => {
      setBusy(true);
      setError(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(drafts[scope] ?? "{}");
      } catch (err) {
        setError(`${scope} JSON: ${(err as Error).message}`);
        setBusy(false);
        return;
      }
      try {
        await api("/hooks/save", { method: "POST", body: { scope, hooks: parsed } });
        await api("/hooks/reload", { method: "POST", body: {} });
        setInfo(`saved + reloaded ${scope}`);
        setTimeout(() => setInfo(null), 3000);
        await load();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [drafts, load],
  );

  if (!data && !error) return html`<div class="boot">loading hooks…</div>`;
  if (error && !data) return html`<div class="notice err">${error}</div>`;
  if (!data) return null;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Hooks</h2>
        <span class="panel-subtitle">${data.resolved.length} resolved · events: ${data.events.join(", ")}</span>
      </div>
      ${info ? html`<div class="notice">${info}</div>` : null}
      ${error ? html`<div class="notice err">${error}</div>` : null}
      ${(["project", "global"] as const).map((scope) => {
        const meta = data[scope];
        return html`
          <div class="section-title">${scope} — <code>${meta.path ?? "(no project)"}</code></div>
          ${
            scope === "project" && !meta.path
              ? html`<div class="empty">No active project — open <code>/dashboard</code> from <code>reasonix code</code> to edit project hooks.</div>`
              : html`
              <textarea
                style="width: 100%; height: 240px; font-family: var(--mono); font-size: 12.5px; background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px;"
                value=${drafts[scope] ?? ""}
                onInput=${(e: Event) =>
                  setDrafts({ ...drafts, [scope]: (e.target as HTMLTextAreaElement).value })}
                disabled=${busy}
              ></textarea>
              <div class="row" style="margin-top: 8px;">
                <button class="primary" disabled=${busy} onClick=${() => saveScope(scope)}>Save + Reload</button>
                <button disabled=${busy} onClick=${load}>Discard changes</button>
              </div>
            `
          }
        `;
      })}
    </div>
  `;
}
