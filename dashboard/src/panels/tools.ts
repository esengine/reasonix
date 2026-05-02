import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";
import { t, useLang } from "../i18n/index.js";

interface ToolEntry {
  name: string;
  description?: string;
  readOnly?: boolean;
  flattened?: boolean;
}

interface ToolsData {
  total: number;
  planMode?: boolean;
  tools: ToolEntry[];
}

interface ToolsError {
  status?: number;
  message: string;
  body?: { error?: string };
}

export function ToolsPanel() {
  useLang();
  const { data, error, loading } = usePoll<ToolsData>("/tools", 4000);
  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">${t("tools.loading")}</div>`;
  const e = error as ToolsError | null;
  if (e?.status === 503) {
    return html`<div class="card accent-warn">${e.body?.error ?? t("common.loadingFailed", { name: "tools", error: "" })}</div>`;
  }
  if (e) return html`<div class="card accent-err">${t("common.loadingFailed", { name: "tools", error: e.message })}</div>`;
  if (!data) return null;
  const d = data;

  return html`
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="chips">
        <span class="chip-f active">${t("common.all")} <span class="ct">${d.total}</span></span>
        ${d.planMode ? html`<span class="chip-f" style="border-color:var(--c-warn);color:var(--c-warn)">${t("tools.planMode")}</span>` : null}
      </div>

      ${
        d.tools.length === 0
          ? html`<div class="card" style="color:var(--fg-3)">${t("tools.noTools")}</div>`
          : html`
            <div class="card" style="padding:0;overflow:hidden">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>${t("tools.colTool")}</th>
                    <th>${t("tools.colFlags")}</th>
                    <th>${t("tools.colDesc")}</th>
                  </tr>
                </thead>
                <tbody>
                  ${d.tools.map(
                    (tool) => html`
                      <tr>
                        <td><code class="mono">${tool.name}</code></td>
                        <td>
                          ${tool.readOnly
                            ? html`<span class="pill ok">${t("tools.readOnly")}</span>`
                            : html`<span class="pill acc">${t("tools.write")}</span>`}
                          ${tool.flattened ? html` <span class="pill">${t("tools.flat")}</span>` : null}
                        </td>
                        <td class="dim">${tool.description ?? ""}</td>
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
