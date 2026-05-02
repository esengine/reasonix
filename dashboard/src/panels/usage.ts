import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { fmtNum, fmtPct, fmtUsd } from "../lib/format.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";
import { t, useLang } from "../i18n/index.js";

type UPlotInstance = {
  destroy(): void;
  setSize(opts: { width: number; height: number }): void;
};

type UPlotConstructor = new (
  opts: unknown,
  data: unknown,
  el: HTMLElement,
) => UPlotInstance;

let uPlotPromise: Promise<UPlotConstructor> | null = null;
function loadUPlot(): Promise<UPlotConstructor> {
  if (!uPlotPromise) {
    uPlotPromise = import("uplot").then(
      (m) => (m.default ?? m) as UPlotConstructor,
    );
  }
  return uPlotPromise;
}

interface UsageDay {
  day: string;
  costUsd: number;
  cacheSavingsUsd: number;
  turns: number;
}

function UsageChart({ days }: { days: UsageDay[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<UPlotInstance | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadUPlot().then((uPlot) => {
      if (cancelled || !containerRef.current) return;
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
      if (!days || days.length === 0) return;
      const xs = days.map((d) => Math.floor(Date.parse(d.day) / 1000));
      const cost = days.map((d) => d.costUsd);
      const saved = days.map((d) => d.cacheSavingsUsd);
      const turns = days.map((d) => d.turns);
      const data = [xs, cost, saved, turns];
      const opts = {
        width: containerRef.current.clientWidth,
        height: 280,
        cursor: { drag: { x: true, y: false } },
        scales: {
          x: { time: true },
          y: { auto: true },
          turns: { auto: true },
        },
        axes: [
          { stroke: "#94a3b8", grid: { stroke: "rgba(148, 163, 184, 0.08)" } },
          {
            scale: "y",
            label: "USD",
            stroke: "#94a3b8",
            grid: { stroke: "rgba(148, 163, 184, 0.08)" },
            values: (_u: unknown, v: number[]) => v.map((n) => `$${n.toFixed(4)}`),
          },
          {
            scale: "turns",
            side: 1,
            label: "turns",
            stroke: "#94a3b8",
            grid: { show: false },
          },
        ],
        series: [
          {},
          { label: "cost", stroke: "#67e8f9", width: 2, fill: "rgba(103, 232, 249, 0.10)" },
          { label: "cache saved", stroke: "#5eead4", width: 2, dash: [4, 4] },
          {
            label: "turns",
            stroke: "#c4b5fd",
            scale: "turns",
            width: 1.5,
            points: { show: true, size: 4 },
          },
        ],
        legend: { live: true },
      };
      plotRef.current = new uPlot(opts, data, containerRef.current);
    });

    const ro = new ResizeObserver(() => {
      if (plotRef.current && containerRef.current) {
        plotRef.current.setSize({ width: containerRef.current.clientWidth, height: 280 });
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      ro.disconnect();
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
    };
  }, [days]);

  return html`<div ref=${containerRef} style="width: 100%; min-height: 280px;"></div>`;
}

interface Bucket {
  label: string;
  turns: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  claudeEquivUsd: number;
}

interface UsageSummary {
  recordCount: number;
  logSize: string;
  buckets: Bucket[];
  byModel: { model: string; turns: number }[];
  subagents?: { total: number; costUsd: number; totalDurationMs: number };
}

export function UsagePanel() {
  useLang();
  const { data: summary, error, loading } = usePoll<UsageSummary>("/usage", 5000);
  const [series, setSeries] = useState<UsageDay[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api<{ days?: UsageDay[] }>("/usage/series");
        if (!cancelled) setSeries(s.days ?? []);
      } catch {
        /* keep null; chart hides */
      }
    })();
    const interval = setInterval(async () => {
      try {
        const s = await api<{ days?: UsageDay[] }>("/usage/series");
        if (!cancelled) setSeries(s.days ?? []);
      } catch {
        /* swallow */
      }
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading && !summary)
    return html`<div class="card" style="color:var(--fg-3)">${t("usage.loading")}</div>`;
  if (error) return html`<div class="card accent-err">${t("common.loadingFailed", { name: "usage", error: error.message })}</div>`;
  if (!summary) return null;
  const u = summary;

  const sectionH3 = (text: string) => html`
    <h3 style="margin:18px 0 8px;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">${text}</h3>
  `;

  return html`
    <div style="display:flex;flex-direction:column;gap:6px">
      <div class="chips">
        <span class="chip-f active">${t("usage.records", { count: u.recordCount.toLocaleString() })}</span>
        <span class="chip-f">${u.logSize}</span>
      </div>

      ${
        series && series.length > 0
          ? html`
            <div class="card" style="padding:18px">
              <div class="card-h">
                <span class="title">${t("usage.dailyUsage")}</span>
                <span class="meta">${t("usage.dailyMeta")}</span>
              </div>
              <${UsageChart} days=${series} />
            </div>
          `
          : null
      }

      ${
        u.recordCount === 0
          ? html`<div class="card" style="color:var(--fg-3);margin-top:8px">
              ${t("usage.noData")}
            </div>`
          : html`
              ${sectionH3(t("usage.windows"))}
              <div class="card" style="padding:0;overflow:hidden">
                <table class="tbl">
                  <thead>
                    <tr>
                      <th></th>
                      <th>${t("usage.colTurns")}</th>
                      <th>${t("usage.colCacheHit")}</th>
                      <th>${t("usage.colCost")}</th>
                      <th>${t("usage.colCacheSaved")}</th>
                      <th>${t("usage.colVsClaude")}</th>
                      <th>${t("usage.colSaved")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${u.buckets.map((b) => {
                      const hitRatio =
                        b.cacheHitTokens + b.cacheMissTokens > 0
                          ? b.cacheHitTokens / (b.cacheHitTokens + b.cacheMissTokens)
                          : 0;
                      const claudeSavings =
                        b.claudeEquivUsd > 0 ? 1 - b.costUsd / b.claudeEquivUsd : 0;
                      return html`
                        <tr>
                          <td class="dim">${b.label}</td>
                          <td class="num">${fmtNum(b.turns)}</td>
                          <td class="num">${b.turns > 0 ? fmtPct(hitRatio) : "—"}</td>
                          <td class="num">${b.turns > 0 ? fmtUsd(b.costUsd) : "—"}</td>
                          <td class="num">${b.turns > 0 && b.cacheSavingsUsd > 0 ? fmtUsd(b.cacheSavingsUsd) : "—"}</td>
                          <td class="num">${b.turns > 0 ? fmtUsd(b.claudeEquivUsd) : "—"}</td>
                          <td class="num">${b.turns > 0 && claudeSavings > 0 ? fmtPct(claudeSavings) : "—"}</td>
                        </tr>
                      `;
                    })}
                  </tbody>
                </table>
              </div>
            `
      }

      ${
        u.byModel.length > 0
          ? html`
              ${sectionH3(t("usage.mostUsed"))}
              <div class="card" style="padding:0;overflow:hidden">
                <table class="tbl">
                  <thead>
                    <tr>
                      <th>${t("usage.colModel")}</th>
                      <th>${t("usage.colTurns")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${u.byModel.slice(0, 5).map(
                      (m) => html`
                        <tr>
                          <td><code class="mono">${m.model}</code></td>
                          <td class="num">${fmtNum(m.turns)}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `
          : null
      }
    </div>
  `;
}
