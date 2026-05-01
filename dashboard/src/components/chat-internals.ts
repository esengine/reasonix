// @ts-nocheck — bulk JS-style migration; tighten types in a follow-up.
import { useState } from "https://esm.sh/preact@10.22.0/hooks";
import { marked } from "https://esm.sh/marked@12.0.2";
import { html } from "../lib/html.js";
import {
  escapeHtml,
  hlLine,
  langFromPath,
  renderHighlightedBlock,
  renderMarkdownToString,
  renderSearchReplace,
} from "../lib/markdown.js";

const ROLE_GLYPH = {
  user: "◇",
  assistant: "◆",
  tool: "▣",
  info: "·",
  warning: "▲",
  error: "✦",
};

export function renderMessageBody(text) {
  if (!text) return null;
  return html`<div class="md" dangerouslySetInnerHTML=${{ __html: renderMarkdownToString(text) }}></div>`;
}

function parseToolArgs(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function ToolCard({ msg }) {
  const args = parseToolArgs(msg.toolArgs);
  const name = msg.toolName ?? "tool";
  // Reasonix's filesystem tools emit the path in args.path; MCP-bridged
  // ones may differ but most expose a `path` field too. Normalize.
  const path = args?.path ?? args?.file_path ?? args?.filename;

  // edit_file (Reasonix) — search/replace pair → diff view.
  if (
    (name === "edit_file" || name.endsWith("_edit_file")) &&
    args &&
    typeof args.search === "string" &&
    typeof args.replace === "string"
  ) {
    const diffHtml = renderSearchReplace(args.search, args.replace, path ?? "");
    return html`
      <div class="tool-card">
        <div class="tool-card-head">
          <span class="tool-card-icon">✎</span>
          <span class="tool-card-name">edit_file</span>
          ${path ? html`<code class="tool-card-path">${path}</code>` : null}
        </div>
        <div dangerouslySetInnerHTML=${{ __html: diffHtml }}></div>
        ${msg.text ? html`<div class="tool-card-result">${msg.text}</div>` : null}
      </div>
    `;
  }

  // write_file — show new content as a code block with path-derived lang.
  if (
    (name === "write_file" || name.endsWith("_write_file")) &&
    args &&
    typeof args.content === "string"
  ) {
    const lang = langFromPath(path);
    return html`
      <div class="tool-card">
        <div class="tool-card-head">
          <span class="tool-card-icon">+</span>
          <span class="tool-card-name">write_file</span>
          ${path ? html`<code class="tool-card-path">${path}</code>` : null}
          ${lang ? html`<span class="pill pill-dim">${lang}</span>` : null}
        </div>
        <div dangerouslySetInnerHTML=${{ __html: renderHighlightedBlock(args.content, lang) }}></div>
        ${msg.text ? html`<div class="tool-card-result">${msg.text}</div>` : null}
      </div>
    `;
  }

  // read_file / list_files — content lands in msg.text.
  if (name === "read_file" || name.endsWith("_read_file") || name === "filesystem_read_file") {
    const lang = langFromPath(path);
    return html`
      <div class="tool-card">
        <div class="tool-card-head">
          <span class="tool-card-icon">▤</span>
          <span class="tool-card-name">read_file</span>
          ${path ? html`<code class="tool-card-path">${path}</code>` : null}
          ${lang ? html`<span class="pill pill-dim">${lang}</span>` : null}
        </div>
        <div dangerouslySetInnerHTML=${{ __html: renderHighlightedBlock(msg.text, lang) }}></div>
      </div>
    `;
  }

  // run_command / run_background — terminal-style.
  if (name === "run_command" || name === "run_background") {
    const cmd = args?.command;
    return html`
      <div class="tool-card">
        <div class="tool-card-head">
          <span class="tool-card-icon">⚡</span>
          <span class="tool-card-name">${name === "run_background" ? "run_background" : "run_command"}</span>
        </div>
        ${
          cmd
            ? html`<pre class="tool-card-cmd"><span class="tool-card-prompt">$</span> <code>${cmd}</code></pre>`
            : null
        }
        ${msg.text ? html`<pre class="tool-card-output">${msg.text}</pre>` : null}
      </div>
    `;
  }

  // list_files / file_exists / delete_file — show args + result inline.
  if (
    name === "list_files" ||
    name === "file_exists" ||
    name === "delete_file" ||
    name === "create_directory" ||
    name === "delete_directory" ||
    name.endsWith("_list_files")
  ) {
    return html`
      <div class="tool-card">
        <div class="tool-card-head">
          <span class="tool-card-icon">▣</span>
          <span class="tool-card-name">${name}</span>
          ${path ? html`<code class="tool-card-path">${path}</code>` : null}
        </div>
        <pre class="tool-card-output">${msg.text}</pre>
      </div>
    `;
  }

  // Default — keep the legacy compact box but add an args preview when
  // present so MCP-bridged tools still surface something readable.
  return html`
    <div class="tool-card">
      <div class="tool-card-head">
        <span class="tool-card-icon">▣</span>
        <span class="tool-card-name">${name}</span>
      </div>
      ${
        args
          ? html`<details class="tool-card-args"><summary>arguments</summary><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre></details>`
          : null
      }
      <pre class="tool-card-output">${msg.text}</pre>
    </div>
  `;
}

export function ChatMessage({ msg, streaming }) {
  const role = msg.role;
  const glyph = ROLE_GLYPH[role] ?? "·";
  if (role === "tool") {
    return html`
      <div class="chat-msg tool">
        <div class="glyph">${glyph}</div>
        <${ToolCard} msg=${msg} />
      </div>
    `;
  }
  return html`
    <div class="chat-msg ${role}">
      <div class="glyph">${glyph}</div>
      <div class="body">
        ${msg.reasoning ? html`<div class="reasoning">${msg.reasoning}</div>` : null}
        ${renderMessageBody(msg.text)}
        ${streaming ? html`<span class="chat-streaming-cursor"></span>` : null}
      </div>
    </div>
  `;
}

// ---------- Modal components mirroring the TUI ----------
//
// Each component renders a card matching the TUI's ModalCard accent
// palette: red for shell (run-now), magenta for choice (branching),
// cyan for plan (decision), green for edits. onResolve pushes to the
// server; the SSE channel will echo back a modal-down that clears the
// local state — both surfaces stay in lockstep without polling.

export function ModalCard({ accent, icon, title, subtitle, children }) {
  return html`
    <div class="modal-card" style=${`border-left-color: ${accent};`}>
      <div class="modal-card-head">
        <span class="modal-card-icon" style=${`color: ${accent};`}>${icon}</span>
        <div>
          <div class="modal-card-title">${title}</div>
          ${subtitle ? html`<div class="modal-card-subtitle">${subtitle}</div>` : null}
        </div>
      </div>
      ${children}
    </div>
  `;
}

export function ShellModal({ modal, onResolve }) {
  const isBg = modal.shellKind === "run_background";
  return html`
    <${ModalCard}
      accent="#f87171"
      icon=${isBg ? "⏱" : "⚡"}
      title=${isBg ? "background process" : "shell command"}
      subtitle=${
        isBg ? "long-running — keeps running after approval" : "model wants to run a shell command"
      }
    >
      <div class="modal-cmd"><span class="modal-cmd-prompt">$</span> <code>${modal.command}</code></div>
      <div class="modal-actions">
        <button class="primary" onClick=${() => onResolve("shell", "run_once")}>Run once</button>
        <button onClick=${() => onResolve("shell", "always_allow")}>Always allow "${modal.allowPrefix}"</button>
        <button class="danger" onClick=${() => onResolve("shell", "deny")}>Deny</button>
      </div>
    <//>
  `;
}

export function ChoiceModal({ modal, onResolve }) {
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  return html`
    <${ModalCard} accent="#f0abfc" icon="🔀" title="model wants you to pick" subtitle=${modal.question}>
      ${modal.options.map(
        (opt) => html`
        <button
          key=${opt.id}
          class="modal-choice-row"
          onClick=${() => onResolve("choice", { kind: "pick", optionId: opt.id })}
        >
          <span class="modal-choice-id">${opt.id}</span>
          <span class="modal-choice-title">${opt.title}</span>
          ${opt.summary ? html`<span class="modal-choice-summary">${opt.summary}</span>` : null}
        </button>
      `,
      )}
      ${
        modal.allowCustom
          ? showCustom
            ? html`
            <div class="modal-custom">
              <textarea
                placeholder="Type a free-form answer…"
                rows="2"
                value=${custom}
                onInput=${(e) => setCustom(e.target.value)}
              ></textarea>
              <div class="modal-actions">
                <button class="primary" onClick=${() => onResolve("choice", { kind: "custom", text: custom })} disabled=${!custom.trim()}>Send</button>
                <button onClick=${() => {
                  setShowCustom(false);
                  setCustom("");
                }}>Back</button>
              </div>
            </div>
          `
            : html`
            <button class="modal-choice-row" onClick=${() => setShowCustom(true)}>
              <span class="modal-choice-id">·</span>
              <span class="modal-choice-title">Type my own answer</span>
              <span class="modal-choice-summary">None of the above fits — write a free-form reply.</span>
            </button>
          `
          : null
      }
      <button class="modal-choice-row modal-choice-cancel" onClick=${() => onResolve("choice", { kind: "cancel" })}>
        <span class="modal-choice-id">×</span>
        <span class="modal-choice-title">Cancel</span>
        <span class="modal-choice-summary">Drop the question. Model will ask what you actually want.</span>
      </button>
    <//>
  `;
}

export function PlanModal({ modal, onResolve }) {
  const [feedback, setFeedback] = useState("");
  const [stage, setStage] = useState(null); // null | "approve" | "refine"
  const send = () => onResolve("plan", stage, feedback);
  return html`
    <${ModalCard} accent="#67e8f9" icon="◆" title="plan submitted" subtitle="model proposed a plan; review then pick">
      <div class="md modal-plan-body" dangerouslySetInnerHTML=${{ __html: marked.parse(modal.body || "") }}></div>
      ${
        stage
          ? html`
          <textarea
            placeholder=${
              stage === "approve"
                ? "Optional last instructions / answers to open questions (Enter to send blank)"
                : "What needs to change? Be specific."
            }
            rows="3"
            value=${feedback}
            onInput=${(e) => setFeedback(e.target.value)}
          ></textarea>
          <div class="modal-actions">
            <button class="primary" onClick=${send}>${stage === "approve" ? "Approve" : "Send refinement"}</button>
            <button onClick=${() => {
              setStage(null);
              setFeedback("");
            }}>Back</button>
          </div>
        `
          : html`
          <div class="modal-actions">
            <button class="primary" onClick=${() => setStage("approve")}>Approve</button>
            <button onClick=${() => setStage("refine")}>Refine</button>
            <button class="danger" onClick=${() => onResolve("plan", "cancel")}>Cancel</button>
          </div>
        `
      }
    <//>
  `;
}

// Line-level LCS diff. Returns an ordered list of rows; "context" rows
// appear on both sides, "del" only on the left (red), "ins" only on the
// right (green). Adjacent del/ins are paired into one row downstream so
// the change reads "old → new" left-to-right like a git side-by-side.
function lineDiff(aLines, bLines) {
  const m = aLines.length;
  const n = bLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aLines[i - 1] === bLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      out.push({ kind: "context", text: aLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.push({ kind: "ins", text: bLines[j - 1] });
      j--;
    } else {
      out.push({ kind: "del", text: aLines[i - 1] });
      i--;
    }
  }
  return out.reverse();
}

// Pair del/ins runs into side-by-side rows. A run of consecutive dels
// followed by a run of inss collapses into rows of (del[k], ins[k]) so
// the modified line lines up across the gutter; surplus on either side
// produces rows with the opposite cell empty.
function pairDiffRows(diff) {
  const rows = [];
  let k = 0;
  while (k < diff.length) {
    if (diff[k].kind === "context") {
      rows.push({ left: diff[k].text, right: diff[k].text, kind: "context" });
      k++;
      continue;
    }
    const dels = [];
    const inss = [];
    while (k < diff.length && diff[k].kind === "del") {
      dels.push(diff[k].text);
      k++;
    }
    while (k < diff.length && diff[k].kind === "ins") {
      inss.push(diff[k].text);
      k++;
    }
    const pairs = Math.max(dels.length, inss.length);
    for (let p = 0; p < pairs; p++) {
      rows.push({
        left: dels[p] ?? null,
        right: inss[p] ?? null,
        kind: dels[p] != null && inss[p] != null ? "change" : dels[p] != null ? "del" : "ins",
      });
    }
  }
  return rows;
}

export function EditReviewModal({ modal, onResolve }) {
  const search = modal.search ?? "";
  const replace = modal.replace ?? "";
  const lang = langFromPath(modal.path);
  const aLines = search.split("\n");
  const bLines = replace.split("\n");
  const rows = pairDiffRows(lineDiff(aLines, bLines));

  return html`
    <${ModalCard}
      accent="#86efac"
      icon="◆"
      title="edit pending review"
      subtitle=${`${modal.path} · ${modal.remaining} of ${modal.total} blocks remaining`}
    >
      <div class="edit-diff-wrap">
        <div class="edit-diff-head">
          <div class="edit-diff-side edit-diff-side-old">
            <span class="edit-diff-marker">−</span> before
          </div>
          <div class="edit-diff-side edit-diff-side-new">
            <span class="edit-diff-marker">+</span> after
          </div>
        </div>
        <div class="edit-diff-body">
          ${rows.map(
            (row, i) => html`
            <div key=${i} class=${`edit-diff-row edit-diff-row-${row.kind}`}>
              <div class="edit-diff-cell edit-diff-cell-old">
                ${
                  row.left != null
                    ? html`<span
                        class="edit-diff-line"
                        dangerouslySetInnerHTML=${{ __html: hlLine(row.left, lang) || "&nbsp;" }}
                      ></span>`
                    : html`<span class="edit-diff-empty">&nbsp;</span>`
                }
              </div>
              <div class="edit-diff-cell edit-diff-cell-new">
                ${
                  row.right != null
                    ? html`<span
                        class="edit-diff-line"
                        dangerouslySetInnerHTML=${{ __html: hlLine(row.right, lang) || "&nbsp;" }}
                      ></span>`
                    : html`<span class="edit-diff-empty">&nbsp;</span>`
                }
              </div>
            </div>
          `,
          )}
        </div>
      </div>
      <div class="modal-actions">
        <button class="primary" onClick=${() => onResolve("edit-review", "apply")}>Apply (y)</button>
        <button onClick=${() => onResolve("edit-review", "reject")}>Reject (n)</button>
        <button onClick=${() => onResolve("edit-review", "apply-rest-of-turn")}>Apply rest (a)</button>
        <button onClick=${() => onResolve("edit-review", "flip-to-auto")}>Flip to AUTO (A)</button>
      </div>
    <//>
  `;
}

export function WorkspaceModal({ modal, onResolve }) {
  return html`
    <${ModalCard}
      accent="#fbbf24"
      icon="◇"
      title="model wants to switch workspace"
      subtitle="every subsequent file / shell / memory tool resolves against the new root"
    >
      <div class="modal-cmd"><span class="modal-cmd-prompt">→</span> <code>${modal.path}</code></div>
      <div class="modal-actions">
        <button class="primary" onClick=${() => onResolve("workspace", "switch")}>Switch (Enter)</button>
        <button class="danger" onClick=${() => onResolve("workspace", "deny")}>Deny (Esc)</button>
      </div>
    <//>
  `;
}

export function CheckpointModal({ modal, onResolve }) {
  const [reviseText, setReviseText] = useState("");
  const [staged, setStaged] = useState(false);
  const label = modal.title ? `${modal.stepId} · ${modal.title}` : modal.stepId;
  const counter = modal.total > 0 ? ` (${modal.completed}/${modal.total})` : "";
  return html`
    <${ModalCard}
      accent="#a5f3fc"
      icon="✓"
      title=${`step complete${counter}`}
      subtitle=${label}
    >
      ${
        staged
          ? html`
          <textarea
            placeholder="What needs to change before the next step? Leave blank to just continue."
            rows="3"
            value=${reviseText}
            onInput=${(e) => setReviseText(e.target.value)}
          ></textarea>
          <div class="modal-actions">
            <button class="primary" onClick=${() => onResolve("checkpoint", "revise", reviseText)}>Send revision</button>
            <button onClick=${() => {
              setStaged(false);
              setReviseText("");
            }}>Back</button>
          </div>
        `
          : html`
          <div class="modal-actions">
            <button class="primary" onClick=${() => onResolve("checkpoint", "continue")}>Continue</button>
            <button onClick=${() => setStaged(true)}>Revise…</button>
            <button class="danger" onClick=${() => onResolve("checkpoint", "stop")}>Stop</button>
          </div>
        `
      }
    <//>
  `;
}

export function RevisionModal({ modal, onResolve }) {
  const riskColor = (r) =>
    r === "high" ? "#f87171" : r === "med" ? "#fbbf24" : r === "low" ? "#86efac" : "#9ca3af";
  return html`
    <${ModalCard}
      accent="#c4b5fd"
      icon="✎"
      title="model proposed a plan revision"
      subtitle=${modal.summary || modal.reason}
    >
      <div class="modal-revise-reason">${modal.reason}</div>
      <ol class="modal-revise-steps">
        ${modal.remainingSteps.map(
          (s) => html`
            <li key=${s.id}>
              <span class="modal-revise-dot" style=${`background:${riskColor(s.risk)}`}></span>
              <span class="modal-revise-id">${s.id}</span>
              <span class="modal-revise-title">${s.title}</span>
              <span class="modal-revise-action">${s.action}</span>
            </li>
          `,
        )}
      </ol>
      <div class="modal-actions">
        <button class="primary" onClick=${() => onResolve("revision", "accept")}>Accept</button>
        <button class="danger" onClick=${() => onResolve("revision", "reject")}>Reject</button>
      </div>
    <//>
  `;
}
