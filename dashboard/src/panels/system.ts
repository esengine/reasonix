import { fmtBytes, fmtNum } from "../lib/format.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";
import { t, useLang } from "../i18n/index.js";

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
  useLang();
  const { data, error, loading } = usePoll<HealthData>("/health", 5000);
  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">${t("system.loading")}</div>`;
  if (error) return html`<div class="card accent-err">${t("common.loadingFailed", { name: "health", error: error.message })}</div>`;
  if (!data) return null;
  const h = data;
  const upToDate = h.latestVersion ? h.latestVersion === h.version : null;

  return html`
    <div style="display:flex;flex-direction:column;gap:14px">
      <h3 style="margin:0;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">${t("system.healthChecks")}</h3>
      <div class="health-grid">
        <div class=${`health-item ${upToDate === false ? "warn" : ""}`}>
          <div class="lbl">
            ${t("system.version")}
            ${
              upToDate === null
                ? html`<span class="pill">${t("system.checking")}</span>`
                : upToDate
                  ? html`<span class="pill ok">${t("system.latest")}</span>`
                  : html`<span class="pill warn">${t("system.outOfDate")}</span>`
            }
          </div>
          <div class="v">${h.version}</div>
          <div class="meta">${
            upToDate === null
              ? t("system.versionPending")
              : upToDate
                ? t("system.upToDate")
                : t("system.latestVer", { version: h.latestVersion ?? "" })
          }</div>
        </div>

        <div class="health-item">
          <div class="lbl">${t("system.sessions")} <span class="pill ok">${t("system.ok")}</span></div>
          <div class="v">${fmtBytes(h.sessions.totalBytes)}</div>
          <div class="meta">${fmtNum(h.sessions.count)} ${t("system.files")}</div>
        </div>

        <div class="health-item">
          <div class="lbl">${t("system.memory")} <span class="pill ok">${t("system.ok")}</span></div>
          <div class="v">${fmtBytes(h.memory.totalBytes)}</div>
          <div class="meta">${fmtNum(h.memory.fileCount)} ${t("system.files")}</div>
        </div>

        <div class="health-item">
          <div class="lbl">
            ${t("system.semanticIndex")}
            ${
              h.semantic.exists
                ? html`<span class="pill ok">${t("system.built")}</span>`
                : html`<span class="pill">${t("system.none")}</span>`
            }
          </div>
          <div class="v">${h.semantic.exists ? fmtBytes(h.semantic.totalBytes) : "—"}</div>
          <div class="meta">
            ${h.semantic.exists ? `${fmtNum(h.semantic.fileCount)} ${t("system.files")}` : t("system.runIndex")}
          </div>
        </div>

        <div class="health-item">
          <div class="lbl">${t("system.usageLog")} <span class="pill ok">${t("system.ok")}</span></div>
          <div class="v">${fmtBytes(h.usageLog.bytes)}</div>
          <div class="meta">~/.reasonix/usage.jsonl</div>
        </div>

        <div class="health-item">
          <div class="lbl">
            ${t("system.backgroundJobs")}
            ${
              h.jobs === null
                ? html`<span class="pill">${t("system.noSession")}</span>`
                : html`<span class="pill ok">● ${fmtNum(h.jobs)}</span>`
            }
          </div>
          <div class="v">${h.jobs === null ? "—" : t("system.running", { count: fmtNum(h.jobs) })}</div>
          <div class="meta">${h.jobs === null ? t("system.attachHint") : t("system.shellSpawn")}</div>
        </div>
      </div>

      <div class="card" style="padding:0">
        <div class="card-h" style="padding:12px 14px 6px">
          <span class="title">${t("system.paths")}</span>
        </div>
        <table class="tbl">
          <tbody style="font-size:11.5px">
            <tr><td class="dim" style="padding:5px 14px">${t("system.home")}</td><td class="path">${h.reasonixHome}</td></tr>
            <tr><td class="dim" style="padding:5px 14px">${t("system.sessionsPath")}</td><td class="path">${h.sessions.path}</td></tr>
            <tr><td class="dim" style="padding:5px 14px">${t("system.memoryPath")}</td><td class="path">${h.memory.path}</td></tr>
            <tr><td class="dim" style="padding:5px 14px">${t("system.semanticPath")}</td><td class="path">${h.semantic.path}</td></tr>
            <tr><td class="dim" style="padding:5px 14px">${t("system.usagePath")}</td><td class="path">${h.usageLog.path}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}
