import { useCallback, useState } from "https://esm.sh/preact@10.22.0/hooks";
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

  if (loading && !data) return html`<div class="boot">loading sessions…</div>`;
  if (error) return html`<div class="notice err">sessions failed: ${error.message}</div>`;
  const sessions = data?.sessions ?? [];

  if (open) {
    return html`
      <div>
        <div class="panel-header">
          <h2 class="panel-title">Session</h2>
          <span class="panel-subtitle">${open.name}</span>
          <button onClick=${() => setOpen(null)} style="margin-left: auto;">← back</button>
        </div>
        ${
          openLoading
            ? html`<div class="boot">loading transcript…</div>`
            : open.error
              ? html`<div class="notice err">${open.error}</div>`
              : open.messages && open.messages.length > 0
                ? html`
                <div class="chat-feed" style="max-height: calc(100vh - 180px); overflow-y: auto;">
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
                </div>
              `
                : html`<div class="empty">empty transcript.</div>`
        }
      </div>
    `;
  }

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Sessions</h2>
        <span class="panel-subtitle">${sessions.length} saved · click to read</span>
      </div>
      ${
        sessions.length === 0
          ? html`<div class="empty">No saved sessions yet.</div>`
          : html`
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th class="numeric">messages</th>
                <th class="numeric">size</th>
                <th class="numeric">last touched</th>
              </tr>
            </thead>
            <tbody>
              ${sessions.map(
                (s) => html`
                <tr key=${s.name} onClick=${() => view(s.name)} style="cursor: pointer;">
                  <td><code>${s.name}</code></td>
                  <td class="numeric">${fmtNum(s.messageCount)}</td>
                  <td class="numeric">${fmtBytes(s.size)}</td>
                  <td class="numeric muted">${fmtRelativeTime(s.mtime)}</td>
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
