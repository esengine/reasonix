import { useState } from "https://esm.sh/preact@10.22.0/hooks";
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

export function PlansPanel() {
  const { data, error, loading } = usePoll<PlansData>("/plans", 8000);
  const [open, setOpen] = useState<ArchivedPlan | null>(null);
  if (loading && !data) return html`<div class="boot">loading plans…</div>`;
  if (error) return html`<div class="notice err">plans failed: ${error.message}</div>`;
  const plans = data?.plans ?? [];

  if (open) {
    const completedSet = new Set(open.completedStepIds);
    return html`
      <div>
        <div class="panel-header">
          <h2 class="panel-title">Plan</h2>
          <span class="panel-subtitle">${open.session} · ${fmtRelativeTime(open.completedAt)}</span>
          <button onClick=${() => setOpen(null)} style="margin-left: auto;">← back</button>
        </div>
        ${open.summary ? html`<div class="notice">${open.summary}</div>` : null}
        <div class="card">
          ${open.steps.map((step) => {
            const done = completedSet.has(step.id);
            return html`
              <div style="padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; gap: 12px;">
                <div style="width: 16px; color: ${done ? "var(--ok)" : "var(--fg-3)"}; font-family: var(--mono);">
                  ${done ? "✓" : "·"}
                </div>
                <div style="flex: 1;">
                  <div style="color: ${done ? "var(--fg-2)" : "var(--fg-0)"}; font-weight: 500;">
                    ${step.title}
                  </div>
                  ${step.action ? html`<div style="color: var(--fg-2); font-size: 12px; margin-top: 2px;">${step.action}</div>` : null}
                  ${step.risk ? html`<span class="pill pill-${step.risk === "high" ? "err" : step.risk === "medium" ? "warn" : "dim"}" style="margin-top: 4px;">${step.risk}</span>` : null}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Plans</h2>
        <span class="panel-subtitle">${plans.length} archived · click to view</span>
      </div>
      ${
        plans.length === 0
          ? html`<div class="empty">No archived plans yet — run a turn that calls <code>submit_plan</code> + <code>mark_step_complete</code>.</div>`
          : html`
          <table>
            <thead>
              <tr>
                <th>session</th>
                <th>title</th>
                <th class="numeric">progress</th>
                <th class="numeric">archived</th>
              </tr>
            </thead>
            <tbody>
              ${plans.map(
                (p, i) => html`
                <tr key=${i} onClick=${() => setOpen(p)} style="cursor: pointer;">
                  <td><code>${p.session}</code></td>
                  <td>${p.summary ?? html`<span class="muted">(no title)</span>`}</td>
                  <td class="numeric">${p.completedSteps}/${p.totalSteps} · ${fmtPct(p.completionRatio)}</td>
                  <td class="numeric muted">${fmtRelativeTime(p.completedAt)}</td>
                </tr>
              `,
              )}
            </tbody>
          </table>
        `
      }
    </div>
  `;
}
