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
  if (loading && !data) return html`<div class="boot">loading tools…</div>`;
  const e = error as ToolsError | null;
  if (e?.status === 503) {
    return html`<div class="notice">${e.body?.error ?? "live tools view requires an attached session"}</div>`;
  }
  if (e) return html`<div class="notice err">tools failed: ${e.message}</div>`;
  if (!data) return null;
  const t = data;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Tools</h2>
        <span class="panel-subtitle">${t.total} registered ${t.planMode ? html`<span class="pill pill-warn">plan mode — writes gated</span>` : ""}</span>
      </div>
      ${
        t.tools.length === 0
          ? html`<div class="empty">No tools registered.</div>`
          : html`
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>flags</th>
                <th>description</th>
              </tr>
            </thead>
            <tbody>
              ${t.tools.map(
                (tool) => html`
                <tr>
                  <td><code>${tool.name}</code></td>
                  <td>
                    ${tool.readOnly ? html`<span class="pill pill-ok">read-only</span>` : html`<span class="pill pill-accent">write</span>`}
                    ${tool.flattened ? html` <span class="pill pill-dim">flat</span>` : ""}
                  </td>
                  <td>${tool.description ?? ""}</td>
                </tr>
              `,
              )}
            </tbody>
          </table>
        `
      }
    </div>
  `;
}
