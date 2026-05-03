import { useCallback, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";
import { t, useLang } from "../i18n/index.js";

interface PermissionsData {
  editMode?: string;
  currentCwd?: string | null;
  project: string[];
  builtin: string[];
}

interface Feedback {
  kind: "ok" | "err" | "info";
  text: string;
}

function groupByVerb(list: string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const entry of list) {
    const sp = entry.indexOf(" ");
    const verb = sp > 0 ? entry.slice(0, sp) : entry;
    const tail = sp > 0 ? entry.slice(sp + 1) : "";
    const arr = groups.get(verb) ?? [];
    arr.push(tail);
    groups.set(verb, arr);
  }
  return [...groups.entries()];
}

export function PermissionsPanel() {
  useLang();
  const { data, error, loading, refresh } = usePoll<PermissionsData>("/permissions", 5000);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const add = useCallback(async () => {
    const prefix = draft.trim();
    if (!prefix) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api<{ alreadyPresent?: boolean }>("/permissions", {
        method: "POST",
        body: { prefix },
      });
      if (res.alreadyPresent) setFeedback({ kind: "info", text: t("permissions.alreadyIn", { prefix }) });
      else setFeedback({ kind: "ok", text: t("permissions.added", { prefix }) });
      setDraft("");
      await refresh();
    } catch (err) {
      setFeedback({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [draft, refresh]);

  const remove = useCallback(
    async (prefix: string) => {
      if (!confirm(t("permissions.removeConfirm", { prefix }))) return;
      setBusy(true);
      setFeedback(null);
      try {
        await api("/permissions", { method: "DELETE", body: { prefix } });
        setFeedback({ kind: "ok", text: t("permissions.removed", { prefix }) });
        await refresh();
      } catch (err) {
        setFeedback({ kind: "err", text: (err as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const clearAll = useCallback(async () => {
    if (!confirm(t("permissions.clearConfirm"))) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api<{ dropped: number }>("/permissions/clear", {
        method: "POST",
        body: { confirm: true },
      });
      setFeedback({
        kind: "ok",
        text: t("permissions.cleared", { count: res.dropped, y: res.dropped === 1 ? "y" : "ies" }),
      });
      await refresh();
    } catch (err) {
      setFeedback({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">${t("permissions.loading")}</div>`;
  if (error) return html`<div class="card accent-err">${t("common.loadingFailed", { name: "permissions", error: error.message })}</div>`;
  if (!data) return null;
  const p = data;

  const feedbackPill = feedback
    ? html`<span
        class=${`pill ${feedback.kind === "err" ? "err" : feedback.kind === "ok" ? "ok" : "warn"}`}
      >${feedback.text}</span>`
    : null;

  return html`
    <div style="display:flex;flex-direction:column;gap:14px">
      ${
        p.editMode === "yolo"
          ? html`<div class="card accent-warn">
              <div class="card-h"><span class="title" style="color:var(--c-warn)">${t("permissions.yoloTitle")}</span></div>
              <div class="card-b">
                ${t("permissions.yoloDesc")}
              </div>
            </div>`
          : null
      }

      <div class="chips">
        <span class="chip-f active">${t("permissions.project")} <span class="ct">${p.project.length}</span></span>
        <span class="chip-f">${t("permissions.builtin")} <span class="ct">${p.builtin.length}</span></span>
      </div>

      ${
        p.currentCwd
          ? html`
            <div class="card">
              <div class="card-h">
                <span class="title">${t("permissions.addPrefix")}</span>
                <span class="meta">${p.currentCwd}</span>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <input
                  type="text"
                  placeholder=${t("permissions.addPlaceholder")}
                  value=${draft}
                  onInput=${(e: Event) => setDraft((e.target as HTMLInputElement).value)}
                  onKeyDown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter") add();
                  }}
                  disabled=${busy}
                  style="flex:1"
                />
                <button class="primary" onClick=${add} disabled=${busy || !draft.trim()}>${t("common.add")}</button>
                <button
                  class="danger"
                  onClick=${clearAll}
                  disabled=${busy || p.project.length === 0}
                >${t("permissions.clearAll")}</button>
              </div>
              ${feedbackPill ? html`<div style="margin-top:8px">${feedbackPill}</div>` : null}
            </div>
          `
          : html`
            <div class="card accent-warn">
              <div class="card-b">
                ${t("permissions.standaloneWarning")}
              </div>
            </div>
          `
      }

      <h3 style="margin:6px 0 0;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
        ${t("permissions.projectAllowlist", { count: p.project.length })}
      </h3>
      ${
        p.project.length === 0
          ? html`<div class="card" style="color:var(--fg-3)">${t("permissions.nothingStored")}</div>`
          : html`
            <div class="card" style="padding:0;overflow:hidden">
              <table class="tbl">
                <thead>
                  <tr>
                    <th style="width:48px">${t("permissions.colNum")}</th>
                    <th>${t("permissions.colPrefix")}</th>
                    <th style="width:120px"></th>
                  </tr>
                </thead>
                <tbody>
                  ${p.project.map(
                    (prefix, i) => html`
                      <tr>
                        <td class="dim">${i + 1}</td>
                        <td><code class="mono">${prefix}</code></td>
                        <td>
                          ${
                            p.currentCwd
                              ? html`<button
                                  class="danger"
                                  onClick=${() => remove(prefix)}
                                  disabled=${busy}
                                >${t("common.remove")}</button>`
                              : null
                          }
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `
      }

      <h3 style="margin:6px 0 0;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">
        ${t("permissions.builtinTitle", { count: p.builtin.length })}
      </h3>
      <div class="card" style="font-family:var(--font-mono);font-size:11.5px;line-height:1.8">
        ${groupByVerb(p.builtin).map(
          ([verb, list]) => html`
            <div style="margin-bottom:4px">
              <span class="pill" style="margin-right:6px">${verb}</span>
              <span style="color:var(--fg-2)">${list.join(" · ")}</span>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}
