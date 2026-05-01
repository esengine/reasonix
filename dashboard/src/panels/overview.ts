import { MetricCard } from "../components/metric-card.js";
import { fmtNum } from "../lib/format.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";

interface OverviewData {
  mode: "standalone" | "attached";
  version?: string;
  latestVersion?: string;
  session?: string | null;
  model?: string;
  editMode?: string;
  planMode?: boolean | null;
  pendingEdits?: number;
  mcpServerCount?: number;
  toolCount?: number;
  cwd?: string;
}

export function OverviewPanel() {
  const { data, error, loading } = usePoll<OverviewData>("/overview", 2000);
  if (loading && !data) return html`<div class="boot">loading overview…</div>`;
  if (error) return html`<div class="notice err">overview failed: ${error.message}</div>`;
  const o = data;
  if (!o) return null;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Live Cockpit</h2>
        <span class="panel-subtitle">${o.mode === "attached" ? "attached to running session" : "standalone (read-only disk view)"}</span>
      </div>

      ${o.mode === "standalone" ? html`<div class="notice">Standalone mode — start <code>/dashboard</code> from inside <code>reasonix code</code> for live session state, MCP, and tools.</div>` : null}

      <div class="metric-grid">
        ${MetricCard("Reasonix", o.version, o.latestVersion && o.latestVersion !== o.version ? `latest: ${o.latestVersion}` : "current")}
        ${MetricCard("Session", o.session ?? "—", o.session === null ? "ephemeral or disconnected" : null)}
        ${MetricCard("Model", o.model ?? "—", o.model ? "active" : null)}
        ${MetricCard("Edit mode", o.editMode ?? "—", o.editMode === "yolo" ? "all prompts bypassed" : null, o.editMode === "yolo" ? "warn" : null)}
        ${MetricCard("Plan mode", o.planMode === null ? "—" : o.planMode ? "ON" : "off", o.planMode ? "writes gated" : null)}
        ${MetricCard("Pending edits", fmtNum(o.pendingEdits), o.pendingEdits ? "awaiting /apply" : null)}
        ${MetricCard("MCP servers", fmtNum(o.mcpServerCount), null)}
        ${MetricCard("Tools", fmtNum(o.toolCount), null)}
      </div>

      <div class="section-title">Working directory</div>
      <div class="card">
        <div class="card-value mono" style="font-size: 14px;">${o.cwd ?? "—"}</div>
      </div>
    </div>
  `;
}
