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

function kpi(label: string, value: unknown, delta?: unknown, deltaTone?: "up" | "down" | "flat") {
  const muted = value === "—" || value === null || value === undefined;
  return html`
    <div class="kpi cock-w-1">
      <div class="label">${label}</div>
      <div class="value" style=${muted ? "color:var(--fg-4)" : ""}>${value ?? "—"}</div>
      ${
        delta != null
          ? html`<div class=${`delta ${deltaTone ?? ""}`}>${delta}</div>`
          : null
      }
    </div>
  `;
}

export function OverviewPanel() {
  const { data, error, loading } = usePoll<OverviewData>("/overview", 2000);
  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">loading overview…</div>`;
  if (error) return html`<div class="card accent-err">overview failed: ${error.message}</div>`;
  if (!data) return null;
  const o = data;
  const upToDate = o.latestVersion ? o.latestVersion === o.version : null;
  const versionDelta = upToDate === null
    ? "checking"
    : upToDate
      ? "latest"
      : `latest: ${o.latestVersion}`;
  const versionTone = upToDate === false ? "down" : "flat";

  return html`
    <div style="display:flex;flex-direction:column;gap:14px">
      ${
        o.mode === "standalone"
          ? html`<div class="card accent-warn">
              <div class="card-h">
                <span class="title" style="color:var(--c-warn)">Standalone mode</span>
              </div>
              <div class="card-b">
                Read-only disk view. Start <code class="mono">/dashboard</code> from inside
                <code class="mono">reasonix code</code> for live session state, MCP, and tools.
              </div>
            </div>`
          : null
      }

      <h3 style="margin:0;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
        Cockpit
      </h3>
      <div class="cockpit">
        ${kpi("model", o.model ?? "—", o.model ? "active" : null, "flat")}
        ${kpi(
          "edit mode",
          o.editMode ?? "—",
          o.editMode === "yolo" ? "all prompts bypassed" : null,
          o.editMode === "yolo" ? "down" : "flat",
        )}
        ${kpi(
          "plan mode",
          o.planMode === null ? "—" : o.planMode ? "ON" : "off",
          o.planMode ? "writes gated" : null,
          o.planMode ? "up" : "flat",
        )}
        ${kpi(
          "pending edits",
          fmtNum(o.pendingEdits),
          o.pendingEdits ? "awaiting /apply" : "clean",
          o.pendingEdits ? "down" : "flat",
        )}

        ${kpi("tools loaded", fmtNum(o.toolCount), null, "flat")}
        ${kpi("mcp servers", fmtNum(o.mcpServerCount), null, "flat")}
        ${kpi("session", o.session ?? "—", o.session ? "live" : "ephemeral", o.session ? "up" : "flat")}
        ${kpi("Reasonix", o.version ?? "—", versionDelta, versionTone)}
      </div>

      <h3 style="margin:0;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
        Working directory
      </h3>
      <div class="card">
        <div class="card-h"><span class="title">project root</span></div>
        <code class="mono" style="color:var(--fg-2);font-size:12px">${o.cwd ?? "—"}</code>
      </div>
    </div>
  `;
}
