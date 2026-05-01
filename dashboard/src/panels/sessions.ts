import { useCallback, useState } from "preact/hooks";
import { ChatMessage } from "../components/chat-internals.js";
import { api } from "../lib/api.js";
import { fmtBytes, fmtNum, fmtRelativeTime } from "../lib/format.js";
import { html } from "../lib/html.js";
import { usePoll } from "../lib/use-poll.js";

interface SessionEntry {
  name: string;
  messageCount: number;
  size: number;
  mtime: string | number;
}

interface SessionsData {
  sessions?: SessionEntry[];
}

interface OpenSession {
  name: string;
  messages: unknown[] | null;
  error?: string;
}

export function SessionsPanel() {
  const { data, error, loading } = usePoll<SessionsData>("/sessions", 5000);
  const [open, setOpen] = useState<OpenSession | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const view = useCallback(async (name: string) => {
    setOpen({ name, messages: null });
    setOpenLoading(true);
    try {
      const detail = await api<{ messages: unknown[] }>(`/sessions/${encodeURIComponent(name)}`);
      setOpen({ name, messages: detail.messages });
    } catch (err) {
      setOpen({ name, messages: null, error: (err as Error).message });
    } finally {
      setOpenLoading(false);
    }
  }, []);

  if (loading && !data)
    return html`<div class="card" style="color:var(--fg-3)">loading sessions…</div>`;
  if (error) return html`<div class="card accent-err">sessions failed: ${error.message}</div>`;
  const sessions = data?.sessions ?? [];

  if (sessions.length === 0)
    return html`<div class="card" style="color:var(--fg-3)">No saved sessions yet.</div>`;

  const filtered = filter.trim()
    ? sessions.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
    : sessions;

  return html`
    <div class="sessions-grid">
      <div class="sessions-list">
        <div class="ssl-h">
          <input
            type="text"
            placeholder="filter sessions"
            value=${filter}
            onInput=${(e: Event) => setFilter((e.target as HTMLInputElement).value)}
            style="flex:1"
          />
        </div>
        <div class="chips" style="padding:0 12px 8px">
          <span class="chip-f active">all <span class="ct">${sessions.length}</span></span>
        </div>
        <div class="ssl-rows">
          ${filtered.map(
            (s) => html`
              <div
                class=${`ssl-row ${open?.name === s.name ? "sel" : ""}`}
                onClick=${() => view(s.name)}
              >
                <span class="name">${s.name}</span>
                <span class="meta">
                  <span><span class="v">${fmtNum(s.messageCount)}</span> msgs</span>
                  <span><span class="v">${fmtBytes(s.size)}</span></span>
                  <span>${fmtRelativeTime(s.mtime)}</span>
                </span>
              </div>
            `,
          )}
        </div>
      </div>

      <div class="sessions-detail">
        ${
          open == null
            ? html`<div style="color:var(--fg-3);font-size:13px;text-align:center;padding:60px 20px">
                Pick a session on the left to read its transcript.
              </div>`
            : html`
                <div class="sessions-detail-h">
                  <span class="name">${open.name}</span>
                  <span class="ws">
                    ${
                      open.messages
                        ? `${open.messages.length} message${open.messages.length === 1 ? "" : "s"}`
                        : "loading…"
                    }
                  </span>
                  <span class="actions">
                    <button class="btn ghost" onClick=${() => setOpen(null)}>← back</button>
                  </span>
                </div>
                ${
                  openLoading
                    ? html`<div style="color:var(--fg-3)">loading transcript…</div>`
                    : open.error
                      ? html`<div class="card accent-err">${open.error}</div>`
                      : open.messages && open.messages.length > 0
                        ? html`<div class="chat-feed" style="max-height:calc(100vh - 220px);overflow-y:auto">
                            ${open.messages.map(
                              (m: any, i: number) => html`
                                <${ChatMessage}
                                  key=${i}
                                  msg=${{
                                    id: `r-${i}`,
                                    role:
                                      m.role === "tool"
                                        ? "tool"
                                        : m.role === "assistant"
                                          ? "assistant"
                                          : m.role === "user"
                                            ? "user"
                                            : "info",
                                    text: m.content ?? "",
                                    toolName: m.toolName,
                                  }}
                                  streaming=${false}
                                />
                              `,
                            )}
                          </div>`
                        : html`<div style="color:var(--fg-3)">empty transcript.</div>`
                }
              `
        }
      </div>
    </div>
  `;
}
