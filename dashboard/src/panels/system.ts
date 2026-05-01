import { MetricCard } from "../components/metric-card.js";
import { fmtBytes, fmtNum } from "../lib/format.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";

interface HealthData {
  version: string;
  latestVersion: string | null;
  sessions: { count: number; totalBytes: number; path: string };
  memory: { fileCount: number; totalBytes: number; path: string };
  semantic: { exists: boolean; fileCount?: number; totalBytes?: number; path: string };
  usageLog: { bytes: number; path: string };
  jobs: number | null;
  reasonixHome: string;
}

export function SystemPanel() {
  const { data, error, loading } = usePoll<HealthData>("/health", 5000);
  if (loading && !data) return html`<div class="boot">loading health…</div>`;
  if (error) return html`<div class="notice err">health failed: ${error.message}</div>`;
  if (!data) return null;
  const h = data;
  const upToDate = h.latestVersion ? h.latestVersion === h.version : null;
  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">System Health</h2>
        <span class="panel-subtitle">disk · version · jobs</span>
      </div>
      <div class="metric-grid">
        ${MetricCard(
          "Reasonix",
          h.version,
          h.latestVersion === null
            ? "version check pending"
            : upToDate
              ? "up to date"
              : `latest: ${h.latestVersion}`,
          upToDate === false ? "warn" : null,
        )}
        ${MetricCard("Sessions", `${fmtNum(h.sessions.count)} files`, fmtBytes(h.sessions.totalBytes))}
        ${MetricCard("Memory", `${fmtNum(h.memory.fileCount)} files`, fmtBytes(h.memory.totalBytes))}
        ${MetricCard(
          "Semantic index",
          h.semantic.exists ? `${fmtNum(h.semantic.fileCount)} files` : "not built",
          h.semantic.exists ? fmtBytes(h.semantic.totalBytes) : "run `reasonix index` to build",
        )}
        ${MetricCard("Usage log", fmtBytes(h.usageLog.bytes), null)}
        ${MetricCard("Background jobs", h.jobs === null ? "—" : fmtNum(h.jobs), h.jobs === null ? "no live session" : null)}
      </div>
      <div class="section-title">Paths</div>
      <div class="card mono" style="font-size: 12px; line-height: 1.8;">
        <div><span class="pill pill-dim">home</span> ${h.reasonixHome}</div>
        <div><span class="pill pill-dim">sessions</span> ${h.sessions.path}</div>
        <div><span class="pill pill-dim">memory</span> ${h.memory.path}</div>
        <div><span class="pill pill-dim">semantic</span> ${h.semantic.path}</div>
        <div><span class="pill pill-dim">usage</span> ${h.usageLog.path}</div>
      </div>
    </div>
  `;
}
