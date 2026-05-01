import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";

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
  const { data, error, loading } = usePoll<ToolsData>("/tools", 4000);
  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">loading tools…</div>`;
  const e = error as ToolsError | null;
  if (e?.status === 503) {
    return html`<div class="card accent-warn">${e.body?.error ?? "live tools view requires an attached session"}</div>`;
  }
  if (e) return html`<div class="card accent-err">tools failed: ${e.message}</div>`;
  if (!data) return null;
  const t = data;

  return html`
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="chips">
        <span class="chip-f active">all <span class="ct">${t.total}</span></span>
        ${t.planMode ? html`<span class="chip-f" style="border-color:var(--c-warn);color:var(--c-warn)">plan mode — writes gated</span>` : null}
      </div>

      ${
        t.tools.length === 0
          ? html`<div class="card" style="color:var(--fg-3)">No tools registered.</div>`
          : html`
            <div class="card" style="padding:0;overflow:hidden">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>tool</th>
                    <th>flags</th>
                    <th>description</th>
                  </tr>
                </thead>
                <tbody>
                  ${t.tools.map(
                    (tool) => html`
                      <tr>
                        <td><code class="mono">${tool.name}</code></td>
                        <td>
                          ${tool.readOnly
                            ? html`<span class="pill ok">read-only</span>`
                            : html`<span class="pill acc">write</span>`}
                          ${tool.flattened ? html` <span class="pill">flat</span>` : null}
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
