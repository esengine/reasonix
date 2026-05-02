import { fmtCompactNum, fmtNum, fmtRelativeTime, fmtUsd } from "../lib/format.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";
import { t, useLang } from "../i18n/index.js";

interface CockpitKpi {
  total: number;
  deltaPct: number | null;
}
interface CockpitCacheKpi {
  ratio: number;
  deltaPp: number | null;
}
interface CockpitDailyCost {
  date: string;
  usd: number;
}
interface CockpitCurrentSession {
  id: string;
  turns: number;
  totalCostUsd: number;
  lastPromptTokens: number;
  completionTokens: number;
}
interface CockpitToolCallsKpi {
  total: number;
  delta: number | null;
}
interface CockpitRecentPlan {
  id: string;
  title: string;
  totalSteps: number;
  completedSteps: number;
  status: "active" | "done";
  whenMs: number;
}
interface CockpitToolFeedRow {
  name: string;
  args: string;
  level: "ok" | "warn" | "err";
  whenMs: number;
}

interface CockpitData {
  balance: { currency: string; total: string } | null;
  tokens7d: CockpitKpi | null;
  cacheHit7d: CockpitCacheKpi | null;
  costTrend14d: ReadonlyArray<CockpitDailyCost> | null;
  currentSession: CockpitCurrentSession | null;
  toolCalls24h: CockpitToolCallsKpi | null;
  recentPlans: ReadonlyArray<CockpitRecentPlan> | null;
  toolActivity: ReadonlyArray<CockpitToolFeedRow> | null;
}

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
  cockpit?: CockpitData;
}

function kpi(label: string, value: unknown, delta?: unknown, deltaTone?: "up" | "down" | "flat") {
  const muted = value === "—" || value === null || value === undefined;
  return html`
    <div class="kpi cock-w-1">
      <div class="label">${label}</div>
      <div class="value" style=${muted ? "color:var(--fg-4)" : ""}>${value ?? "—"}</div>
      ${delta != null ? html`<div class=${`delta ${deltaTone ?? ""}`}>${delta}</div>` : null}
    </div>
  `;
}

function deltaPctText(deltaPct: number | null): { text: string; tone: "up" | "down" | "flat" } {
  if (deltaPct === null) return { text: t("overview.noPriorData"), tone: "flat" };
  if (Math.abs(deltaPct) < 1) return { text: t("overview.stable"), tone: "flat" };
  const arrow = deltaPct > 0 ? "▲" : "▼";
  return {
    text: t("overview.vsPrior", { arrow, pct: Math.abs(deltaPct).toFixed(0) }),
    tone: deltaPct > 0 ? "up" : "down",
  };
}

function deltaPpText(deltaPp: number | null): { text: string; tone: "up" | "down" | "flat" } {
  if (deltaPp === null) return { text: t("overview.noPriorData"), tone: "flat" };
  if (Math.abs(deltaPp) < 0.5) return { text: t("overview.stable"), tone: "flat" };
  const arrow = deltaPp > 0 ? "▲" : "▼";
  return { text: `${arrow} ${Math.abs(deltaPp).toFixed(1)}pp`, tone: deltaPp > 0 ? "up" : "down" };
}

function deltaCountText(delta: number | null): { text: string; tone: "up" | "down" | "flat" } {
  if (delta === null || delta === 0) return { text: t("overview.stable"), tone: "flat" };
  const arrow = delta > 0 ? "▲" : "▼";
  return { text: `${arrow} ${Math.abs(delta)}`, tone: delta > 0 ? "up" : "down" };
}

function balanceKpi(c: CockpitData) {
  if (!c.balance) return kpi(t("overview.balance"), "—", "open in TUI", "flat");
  const symbol = c.balance.currency === "CNY" ? "¥" : c.balance.currency === "USD" ? "$" : "";
  return kpi(t("overview.balance"), `${symbol}${c.balance.total}`, c.balance.currency, "flat");
}

function tokens7dKpi(c: CockpitData) {
  if (!c.tokens7d) return kpi(t("overview.tokens7d"), "—", t("overview.noUsageYet"), "flat");
  const d = deltaPctText(c.tokens7d.deltaPct);
  return kpi(t("overview.tokens7d"), fmtCompactNum(c.tokens7d.total), d.text, d.tone);
}

function cacheHitKpi(c: CockpitData) {
  if (!c.cacheHit7d) return kpi(t("overview.cacheHit"), "—", t("overview.noUsageYet"), "flat");
  const pct = (c.cacheHit7d.ratio * 100).toFixed(0);
  const d = deltaPpText(c.cacheHit7d.deltaPp);
  return html`
    <div class="kpi cock-w-1">
      <div class="label">${t("overview.cacheHit")}</div>
      <div class="value">${pct}<span class="unit">%</span></div>
      <div class=${`delta ${d.tone}`}>${d.text}</div>
    </div>
  `;
}

function toolCallsKpi(c: CockpitData) {
  if (!c.toolCalls24h) return kpi(t("overview.toolCalls24h"), "—", t("overview.noToolCalls"), "flat");
  const d = deltaCountText(c.toolCalls24h.delta);
  return kpi(t("overview.toolCalls24h"), fmtNum(c.toolCalls24h.total), d.text, d.tone);
}

function currentSessionBlock(c: CockpitData) {
  if (!c.currentSession) {
    return html`
      <div class="cock-list cock-w-2">
        <div class="ch"><span class="ttl">${t("overview.currentSession")}</span></div>
        <div style="color:var(--fg-3);font-size:12.5px;padding:8px 0">
          ${t("overview.noSession")}
        </div>
      </div>
    `;
  }
  const s = c.currentSession;
  return html`
    <div class="cock-list cock-w-2">
      <div class="ch"><span class="ttl">${t("overview.currentSession")}</span></div>
      <div class="card accent-brand" style="margin:0 0 8px;background:transparent;border:none;padding:0">
        <div class="card-h"><span class="glyph">◆</span><span class="title">${s.id}</span><span class="meta">${s.turns} turn${s.turns === 1 ? "" : "s"}</span></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;font-family:var(--font-mono);font-size:11px">
        <div><span style="color:var(--fg-3)">${t("overview.promptTok")}</span><div style="color:var(--fg-0);font-size:13px;font-weight:600">${fmtNum(s.lastPromptTokens)}</div></div>
        <div><span style="color:var(--fg-3)">${t("overview.completionTok")}</span><div style="color:var(--fg-0);font-size:13px;font-weight:600">${fmtNum(s.completionTokens)}</div></div>
        <div><span style="color:var(--fg-3)">${t("overview.cost")}</span><div style="color:var(--fg-0);font-size:13px;font-weight:600">${fmtUsd(s.totalCostUsd)}</div></div>
      </div>
    </div>
  `;
}

function costTrendSpark(c: CockpitData) {
  if (!c.costTrend14d || c.costTrend14d.length === 0) {
    return html`
      <div class="chart cock-w-2">
        <div class="chart-h"><span class="title">${t("overview.costTrend")}</span></div>
        <div class="chart-v" style="color:var(--fg-4)">—<span class="unit">${t("overview.noUsageYet")}</span></div>
      </div>
    `;
  }
  const days = c.costTrend14d;
  const total = days.reduce((s, d) => s + d.usd, 0);
  const max = Math.max(...days.map((d) => d.usd), 0.0001);
  const w = 400;
  const h = 60;
  const points = days
    .map((d, i) => {
      const x = days.length === 1 ? 0 : (i * w) / (days.length - 1);
      const y = h - (d.usd / max) * (h - 6) - 3;
      return `${x.toFixed(0)},${y.toFixed(0)}`;
    })
    .join(" ");
  const area = `${points} ${w},${h} 0,${h}`;
  const avg = total / days.length;
  return html`
    <div class="chart cock-w-2">
      <div class="chart-h"><span class="title">${t("overview.costTrend")}</span></div>
      <div class="chart-v">${fmtUsd(avg)}<span class="unit">${t("overview.dayAvg")}</span></div>
      <div class="chart-spark">
        <svg viewBox=${`0 0 ${w} ${h}`} preserveAspectRatio="none">
          <polyline fill="none" stroke="var(--c-brand)" stroke-width="1.5" points=${points} />
          <polyline fill="rgba(121,192,255,.10)" stroke="none" points=${area} />
        </svg>
      </div>
    </div>
  `;
}

function recentPlansRail(c: CockpitData) {
  return html`
    <div class="cock-list cock-w-2">
      <div class="ch"><span class="ttl">${t("overview.recentPlans")}</span></div>
      ${
        !c.recentPlans || c.recentPlans.length === 0
          ? html`<div style="color:var(--fg-3);font-size:12.5px;padding:8px 0">${t("overview.noPlans")}</div>`
          : c.recentPlans.map(
              (p) => html`
                <div class=${`rail-step ${p.status === "done" ? "done" : "active"}`}>
                  <span class="g">${p.status === "done" ? "✓" : "⏵"}</span>
                  <span>${p.title} · ${p.completedSteps}/${p.totalSteps} step${p.totalSteps === 1 ? "" : "s"}</span>
                  <span style="margin-left:auto;color:var(--fg-4);font-family:var(--font-mono);font-size:10.5px">${fmtRelativeTime(p.whenMs)}</span>
                </div>
              `,
            )
      }
    </div>
  `;
}

function toolActivityFeed(c: CockpitData) {
  return html`
    <div class="cock-list cock-w-2">
      <div class="ch"><span class="ttl">${t("overview.toolActivity")}</span></div>
      ${
        !c.toolActivity || c.toolActivity.length === 0
          ? html`<div style="color:var(--fg-3);font-size:12.5px;padding:8px 0">${t("overview.noToolCalls")}</div>`
          : c.toolActivity.map(
              (r) => html`
                <div class=${`feed-row ${r.level}`}>
                  <span class="g">${r.level === "ok" ? "●" : r.level === "warn" ? "▲" : "✕"}</span>
                  <span class="name">${r.name}${r.args ? html` <span class="args">${r.args}</span>` : null}</span>
                  <span class="when" style="margin-left:auto">${fmtRelativeTime(r.whenMs)}</span>
                </div>
              `,
            )
      }
    </div>
  `;
}

export function OverviewPanel() {
  useLang();
  const { data, error, loading } = usePoll<OverviewData>("/overview", 2500);
  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">${t("overview.loading")}</div>`;
  if (error) return html`<div class="card accent-err">${t("overview.failed", { error: error.message })}</div>`;
  if (!data) return null;
  const o = data;
  const c: CockpitData = o.cockpit ?? {
    balance: null,
    tokens7d: null,
    cacheHit7d: null,
    costTrend14d: null,
    currentSession: null,
    toolCalls24h: null,
    recentPlans: null,
    toolActivity: null,
  };
  const upToDate = o.latestVersion ? o.latestVersion === o.version : null;
  const versionDelta =
    upToDate === null ? t("overview.checking") : upToDate ? t("overview.latest") : `latest: ${o.latestVersion}`;
  const versionTone: "up" | "down" | "flat" = upToDate === false ? "down" : "flat";

  return html`
    <div style="display:flex;flex-direction:column;gap:14px">
      ${
        o.mode === "standalone"
          ? html`<div class="card accent-warn">
              <div class="card-h">
                <span class="title" style="color:var(--c-warn)">${t("overview.standaloneTitle")}</span>
              </div>
              <div class="card-b">
                ${t("overview.standaloneDesc")}
              </div>
            </div>`
          : null
      }

      <h3 style="margin:0;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
        ${t("overview.cockpit")}
      </h3>
      <div class="cockpit">
        ${balanceKpi(c)}
        ${tokens7dKpi(c)}
        ${cacheHitKpi(c)}
        ${toolCallsKpi(c)}

        ${currentSessionBlock(c)}
        ${costTrendSpark(c)}

        ${recentPlansRail(c)}
        ${toolActivityFeed(c)}

        ${kpi(t("overview.toolsLoaded"), fmtNum(o.toolCount), o.toolCount ? t("overview.active") : "—", "flat")}
        ${kpi(t("overview.mcpServers"), fmtNum(o.mcpServerCount), o.mcpServerCount ? t("overview.allUp") : "—", o.mcpServerCount ? "up" : "flat")}
        ${kpi(t("overview.editMode"), o.editMode ?? "—", o.editMode === "yolo" ? t("overview.yoloWarning") : null, o.editMode === "yolo" ? "down" : "flat")}
        ${kpi(t("overview.version"), o.version ?? "—", versionDelta, versionTone)}
      </div>

      <h3 style="margin:0;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
        ${t("overview.workingDir")}
      </h3>
      <div class="card">
        <div class="card-h"><span class="title">${t("overview.projectRoot")}</span></div>
        <code class="mono" style="color:var(--fg-2);font-size:12px">${o.cwd ?? "—"}</code>
      </div>
    </div>
  `;
}
