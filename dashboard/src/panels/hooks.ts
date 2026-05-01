import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { fmtRelativeTime } from "../lib/format.js";
import { html } from "../lib/html.js";

interface HookHandler {
  command?: string;
  matcher?: string;
  [k: string]: unknown;
}

interface HookRunRow {
  hookName: string;
  phase: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
  outcome: "ok" | "blocked" | "modified" | "error";
  whenMs: number;
}

interface ScopeMeta {
  path?: string | null;
  hooks?: Record<string, HookHandler[]>;
}

interface MatrixCell {
  on: boolean;
  matcher?: string;
}

interface MatrixRow {
  scope: "project" | "global";
  command: string;
  cells: Record<string, MatrixCell>;
}

function buildMatrix(data: HooksData): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  for (const scope of ["project", "global"] as const) {
    const hooks = data[scope].hooks ?? {};
    for (const [event, handlers] of Object.entries(hooks)) {
      for (const h of handlers ?? []) {
        const cmd = h.command ?? "(no command)";
        const key = `${scope}::${cmd}`;
        let row = rows.get(key);
        if (!row) {
          row = { scope, command: cmd, cells: {} };
          rows.set(key, row);
        }
        row.cells[event] = { on: true, matcher: h.matcher };
      }
    }
  }
  return [...rows.values()];
}

interface HooksData {
  resolved: unknown[];
  events: string[];
  project: ScopeMeta;
  global: ScopeMeta;
  recentRuns?: ReadonlyArray<HookRunRow> | null;
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

  if (!data && !error)
    return html`<div class="card" style="color:var(--fg-3)">loading hooks…</div>`;
  if (error && !data) return html`<div class="card accent-err">${error}</div>`;
  if (!data) return null;

  const sectionH3 = (text: string, sub?: string) => html`
    <h3 style="margin:18px 0 8px;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
      ${text}${sub ? html`<span style="margin-left:10px;color:var(--fg-4);font-weight:400;text-transform:none;letter-spacing:0">${sub}</span>` : null}
    </h3>
  `;

  const matrixRows = buildMatrix(data);
  const events =
    data.events.length > 0
      ? data.events
      : Array.from(new Set(matrixRows.flatMap((r) => Object.keys(r.cells))));
  const gridCols = `220px repeat(${Math.max(events.length, 1)}, minmax(0, 1fr))`;

  return html`
    <div style="display:flex;flex-direction:column;gap:6px">
      <div class="chips">
        <span class="chip-f active">resolved <span class="ct">${data.resolved.length}</span></span>
        ${data.events.map((ev) => html`<span class="chip-f">${ev}</span>`)}
      </div>
      ${info ? html`<div><span class="pill ok">${info}</span></div>` : null}
      ${error ? html`<div class="card accent-err">${error}</div>` : null}

      ${sectionH3("Event matrix", `${matrixRows.length} script${matrixRows.length === 1 ? "" : "s"} × ${events.length} event${events.length === 1 ? "" : "s"}`)}
      ${
        matrixRows.length === 0
          ? html`<div class="card" style="color:var(--fg-3)">
              No hooks configured. Edit the JSON below to add some.
            </div>`
          : html`
            <div class="card" style="padding:10px 14px;overflow-x:auto">
              <div class="matrix" style=${`min-width:fit-content`}>
                <div class="row h" style=${`grid-template-columns:${gridCols}`}>
                  <div>script</div>
                  ${events.map((ev) => html`<div>${ev}</div>`)}
                </div>
                ${matrixRows.map(
                  (r) => html`
                    <div class="row" style=${`grid-template-columns:${gridCols}`}>
                      <div class="cell" title=${r.command}>
                        <span style="color:var(--fg-4);font-size:10px;margin-right:6px">${r.scope}</span>
                        <code class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.command}</code>
                      </div>
                      ${events.map((ev) => {
                        const c = r.cells[ev];
                        if (!c?.on) return html`<div class="cell off">—</div>`;
                        return html`
                          <div class="cell on" title=${c.matcher ?? ""}>
                            ${c.matcher ? html`<span style="font-size:10px;color:var(--c-warn)">${c.matcher}</span>` : "✓"}
                          </div>
                        `;
                      })}
                    </div>
                  `,
                )}
              </div>
            </div>
          `
      }

      ${(["project", "global"] as const).map((scope) => {
        const meta = data[scope];
        return html`
          ${sectionH3(scope, meta.path ?? "(no path)")}
          ${
            scope === "project" && !meta.path
              ? html`<div class="card" style="color:var(--fg-3)">
                  No active project — open <code class="mono">/dashboard</code> from
                  <code class="mono">reasonix code</code> to edit project hooks.
                </div>`
              : html`
                <div class="card">
                  <textarea
                    style="width:100%;height:240px;background:var(--bg-input);color:var(--fg-0);border:1px solid var(--bd);border-radius:var(--r);padding:10px;font-family:var(--font-mono);font-size:12.5px;line-height:1.55;resize:vertical"
                    value=${drafts[scope] ?? ""}
                    onInput=${(e: Event) =>
                      setDrafts({ ...drafts, [scope]: (e.target as HTMLTextAreaElement).value })}
                    disabled=${busy}
                  ></textarea>
                  <div style="display:flex;gap:6px;margin-top:8px">
                    <button class="btn primary" disabled=${busy} onClick=${() => saveScope(scope)}>
                      Save + Reload
                    </button>
                    <button class="btn ghost" disabled=${busy} onClick=${load}>Discard changes</button>
                  </div>
                </div>
              `
          }
        `;
      })}

      ${sectionH3("Recent runs", `${data.recentRuns?.length ?? 0}`)}
      ${
        !data.recentRuns || data.recentRuns.length === 0
          ? html`<div class="card" style="color:var(--fg-3)">
              No hook runs in the recent session log.
            </div>`
          : html`
            <div class="card" style="padding:0;overflow-x:auto">
              <table class="tbl" style="width:100%;font-family:var(--font-mono);font-size:11.5px">
                <thead>
                  <tr>
                    <th style="text-align:left;padding:8px 12px">when</th>
                    <th style="text-align:left;padding:8px 12px">phase</th>
                    <th style="text-align:left;padding:8px 12px">hook</th>
                    <th style="text-align:left;padding:8px 12px">outcome</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.recentRuns.map(
                    (r) => html`
                      <tr>
                        <td style="padding:6px 12px;color:var(--fg-3)">${fmtRelativeTime(r.whenMs)}</td>
                        <td style="padding:6px 12px;color:var(--fg-1)">${r.phase}</td>
                        <td style="padding:6px 12px;color:var(--fg-1)">${r.hookName}</td>
                        <td style="padding:6px 12px">
                          <span class=${`pill ${r.outcome === "ok" ? "ok" : r.outcome === "error" ? "err" : "warn"}`}>${r.outcome}</span>
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `
      }
    </div>
  `;
}
