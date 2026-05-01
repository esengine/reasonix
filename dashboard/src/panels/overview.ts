import { fmtCompactNum, fmtNum, fmtRelativeTime, fmtUsd } from "../lib/format.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";

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
  if (deltaPct === null) return { text: "no prior data", tone: "flat" };
  if (Math.abs(deltaPct) < 1) return { text: "— stable", tone: "flat" };
  const arrow = deltaPct > 0 ? "▲" : "▼";
  return {
    text: `${arrow} ${Math.abs(deltaPct).toFixed(0)}% vs prior`,
    tone: deltaPct > 0 ? "up" : "down",
  };
}

function deltaPpText(deltaPp: number | null): { text: string; tone: "up" | "down" | "flat" } {
  if (deltaPp === null) return { text: "no prior data", tone: "flat" };
  if (Math.abs(deltaPp) < 0.5) return { text: "— stable", tone: "flat" };
  const arrow = deltaPp > 0 ? "▲" : "▼";
  return { text: `${arrow} ${Math.abs(deltaPp).toFixed(1)}pp`, tone: deltaPp > 0 ? "up" : "down" };
}

function deltaCountText(delta: number | null): { text: string; tone: "up" | "down" | "flat" } {
  if (delta === null || delta === 0) return { text: "— stable", tone: "flat" };
  const arrow = delta > 0 ? "▲" : "▼";
  return { text: `${arrow} ${Math.abs(delta)}`, tone: delta > 0 ? "up" : "down" };
}

function balanceKpi(c: CockpitData) {
  if (!c.balance) return kpi("balance", "—", "open in TUI", "flat");
  const symbol = c.balance.currency === "CNY" ? "¥" : c.balance.currency === "USD" ? "$" : "";
  return kpi("balance", `${symbol}${c.balance.total}`, c.balance.currency, "flat");
}

function tokens7dKpi(c: CockpitData) {
  if (!c.tokens7d) return kpi("tokens · 7d", "—", "no usage yet", "flat");
  const d = deltaPctText(c.tokens7d.deltaPct);
  return kpi("tokens · 7d", fmtCompactNum(c.tokens7d.total), d.text, d.tone);
}

function cacheHitKpi(c: CockpitData) {
  if (!c.cacheHit7d) return kpi("cache hit", "—", "no usage yet", "flat");
  const pct = (c.cacheHit7d.ratio * 100).toFixed(0);
  const d = deltaPpText(c.cacheHit7d.deltaPp);
  return html`
    <div class="kpi cock-w-1">
      <div class="label">cache hit</div>
      <div class="value">${pct}<span class="unit">%</span></div>
      <div class=${`delta ${d.tone}`}>${d.text}</div>
    </div>
  `;
}

function toolCallsKpi(c: CockpitData) {
  if (!c.toolCalls24h) return kpi("tool calls · 24h", "—", "no events", "flat");
  const d = deltaCountText(c.toolCalls24h.delta);
  return kpi("tool calls · 24h", fmtNum(c.toolCalls24h.total), d.text, d.tone);
}

function currentSessionBlock(c: CockpitData) {
  if (!c.currentSession) {
    return html`
      <div class="cock-list cock-w-2">
        <div class="ch"><span class="ttl">current session</span></div>
        <div style="color:var(--fg-3);font-size:12.5px;padding:8px 0">
          No live session — <code class="mono">/dashboard</code> from inside <code class="mono">reasonix code</code> to attach.
        </div>
      </div>
    `;
  }
  const s = c.currentSession;
  return html`
    <div class="cock-list cock-w-2">
      <div class="ch"><span class="ttl">current session</span></div>
      <div class="card accent-brand" style="margin:0 0 8px;background:transparent;border:none;padding:0">
        <div class="card-h"><span class="glyph">◆</span><span class="title">${s.id}</span><span class="meta">${s.turns} turn${s.turns === 1 ? "" : "s"}</span></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;font-family:var(--font-mono);font-size:11px">
        <div><span style="color:var(--fg-3)">prompt tok</span><div style="color:var(--fg-0);font-size:13px;font-weight:600">${fmtNum(s.lastPromptTokens)}</div></div>
        <div><span style="color:var(--fg-3)">completion tok</span><div style="color:var(--fg-0);font-size:13px;font-weight:600">${fmtNum(s.completionTokens)}</div></div>
        <div><span style="color:var(--fg-3)">cost</span><div style="color:var(--fg-0);font-size:13px;font-weight:600">${fmtUsd(s.totalCostUsd)}</div></div>
      </div>
    </div>
  `;
}

function costTrendSpark(c: CockpitData) {
  if (!c.costTrend14d || c.costTrend14d.length === 0) {
    return html`
      <div class="chart cock-w-2">
        <div class="chart-h"><span class="title">cost · 14 day</span></div>
        <div class="chart-v" style="color:var(--fg-4)">—<span class="unit">no usage yet</span></div>
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
      <div class="chart-h"><span class="title">cost · 14 day</span></div>
      <div class="chart-v">${fmtUsd(avg)}<span class="unit">/day avg</span></div>
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
      <div class="ch"><span class="ttl">recent plans</span></div>
      ${
        !c.recentPlans || c.recentPlans.length === 0
          ? html`<div style="color:var(--fg-3);font-size:12.5px;padding:8px 0">No plans yet — submit one with <code class="mono">submit_plan</code>.</div>`
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
      <div class="ch"><span class="ttl">tool activity</span></div>
      ${
        !c.toolActivity || c.toolActivity.length === 0
          ? html`<div style="color:var(--fg-3);font-size:12.5px;padding:8px 0">No tool calls yet.</div>`
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
  const { data, error, loading } = usePoll<OverviewData>("/overview", 2500);
  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">loading overview…</div>`;
  if (error) return html`<div class="card accent-err">overview failed: ${error.message}</div>`;
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
    upToDate === null ? "checking" : upToDate ? "latest" : `latest: ${o.latestVersion}`;
  const versionTone: "up" | "down" | "flat" = upToDate === false ? "down" : "flat";

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
        ${balanceKpi(c)}
        ${tokens7dKpi(c)}
        ${cacheHitKpi(c)}
        ${toolCallsKpi(c)}

        ${currentSessionBlock(c)}
        ${costTrendSpark(c)}

        ${recentPlansRail(c)}
        ${toolActivityFeed(c)}

        ${kpi("tools loaded", fmtNum(o.toolCount), o.toolCount ? "active" : "—", "flat")}
        ${kpi("mcp servers", fmtNum(o.mcpServerCount), o.mcpServerCount ? "all up" : "—", o.mcpServerCount ? "up" : "flat")}
        ${kpi("edit mode", o.editMode ?? "—", o.editMode === "yolo" ? "all prompts bypassed" : null, o.editMode === "yolo" ? "down" : "flat")}
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
