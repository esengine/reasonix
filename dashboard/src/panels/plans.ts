import { useState } from "preact/hooks";
import { fmtPct, fmtRelativeTime } from "../lib/format.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";

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
  if (p.completionRatio >= 1) return html`<span class="pill ok">done</span>`;
  if (p.completionRatio > 0) return html`<span class="pill info">active</span>`;
  return html`<span class="pill">idle</span>`;
}

export function PlansPanel() {
  const { data, error, loading } = usePoll<PlansData>("/plans", 8000);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [filter, setFilter] = useState("");

  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">loading plans…</div>`;
  if (error) return html`<div class="card accent-err">plans failed: ${error.message}</div>`;
  const plans = data?.plans ?? [];

  if (plans.length === 0)
    return html`<div class="card" style="color:var(--fg-3)">
      No archived plans yet — run a turn that calls <code class="mono">submit_plan</code>
      and <code class="mono">mark_step_complete</code>.
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
            placeholder="filter plans"
            value=${filter}
            onInput=${(e: Event) => setFilter((e.target as HTMLInputElement).value)}
            style="flex:1"
          />
        </div>
        <div class="chips" style="padding:0 12px 8px">
          <span class="chip-f active">all <span class="ct">${plans.length}</span></span>
          <span class="chip-f">
            active
            <span class="ct">${plans.filter((p) => p.completionRatio > 0 && p.completionRatio < 1).length}</span>
          </span>
          <span class="chip-f">
            done <span class="ct">${plans.filter((p) => p.completionRatio >= 1).length}</span>
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
                  <span><span class="v">${p.totalSteps}</span> steps</span>
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
                Pick a plan on the left.
              </div>`
            : html`
                <div class="sessions-detail-h">
                  <span class="name">${open.summary ?? "(no title)"}</span>
                  <span class="ws">${open.session} · ${fmtRelativeTime(open.completedAt)}</span>
                  <span class="actions">
                    <button class="btn ghost" onClick=${() => setOpenIdx(null)}>← back</button>
                  </span>
                </div>

                <h3 style="margin:0 0 6px;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
                  Step timeline · ${open.completedSteps} / ${open.totalSteps}
                </h3>
                <div class="plan-timeline" style="margin-bottom:14px">
                  ${open.steps.map((step, i) => {
                    const done = open.completedStepIds.includes(step.id);
                    const cls = done ? "done" : i === open.completedSteps ? "active" : "";
                    return html`
                      <div class=${`plan-step ${cls}`}>
                        <span class="lbl">step ${i + 1}</span>
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
