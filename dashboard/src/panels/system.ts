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
  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">loading health…</div>`;
  if (error) return html`<div class="card accent-err">health failed: ${error.message}</div>`;
  if (!data) return null;
  const h = data;
  const upToDate = h.latestVersion ? h.latestVersion === h.version : null;

  return html`
    <div style="display:flex;flex-direction:column;gap:14px">
      <h3 style="margin:0;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">Health checks</h3>
      <div class="health-grid">
        <div class=${`health-item ${upToDate === false ? "warn" : ""}`}>
          <div class="lbl">
            version
            ${
              upToDate === null
                ? html`<span class="pill">checking</span>`
                : upToDate
                  ? html`<span class="pill ok">● latest</span>`
                  : html`<span class="pill warn">● out of date</span>`
            }
          </div>
          <div class="v">${h.version}</div>
          <div class="meta">${
            upToDate === null
              ? "version check pending"
              : upToDate
                ? "up to date"
                : `latest: ${h.latestVersion}`
          }</div>
        </div>

        <div class="health-item">
          <div class="lbl">sessions <span class="pill ok">● ok</span></div>
          <div class="v">${fmtBytes(h.sessions.totalBytes)}</div>
          <div class="meta">${fmtNum(h.sessions.count)} files</div>
        </div>

        <div class="health-item">
          <div class="lbl">memory <span class="pill ok">● ok</span></div>
          <div class="v">${fmtBytes(h.memory.totalBytes)}</div>
          <div class="meta">${fmtNum(h.memory.fileCount)} files</div>
        </div>

        <div class="health-item">
          <div class="lbl">
            semantic index
            ${
              h.semantic.exists
                ? html`<span class="pill ok">● built</span>`
                : html`<span class="pill">— none</span>`
            }
          </div>
          <div class="v">${h.semantic.exists ? fmtBytes(h.semantic.totalBytes) : "—"}</div>
          <div class="meta">
            ${h.semantic.exists ? `${fmtNum(h.semantic.fileCount)} files` : "run reasonix index to build"}
          </div>
        </div>

        <div class="health-item">
          <div class="lbl">usage log <span class="pill ok">● ok</span></div>
          <div class="v">${fmtBytes(h.usageLog.bytes)}</div>
          <div class="meta">~/.reasonix/usage.jsonl</div>
        </div>

        <div class="health-item">
          <div class="lbl">
            background jobs
            ${
              h.jobs === null
                ? html`<span class="pill">— no session</span>`
                : html`<span class="pill ok">● ${fmtNum(h.jobs)}</span>`
            }
          </div>
          <div class="v">${h.jobs === null ? "—" : `${fmtNum(h.jobs)} running`}</div>
          <div class="meta">${h.jobs === null ? "attach a session to see jobs" : "shell + spawn"}</div>
        </div>
      </div>

      <div class="card" style="padding:0">
        <div class="card-h" style="padding:12px 14px 6px">
          <span class="title">paths</span>
        </div>
        <table class="tbl">
          <tbody style="font-size:11.5px">
            <tr><td class="dim" style="padding:5px 14px">home</td><td class="path">${h.reasonixHome}</td></tr>
            <tr><td class="dim" style="padding:5px 14px">sessions</td><td class="path">${h.sessions.path}</td></tr>
            <tr><td class="dim" style="padding:5px 14px">memory</td><td class="path">${h.memory.path}</td></tr>
            <tr><td class="dim" style="padding:5px 14px">semantic</td><td class="path">${h.semantic.path}</td></tr>
            <tr><td class="dim" style="padding:5px 14px">usage</td><td class="path">${h.usageLog.path}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}
