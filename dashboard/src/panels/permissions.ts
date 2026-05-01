import { useCallback, useState } from "https://esm.sh/preact@10.22.0/hooks";
import { api } from "../lib/api.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";

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
      if (res.alreadyPresent) setFeedback({ kind: "info", text: `${prefix} already in list` });
      else setFeedback({ kind: "ok", text: `added: ${prefix}` });
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
      if (!confirm(`Remove "${prefix}" from this project's allowlist?`)) return;
      setBusy(true);
      setFeedback(null);
      try {
        await api("/permissions", { method: "DELETE", body: { prefix } });
        setFeedback({ kind: "ok", text: `removed: ${prefix}` });
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
    if (!confirm("Wipe every project allowlist entry? Builtin entries are unaffected.")) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api<{ dropped: number }>("/permissions/clear", {
        method: "POST",
        body: { confirm: true },
      });
      setFeedback({
        kind: "ok",
        text: `cleared ${res.dropped} entr${res.dropped === 1 ? "y" : "ies"}`,
      });
      await refresh();
    } catch (err) {
      setFeedback({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (loading && !data) return html`<div class="boot">loading permissions…</div>`;
  if (error) return html`<div class="notice err">permissions failed: ${error.message}</div>`;
  if (!data) return null;
  const p = data;

  const banner =
    p.editMode === "yolo"
      ? html`<div class="notice warn">YOLO mode — every shell command auto-runs, allowlist bypassed. <code>/mode review</code> in TUI re-enables.</div>`
      : null;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Permissions</h2>
        <span class="panel-subtitle">${p.currentCwd ? `project: ${p.currentCwd}` : "no active project"}</span>
      </div>
      ${banner}

      ${
        p.currentCwd
          ? html`
          <div class="row">
            <input
              type="text"
              placeholder='add a prefix, e.g. "npm run build" or "deploy.sh"'
              value=${draft}
              onInput=${(e: Event) => setDraft((e.target as HTMLInputElement).value)}
              onKeyDown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") add();
              }}
              disabled=${busy}
            />
            <button class="primary" onClick=${add} disabled=${busy || !draft.trim()}>Add</button>
            <button class="danger" onClick=${clearAll} disabled=${busy || p.project.length === 0}>Clear all</button>
          </div>
          ${feedback ? html`<div class="notice ${feedback.kind === "err" ? "err" : feedback.kind === "ok" ? "" : "warn"}">${feedback.text}</div>` : null}
        `
          : html`<div class="notice">Mutations require <code>/dashboard</code> from inside an active <code>reasonix code</code> session — standalone <code>reasonix dashboard</code> can't tell which project's allowlist to edit.</div>`
      }

      <div class="section-title">Project allowlist (${p.project.length})</div>
      ${
        p.project.length === 0
          ? html`<div class="empty">Nothing stored yet for this project.</div>`
          : html`
          <table>
            <thead><tr><th>#</th><th>prefix</th><th></th></tr></thead>
            <tbody>
              ${p.project.map(
                (prefix, i) => html`
                <tr>
                  <td class="muted">${i + 1}</td>
                  <td><code>${prefix}</code></td>
                  <td class="numeric">${p.currentCwd ? html`<button class="danger" onClick=${() => remove(prefix)} disabled=${busy}>remove</button>` : null}</td>
                </tr>
              `,
              )}
            </tbody>
          </table>
        `
      }

      <div class="section-title">Builtin allowlist (${p.builtin.length}) — read-only, baked in</div>
      <div class="card mono" style="font-size: 12px; line-height: 1.7;">
        ${groupByVerb(p.builtin).map(
          ([verb, list]) => html`
          <div><span class="pill pill-dim">${verb}</span> ${list.join(" · ")}</div>
        `,
        )}
      </div>
    </div>
  `;
}
