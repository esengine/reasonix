import { useState } from "preact/hooks";
import { fmtPct, fmtRelativeTime } from "../lib/format.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";
import { t, useLang } from "../i18n/index.js";

interface PlanStep {
  id: string;
  title: string;
  action?: string;
  risk?: "low" | "medium" | "high";
}

interface ArchivedPlan {
  session: string;
  summary?: string;
  steps: PlanStep[];
  completedStepIds: string[];
  completedSteps: number;
  totalSteps: number;
  completionRatio: number;
  completedAt: string | number;
}

interface PlansData {
  plans?: ArchivedPlan[];
}

function statusPill(p: ArchivedPlan) {
  if (p.completionRatio >= 1) return html`<span class="pill ok">${t("plans.done")}</span>`;
  if (p.completionRatio > 0) return html`<span class="pill info">${t("plans.active")}</span>`;
  return html`<span class="pill">idle</span>`;
}

export function PlansPanel() {
  useLang();
  const { data, error, loading } = usePoll<PlansData>("/plans", 8000);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [filter, setFilter] = useState("");

  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">${t("plans.loading")}</div>`;
  if (error) return html`<div class="card accent-err">${t("common.loadingFailed", { name: "plans", error: error.message })}</div>`;
  const plans = data?.plans ?? [];

  if (plans.length === 0)
    return html`<div class="card" style="color:var(--fg-3)">
      ${t("plans.noPlans")}
    </div>`;

  const filtered = filter.trim()
    ? plans.filter(
        (p) =>
          p.session.toLowerCase().includes(filter.toLowerCase()) ||
          (p.summary ?? "").toLowerCase().includes(filter.toLowerCase()),
      )
    : plans;

  const open = openIdx !== null ? plans[openIdx] : null;

  return html`
    <div class="sessions-grid">
      <div class="sessions-list">
        <div class="ssl-h">
          <input
            type="text"
            placeholder=${t("plans.filterPlaceholder")}
            value=${filter}
            onInput=${(e: Event) => setFilter((e.target as HTMLInputElement).value)}
            style="flex:1"
          />
        </div>
        <div class="chips" style="padding:0 12px 8px">
          <span class="chip-f active">${t("common.all")} <span class="ct">${plans.length}</span></span>
          <span class="chip-f">
            ${t("plans.active")}
            <span class="ct">${plans.filter((p) => p.completionRatio > 0 && p.completionRatio < 1).length}</span>
          </span>
          <span class="chip-f">
            ${t("plans.done")} <span class="ct">${plans.filter((p) => p.completionRatio >= 1).length}</span>
          </span>
        </div>
        <div class="ssl-rows">
          ${filtered.map((p) => {
            const idx = plans.indexOf(p);
            const sel = idx === openIdx;
            return html`
              <div class=${`ssl-row ${sel ? "sel" : ""}`} onClick=${() => setOpenIdx(idx)}>
                <span class="name">${p.summary ?? p.session} ${statusPill(p)}</span>
                ${
                  p.summary && p.session !== p.summary
                    ? html`<span class="preview">${p.session}</span>`
                    : null
                }
                <span class="meta">
                  <span><span class="v">${p.totalSteps}</span> ${t("plans.steps")}</span>
                  <span><span class="v">${p.completedSteps} / ${p.totalSteps}</span> · ${fmtPct(p.completionRatio)}</span>
                  <span>${fmtRelativeTime(p.completedAt)}</span>
                </span>
              </div>
            `;
          })}
        </div>
      </div>

      <div class="sessions-detail">
        ${
          open == null
            ? html`<div style="color:var(--fg-3);font-size:13px;text-align:center;padding:60px 20px">
                ${t("plans.pickHint")}
              </div>`
            : html`
                <div class="sessions-detail-h">
                  <span class="name">${open.summary ?? t("plans.noTitle")}</span>
                  <span class="ws">${open.session} · ${fmtRelativeTime(open.completedAt)}</span>
                  <span class="actions">
                    <button class="btn ghost" onClick=${() => setOpenIdx(null)}>${t("common.back")}</button>
                  </span>
                </div>

                <h3 style="margin:0 0 6px;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
                  ${t("plans.stepTimeline", { done: open.completedSteps, total: open.totalSteps })}
                </h3>
                <div class="plan-timeline" style="margin-bottom:14px">
                  ${open.steps.map((step, i) => {
                    const done = open.completedStepIds.includes(step.id);
                    const cls = done ? "done" : i === open.completedSteps ? "active" : "";
                    return html`
                      <div class=${`plan-step ${cls}`}>
                        <span class="lbl">${t("plans.step", { n: i + 1 })}</span>
                        <span class="name">${step.title}</span>
                        ${step.action ? html`<span class="meta">${step.action}</span>` : null}
                        ${
                          step.risk
                            ? html`<span
                                class=${`pill ${step.risk === "high" ? "err" : step.risk === "medium" ? "warn" : ""}`}
                                style="align-self:flex-start;margin-top:4px"
                              >${step.risk}</span>`
                            : null
                        }
                      </div>
                    `;
                  })}
                </div>
              `
        }
      </div>
    </div>
  `;
}
