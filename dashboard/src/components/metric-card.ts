import { html } from "../lib/html.js";

export function MetricCard(
  title: string,
  value: unknown,
  hint?: string | null,
  pillVariant?: string | null,
) {
  const muted = value === "—" || value === null || value === undefined;
  return html`
    <div class="card">
      <div class="card-title">${title}</div>
      <div class="card-value ${muted ? "muted" : ""}">${value}</div>
      ${
        hint
          ? pillVariant
            ? html`<div class="card-hint"><span class="pill pill-${pillVariant}">${hint}</span></div>`
            : html`<div class="card-hint">${hint}</div>`
          : null
      }
    </div>
  `;
}
