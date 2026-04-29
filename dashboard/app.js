// Reasonix dashboard SPA — Preact 10 + HTM, no build step.
//
// CDN imports use esm.sh (provides ESM bundles of npm packages with
// caching). We pin minor versions; bumping is a deliberate choice.

import hljs from "https://esm.sh/highlight.js@11.10.0/lib/common";
import htm from "https://esm.sh/htm@3.1.1";
import { Marked, marked } from "https://esm.sh/marked@12.0.2";
import { Component, h, render } from "https://esm.sh/preact@10.22.0";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "https://esm.sh/preact@10.22.0/hooks";

const html = htm.bind(h);

// ---------- Markdown rendering ----------
//
// Rules:
//  - GFM (tables, strikethrough, autolinks).
//  - Code blocks with a known language → highlight.js. Auto-detect
//    when the fence has no language. The CSS in app.css picks colors
//    from our palette so the result reads as Reasonix's TUI, not as
//    GitHub's.
//  - Code blocks that look like Reasonix's edit_file SEARCH/REPLACE
//    or a unified diff → custom diff renderer with red/green lines
//    matching the TUI's edit-block view.

function escapeHtml(s) {
  // Defensive: marked occasionally hands the renderer `text === undefined`
  // for empty / malformed fences (and the token-vs-positional ambiguity
  // around v12 makes it easier to crash than not). Coerce to string
  // instead of letting `.replace` blow up.
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SEARCH_REPLACE_RE = /<{7}\s*SEARCH\s*\n([\s\S]*?)\n={7}\s*\n([\s\S]*?)\n>{7}\s*REPLACE/;

function renderSearchReplace(search, replace, file) {
  const safeSearch = typeof search === "string" ? search : String(search ?? "");
  const safeReplace = typeof replace === "string" ? replace : String(replace ?? "");
  const oldLines = safeSearch
    .split("\n")
    .map((l) => `<span class="diff-line del">- ${escapeHtml(l)}</span>`)
    .join("\n");
  const newLines = safeReplace
    .split("\n")
    .map((l) => `<span class="diff-line ins">+ ${escapeHtml(l)}</span>`)
    .join("\n");
  const header = file ? `<span class="diff-line hunk">▸ edit ${escapeHtml(file)}</span>\n` : "";
  return `<pre class="diff-block">${header}${oldLines}\n${newLines}</pre>`;
}

function renderUnifiedDiff(text) {
  const safe = typeof text === "string" ? text : String(text ?? "");
  const lines = safe
    .split("\n")
    .map((l) => {
      if (l.startsWith("+++") || l.startsWith("---")) {
        return `<span class="diff-line meta">${escapeHtml(l)}</span>`;
      }
      if (l.startsWith("+")) {
        return `<span class="diff-line ins">${escapeHtml(l)}</span>`;
      }
      if (l.startsWith("-")) {
        return `<span class="diff-line del">${escapeHtml(l)}</span>`;
      }
      if (l.startsWith("@@")) {
        return `<span class="diff-line hunk">${escapeHtml(l)}</span>`;
      }
      return escapeHtml(l);
    })
    .join("\n");
  return `<pre class="diff-block">${lines}</pre>`;
}

const renderer = new marked.Renderer();
// Accept BOTH calling conventions so we don't crash if marked changes
// shape between versions:
//   - v12+ token object: renderer.code({ type, raw, lang, text, ... })
//   - legacy positional:  renderer.code(text, lang, escaped)
// Either path normalizes to `{ text, lang }`. Empty / nullable text is
// coerced to "" (escapeHtml does the same) so an empty fence renders
// as an empty code block rather than throwing.
renderer.code = function reasonixCode(arg1, arg2 /* legacy lang */) {
  let text;
  let lang;
  if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1)) {
    text = arg1.text;
    lang = arg1.lang;
  } else {
    text = arg1;
    lang = arg2;
  }
  if (text == null) text = "";
  if (typeof text !== "string") text = String(text);
  // Reasonix's edit_file marker block. Show as red/green diff with a
  // small "▸ edit <file>" header lifted from the language tag (e.g.
  // ```edit:src/foo.ts → file = src/foo.ts).
  const sr = SEARCH_REPLACE_RE.exec(text);
  if (sr) {
    const file = typeof lang === "string" && lang.startsWith("edit:") ? lang.slice(5) : "";
    return renderSearchReplace(sr[1], sr[2], file);
  }
  if (lang === "diff") {
    return renderUnifiedDiff(text);
  }
  // Standard highlight.js path — explicit language wins, otherwise auto.
  if (lang && typeof lang === "string" && hljs.getLanguage(lang)) {
    try {
      const h = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      return `<pre><code class="hljs language-${lang}">${h}</code></pre>`;
    } catch {
      /* fall through to auto */
    }
  }
  try {
    const auto = hljs.highlightAuto(text);
    return `<pre><code class="hljs">${auto.value}</code></pre>`;
  } catch {
    return `<pre><code>${escapeHtml(text)}</code></pre>`;
  }
};

marked.use({ renderer, gfm: true, breaks: false, pedantic: false });

// Separate Marked instance for the editor's markdown preview. The chat
// renderer above does fancy SEARCH/REPLACE diff blocks and stamps every
// code fence through hljs — useful inside an assistant message, but
// disruptive when the user is just previewing a normal README and
// expects standard `<pre><code>` blocks. Vanilla rendering also avoids
// any chance our custom token-shape sniffing breaks on real markdown.
const previewMarked = new Marked({ gfm: true, breaks: false, pedantic: false });
previewMarked.use({
  renderer: {
    code(...args) {
      const first = args[0];
      const arg = first && typeof first === "object" ? first : { text: first, lang: args[1] };
      const text = arg.text == null ? "" : String(arg.text);
      const lang = typeof arg.lang === "string" ? arg.lang : "";
      try {
        const out =
          lang && hljs.getLanguage(lang)
            ? hljs.highlight(text, { language: lang, ignoreIllegals: true })
            : hljs.highlightAuto(text);
        const cls = lang ? `hljs language-${lang}` : "hljs";
        return `<pre><code class="${cls}">${out.value}</code></pre>`;
      } catch {
        return `<pre><code>${escapeHtml(text)}</code></pre>`;
      }
    },
  },
});

// ---------- bootstrapping ----------

const TOKEN = document.querySelector('meta[name="reasonix-token"]')?.getAttribute("content") ?? "";
const MODE =
  document.querySelector('meta[name="reasonix-mode"]')?.getAttribute("content") ?? "standalone";

// Helper: every fetch tacks the token onto the URL (reads) and the
// header (mutations). Server logic in src/server/index.ts requires
// the header form for any non-GET.
async function api(path, opts = {}) {
  const method = opts.method ?? "GET";
  const url = `/api${path}${path.includes("?") ? "&" : "?"}token=${TOKEN}`;
  const headers = { ...(opts.headers ?? {}) };
  headers["X-Reasonix-Token"] = TOKEN;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text };
  }
  if (!res.ok) {
    const err = new Error(parsed?.error ?? `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// usePoll: re-fetch a GET endpoint every `intervalMs`, returning
// `{ data, error, loading, refresh }`. v0.13 swaps this for SSE.
function usePoll(path, intervalMs = 2000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api(path);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
}

// ---------- formatting helpers ----------

function fmtUsd(n) {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  return `$${n.toFixed(n < 0.01 ? 6 : 4)}`;
}

function fmtPct(n) {
  if (n === null || n === undefined) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtNum(n) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString();
}

function fmtBytes(n) {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtRelativeTime(iso) {
  if (!iso) return "—";
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const dSec = (Date.now() - ms) / 1000;
  if (dSec < 60) return "just now";
  if (dSec < 3600) return `${Math.floor(dSec / 60)}m ago`;
  if (dSec < 86400) return `${Math.floor(dSec / 3600)}h ago`;
  if (dSec < 30 * 86400) return `${Math.floor(dSec / 86400)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------- panels ----------

function OverviewPanel() {
  const { data, error, loading } = usePoll("/overview", 2000);
  if (loading && !data) return html`<div class="boot">loading overview…</div>`;
  if (error) return html`<div class="notice err">overview failed: ${error.message}</div>`;
  const o = data;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Live Cockpit</h2>
        <span class="panel-subtitle">${o.mode === "attached" ? "attached to running session" : "standalone (read-only disk view)"}</span>
      </div>

      ${o.mode === "standalone" ? html`<div class="notice">Standalone mode — start <code>/dashboard</code> from inside <code>reasonix code</code> for live session state, MCP, and tools.</div>` : null}

      <div class="metric-grid">
        ${MetricCard("Reasonix", o.version, o.latestVersion && o.latestVersion !== o.version ? `latest: ${o.latestVersion}` : "current")}
        ${MetricCard("Session", o.session ?? "—", o.session === null ? "ephemeral or disconnected" : null)}
        ${MetricCard("Model", o.model ?? "—", o.model ? "active" : null)}
        ${MetricCard("Edit mode", o.editMode ?? "—", o.editMode === "yolo" ? "all prompts bypassed" : null, o.editMode === "yolo" ? "warn" : null)}
        ${MetricCard("Plan mode", o.planMode === null ? "—" : o.planMode ? "ON" : "off", o.planMode ? "writes gated" : null)}
        ${MetricCard("Pending edits", fmtNum(o.pendingEdits), o.pendingEdits ? "awaiting /apply" : null)}
        ${MetricCard("MCP servers", fmtNum(o.mcpServerCount), null)}
        ${MetricCard("Tools", fmtNum(o.toolCount), null)}
      </div>

      <div class="section-title">Working directory</div>
      <div class="card">
        <div class="card-value mono" style="font-size: 14px;">${o.cwd ?? "—"}</div>
      </div>
    </div>
  `;
}

function MetricCard(title, value, hint, pillVariant) {
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

function UsagePanel() {
  const { data, error, loading } = usePoll("/usage", 5000);
  if (loading && !data) return html`<div class="boot">loading usage…</div>`;
  if (error) return html`<div class="notice err">usage failed: ${error.message}</div>`;
  const u = data;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Usage</h2>
        <span class="panel-subtitle">${u.recordCount.toLocaleString()} records · ${u.logSize}</span>
      </div>

      ${
        u.recordCount === 0
          ? html`<div class="empty">No usage data yet — run a turn in <code>reasonix chat</code> / <code>code</code> / <code>run</code> and refresh.</div>`
          : html`
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="numeric">turns</th>
                <th class="numeric">cache hit</th>
                <th class="numeric">cost (USD)</th>
                <th class="numeric">cache saved</th>
                <th class="numeric">vs Claude</th>
                <th class="numeric">saved</th>
              </tr>
            </thead>
            <tbody>
              ${u.buckets.map((b) => {
                const hitRatio =
                  b.cacheHitTokens + b.cacheMissTokens > 0
                    ? b.cacheHitTokens / (b.cacheHitTokens + b.cacheMissTokens)
                    : 0;
                const claudeSavings = b.claudeEquivUsd > 0 ? 1 - b.costUsd / b.claudeEquivUsd : 0;
                return html`
                  <tr>
                    <td>${b.label}</td>
                    <td class="numeric">${fmtNum(b.turns)}</td>
                    <td class="numeric">${b.turns > 0 ? fmtPct(hitRatio) : "—"}</td>
                    <td class="numeric">${b.turns > 0 ? fmtUsd(b.costUsd) : "—"}</td>
                    <td class="numeric">${b.turns > 0 && b.cacheSavingsUsd > 0 ? fmtUsd(b.cacheSavingsUsd) : "—"}</td>
                    <td class="numeric">${b.turns > 0 ? fmtUsd(b.claudeEquivUsd) : "—"}</td>
                    <td class="numeric">${b.turns > 0 && claudeSavings > 0 ? fmtPct(claudeSavings) : "—"}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        `
      }

      ${
        u.byModel.length > 0
          ? html`
          <div class="section-title">Most used models</div>
          <table>
            <thead><tr><th>model</th><th class="numeric">turns</th></tr></thead>
            <tbody>
              ${u.byModel.slice(0, 5).map(
                (m) => html`
                <tr><td><code>${m.model}</code></td><td class="numeric">${fmtNum(m.turns)}</td></tr>
              `,
              )}
            </tbody>
          </table>
        `
          : null
      }

      ${
        u.subagents
          ? html`
          <div class="section-title">Subagent activity</div>
          <div class="card">
            <div class="card-title">Total runs</div>
            <div class="card-value">${fmtNum(u.subagents.total)}</div>
            <div class="card-hint">${fmtUsd(u.subagents.costUsd)} · ${(u.subagents.totalDurationMs / 1000).toFixed(1)}s total</div>
          </div>
        `
          : null
      }
    </div>
  `;
}

function ToolsPanel() {
  const { data, error, loading } = usePoll("/tools", 4000);
  if (loading && !data) return html`<div class="boot">loading tools…</div>`;
  if (error?.status === 503) {
    return html`<div class="notice">${error.body?.error ?? "live tools view requires an attached session"}</div>`;
  }
  if (error) return html`<div class="notice err">tools failed: ${error.message}</div>`;
  const t = data;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Tools</h2>
        <span class="panel-subtitle">${t.total} registered ${t.planMode ? html`<span class="pill pill-warn">plan mode — writes gated</span>` : ""}</span>
      </div>
      ${
        t.tools.length === 0
          ? html`<div class="empty">No tools registered.</div>`
          : html`
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>flags</th>
                <th>description</th>
              </tr>
            </thead>
            <tbody>
              ${t.tools.map(
                (tool) => html`
                <tr>
                  <td><code>${tool.name}</code></td>
                  <td>
                    ${tool.readOnly ? html`<span class="pill pill-ok">read-only</span>` : html`<span class="pill pill-accent">write</span>`}
                    ${tool.flattened ? html` <span class="pill pill-dim">flat</span>` : ""}
                  </td>
                  <td>${tool.description ?? ""}</td>
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

function PermissionsPanel() {
  const { data, error, loading, refresh } = usePoll("/permissions", 5000);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const add = useCallback(async () => {
    const prefix = draft.trim();
    if (!prefix) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api("/permissions", { method: "POST", body: { prefix } });
      if (res.alreadyPresent) setFeedback({ kind: "info", text: `${prefix} already in list` });
      else setFeedback({ kind: "ok", text: `added: ${prefix}` });
      setDraft("");
      await refresh();
    } catch (err) {
      setFeedback({ kind: "err", text: err.message });
    } finally {
      setBusy(false);
    }
  }, [draft, refresh]);

  const remove = useCallback(
    async (prefix) => {
      if (!confirm(`Remove "${prefix}" from this project's allowlist?`)) return;
      setBusy(true);
      setFeedback(null);
      try {
        await api("/permissions", { method: "DELETE", body: { prefix } });
        setFeedback({ kind: "ok", text: `removed: ${prefix}` });
        await refresh();
      } catch (err) {
        setFeedback({ kind: "err", text: err.message });
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
      const res = await api("/permissions/clear", { method: "POST", body: { confirm: true } });
      setFeedback({
        kind: "ok",
        text: `cleared ${res.dropped} entr${res.dropped === 1 ? "y" : "ies"}`,
      });
      await refresh();
    } catch (err) {
      setFeedback({ kind: "err", text: err.message });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (loading && !data) return html`<div class="boot">loading permissions…</div>`;
  if (error) return html`<div class="notice err">permissions failed: ${error.message}</div>`;
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
              onInput=${(e) => setDraft(e.target.value)}
              onKeyDown=${(e) => {
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

function groupByVerb(list) {
  const groups = new Map();
  for (const entry of list) {
    const head = entry.split(" ")[0];
    if (!groups.has(head)) groups.set(head, []);
    const tail = entry.slice(head.length).trim();
    groups.get(head).push(tail || "(bare)");
  }
  return [...groups.entries()];
}

// ---------- Chat panel ----------

const ROLE_GLYPH = {
  user: "◇",
  assistant: "◆",
  tool: "▣",
  info: "·",
  warning: "▲",
  error: "✦",
};

function renderMessageBody(text) {
  if (!text) return null;
  // marked.parse escapes raw HTML in source by default — so any `<script>`
  // in model output gets rendered as literal text, not executed. We can
  // safely hand the result straight to dangerouslySetInnerHTML.
  const rendered = marked.parse(text);
  return html`<div class="md" dangerouslySetInnerHTML=${{ __html: rendered }}></div>`;
}

// Map common file extensions to highlight.js languages.
const LANG_BY_EXT = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  xml: "xml",
  html: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  sql: "sql",
  vue: "xml",
  svelte: "xml",
  tex: "latex",
  proto: "protobuf",
  dockerfile: "dockerfile",
};

function langFromPath(path) {
  if (!path) return null;
  const lower = path.toLowerCase();
  if (lower.endsWith("dockerfile")) return "dockerfile";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);
  return LANG_BY_EXT[ext] ?? null;
}

function renderHighlightedBlock(text, lang) {
  if (!text) return "";
  const safeLang = lang && hljs.getLanguage(lang) ? lang : null;
  try {
    const out = safeLang
      ? hljs.highlight(text, { language: safeLang, ignoreIllegals: true })
      : hljs.highlightAuto(text);
    return `<pre class="md"><code class="hljs ${safeLang ? `language-${safeLang}` : ""}">${out.value}</code></pre>`;
  } catch {
    return `<pre><code>${escapeHtml(text)}</code></pre>`;
  }
}

function parseToolArgs(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function ToolCard({ msg }) {
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
          ${path ? html`<code class="tool-card-path tool-card-path-link" onClick=${() => openFileInEditor(path)} title="open in editor">${path}</code>` : null}
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
          ${path ? html`<code class="tool-card-path tool-card-path-link" onClick=${() => openFileInEditor(path)} title="open in editor">${path}</code>` : null}
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
          ${path ? html`<code class="tool-card-path tool-card-path-link" onClick=${() => openFileInEditor(path)} title="open in editor">${path}</code>` : null}
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
          ${path ? html`<code class="tool-card-path tool-card-path-link" onClick=${() => openFileInEditor(path)} title="open in editor">${path}</code>` : null}
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

function ChatMessage({ msg, streaming }) {
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

function ModalCard({ accent, icon, title, subtitle, children }) {
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

function ShellModal({ modal, onResolve }) {
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

function ChoiceModal({ modal, onResolve }) {
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

function PlanModal({ modal, onResolve }) {
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

// Highlight a single line via hljs in the file's language; falls back to
// auto-detect, then escaped plain text. Always returns inline HTML safe
// to drop into a span.
function hlLine(text, lang) {
  if (text == null) return "";
  if (text === "") return "";
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}

function EditReviewModal({ modal, onResolve }) {
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

function WorkspaceModal({ modal, onResolve }) {
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

function CheckpointModal({ modal, onResolve }) {
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

function RevisionModal({ modal, onResolve }) {
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

function ChatPanel() {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(null); // { id, text, reasoning }
  // Tool currently dispatched but not yet returning. Set on `tool_start`,
  // cleared on `tool` / `error`. Drives the in-flight row so the user
  // sees what's running (path, command, char counts) instead of a
  // generic "waiting" — file writes especially feel hung otherwise.
  const [activeTool, setActiveTool] = useState(null); // { id, toolName, args }
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [statusLine, setStatusLine] = useState(null);
  // Mirror of the active TUI modal: { kind, ...payload } | null. Set
  // by `modal-up` SSE events, cleared by `modal-down`. Web uses POST
  // /api/modal/resolve to drive resolution; either surface clears the
  // other's modal via the resulting modal-down event.
  const [modal, setModal] = useState(null);
  // Current edit gate (review / auto / yolo). null when not in code
  // mode. Refreshed via /api/overview poll because the mode also
  // flips from TUI Shift+Tab and we want the segmented control to
  // stay in sync without a dedicated event.
  const [editMode, setEditModeLocal] = useState(null);
  // Persisted preset + reasoning_effort, surfaced here so the user
  // can flip them mid-chat without leaving the tab. /api/overview
  // includes both since 0.14.x; the same poll covers all three.
  const [preset, setPresetLocal] = useState(null);
  const [effort, setEffortLocal] = useState(null);
  // Live session stats — cache hit, costs, tokens, balance — from the
  // same /api/overview poll. Renders into a compact status bar below
  // the input area.
  const [stats, setStats] = useState(null);
  const [overviewModel, setOverviewModel] = useState(null);
  // Whether the project has a built semantic index. Null = unknown
  // (poll hasn't landed) or non-attached. False = no index → show the
  // dismissible banner. True = index built → hide it.
  const [semanticIndex, setSemanticIndex] = useState(null);
  const [semanticBannerDismissed, setSemanticBannerDismissed] = useState(() => {
    try {
      return localStorage.getItem("rx.semanticBannerDismissed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("rx.semanticBannerDismissed", semanticBannerDismissed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [semanticBannerDismissed]);
  // Wall-clock timestamp the current turn started at — populated when
  // busy flips true, cleared when it flips false. Drives the "elapsed
  // Ns" readout in the in-flight indicator. Refreshed once per second
  // by `nowTick` so the seconds counter ticks visibly even between
  // SSE deltas.
  const [turnStartedAt, setTurnStartedAt] = useState(null);
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [busy]);
  useEffect(() => {
    if (busy) {
      if (!turnStartedAt) setTurnStartedAt(Date.now());
    } else {
      setTurnStartedAt(null);
    }
  }, [busy, turnStartedAt]);
  // Sticks to bottom only while the user is already near the bottom.
  // Once they scroll up to read older content the streaming deltas no
  // longer yank the view back. Re-armed when they scroll back to the
  // bottom on their own. 80px threshold absorbs sub-pixel rounding.
  const shouldAutoScroll = useRef(true);
  // Ref to the scrollable feed container so we don't have to rely on
  // a global querySelector (which would race the conditional render
  // — `.chat-feed` only mounts when at least one message is present).
  // The feed is now always rendered, so `feedRef.current` is set on
  // first paint and the scroll listener attaches once.
  const feedRef = useRef(null);

  // Initial snapshot — messages + busy + any modal already up.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api("/messages");
        if (cancelled) return;
        setMessages(data.messages ?? []);
        setBusy(Boolean(data.busy));
      } catch (err) {
        if (!cancelled) setBootError(err.message);
      }
      try {
        const m = await api("/modal");
        if (!cancelled && m.modal) setModal(m.modal);
      } catch {
        /* skip — modal endpoint optional in standalone */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live event stream.
  useEffect(() => {
    const es = new EventSource(`/api/events?token=${TOKEN}`);
    es.onmessage = (ev) => {
      let dash;
      try {
        dash = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (dash.kind === "ping") return;
      if (dash.kind === "busy-change") {
        setBusy(dash.busy);
        return;
      }
      if (dash.kind === "user") {
        setMessages((prev) => [...prev, { id: dash.id, role: "user", text: dash.text }]);
        return;
      }
      if (dash.kind === "assistant_delta") {
        setStreaming((cur) => {
          const text = (cur?.text ?? "") + (dash.contentDelta ?? "");
          const reasoning = (cur?.reasoning ?? "") + (dash.reasoningDelta ?? "");
          return { id: dash.id, text, reasoning };
        });
        return;
      }
      if (dash.kind === "assistant_final") {
        setStreaming(null);
        setMessages((prev) => [
          ...prev,
          {
            id: dash.id,
            role: "assistant",
            text: dash.text,
            reasoning: dash.reasoning,
          },
        ]);
        return;
      }
      if (dash.kind === "tool_start") {
        // Surface the dispatched tool + its args in the in-flight row.
        // No info-row placeholder: the InFlightRow now renders the
        // detail (path / command / char count) and the result card
        // appears when the `tool` event lands. Two rows for one tool
        // call was redundant noise.
        setActiveTool({ id: dash.id, toolName: dash.toolName, args: dash.args });
        return;
      }
      if (dash.kind === "tool") {
        setActiveTool((cur) => (cur && cur.id === dash.id ? null : cur));
        setMessages((prev) => [
          ...prev,
          {
            id: dash.id,
            role: "tool",
            text: dash.content,
            toolName: dash.toolName,
            toolArgs: dash.args,
          },
        ]);
        return;
      }
      if (dash.kind === "warning" || dash.kind === "error" || dash.kind === "info") {
        if (dash.kind === "error") {
          setActiveTool(null);
        }
        setMessages((prev) => [...prev, { id: dash.id, role: dash.kind, text: dash.text }]);
        return;
      }
      if (dash.kind === "status") {
        setStatusLine(dash.text);
        // Clear the status line shortly so old hints don't pile up.
        setTimeout(() => setStatusLine((cur) => (cur === dash.text ? null : cur)), 5000);
        return;
      }
      if (dash.kind === "modal-up") {
        setModal(dash.modal);
        return;
      }
      if (dash.kind === "modal-down") {
        setModal((cur) => (cur && cur.kind === dash.modalKind ? null : cur));
        return;
      }
    };
    es.onerror = () => {
      // Auto-reconnect by default; surface a brief banner on persistent
      // failure but don't tear down — EventSource retries in the background.
      setError("event stream interrupted — reconnecting…");
      setTimeout(() => setError(null), 3000);
    };
    return () => es.close();
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    try {
      const res = await api("/submit", { method: "POST", body: { prompt: text } });
      if (!res.accepted) {
        setError(res.reason ?? "rejected");
        return;
      }
      setInput("");
    } catch (err) {
      setError(err.message);
    }
  }, [input, busy]);

  const abort = useCallback(async () => {
    try {
      await api("/abort", { method: "POST" });
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // /new wipes context + scrollback (server-side); /clear keeps the
  // log but blanks the visible scroll. Both route through /api/submit
  // because handleSubmit on the TUI side already parses slashes — keeps
  // one source of truth, no special endpoint needed. Local messages
  // state is reset optimistically; an /api/messages refetch reconciles.
  const newConversation = useCallback(async () => {
    if (busy) {
      if (!confirm("A turn is in flight. Abort and start a new conversation?")) return;
    } else if (messages.length > 0 && !confirm("Clear current conversation and start fresh?")) {
      return;
    }
    try {
      await api("/submit", { method: "POST", body: { prompt: "/new" } });
      setMessages([]);
      setStreaming(null);
      setActiveTool(null);
      showToast("new conversation", "info");
      // Refetch to reconcile in case the slash queued an info row.
      setTimeout(async () => {
        try {
          const r = await api("/messages");
          setMessages(r.messages ?? []);
        } catch {
          /* swallow */
        }
      }, 200);
    } catch (err) {
      setError(`/new failed: ${err.message}`);
    }
  }, [busy, messages.length]);

  const clearScrollback = useCallback(async () => {
    try {
      await api("/submit", { method: "POST", body: { prompt: "/clear" } });
      setMessages([]);
      setStreaming(null);
      setActiveTool(null);
      showToast("scrollback cleared", "info");
      setTimeout(async () => {
        try {
          const r = await api("/messages");
          setMessages(r.messages ?? []);
        } catch {
          /* swallow */
        }
      }, 200);
    } catch (err) {
      setError(`/clear failed: ${err.message}`);
    }
  }, []);

  const onKeyDown = useCallback(
    (e) => {
      // Enter sends, Shift+Enter inserts newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  if (bootError) {
    return html`<div class="notice err">chat unavailable: ${bootError}</div>`;
  }

  // Track whether the user is parked at the bottom. Update on every
  // scroll event so a single wheel-up flips the auto-scroll guard
  // immediately. The threshold is generous enough that overshoot
  // (smooth-scroll rebound, sub-pixel rounding) doesn't accidentally
  // re-arm tracking when the user is barely above bottom.
  //
  // We also distinguish *user* scroll events from auto-scroll's own
  // programmatic `scrollTop = scrollHeight` writes. Without that gate
  // the auto-scroll effect would briefly snap to bottom, fire its
  // own scroll event, re-set shouldAutoScroll = true, then wonder
  // why the user complained that they couldn't scroll up — because
  // every wheel-up was racing against the next delta's auto-snap.
  // We mark the ref as `auto-scrolling` for one tick around the
  // programmatic write; the listener ignores events it sees during
  // that window.
  const autoScrollInFlight = useRef(false);
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const onScroll = () => {
      if (autoScrollInFlight.current) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      shouldAutoScroll.current = distFromBottom < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll only when the user hasn't scrolled away. Streaming
  // deltas no longer yank the view back; manual wheel/drag wins.
  useEffect(() => {
    if (!shouldAutoScroll.current) return;
    const el = feedRef.current;
    if (!el) return;
    autoScrollInFlight.current = true;
    el.scrollTop = el.scrollHeight;
    // Clear the gate after the browser has had a chance to fire the
    // resulting scroll event (microtask-ish — rAF is overkill, a 0ms
    // setTimeout is enough to land after the synchronous handler).
    setTimeout(() => {
      autoScrollInFlight.current = false;
    }, 0);
  }, [messages, streaming]);

  const allMessages = streaming
    ? [
        ...messages,
        {
          id: streaming.id,
          role: "assistant",
          text: streaming.text,
          reasoning: streaming.reasoning,
        },
      ]
    : messages;

  // Resolve the active modal via POST /api/modal/resolve. The server
  // hands the choice straight to App.tsx's resolveXxx callback, which
  // calls the same handler the TUI button would. The local `modal`
  // state clears the moment the SSE channel echoes `modal-down`.
  const resolveModal = useCallback(async (kind, choice, text) => {
    try {
      await api("/modal/resolve", {
        method: "POST",
        body: text !== undefined ? { kind, choice, text } : { kind, choice },
      });
    } catch (err) {
      setError(`modal resolve failed: ${err.message}`);
    }
  }, []);

  // Poll /api/overview for current edit mode. Polling (not SSE) is
  // fine — the gate flips from /mode, Shift+Tab, AND the web button;
  // a 4s poll is good enough to keep the segmented control visually
  // honest without piping yet another event kind.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const o = await api("/overview");
        if (cancelled) return;
        setEditModeLocal(o.editMode ?? null);
        setPresetLocal(o.preset ?? null);
        setEffortLocal(o.reasoningEffort ?? null);
        setStats(o.stats ?? null);
        setOverviewModel(o.model ?? null);
        setSemanticIndex(o.semanticIndexExists);
      } catch {
        /* swallow */
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const setEditMode = useCallback(async (next) => {
    setEditModeLocal(next); // optimistic
    try {
      await api("/edit-mode", { method: "POST", body: { mode: next } });
    } catch (err) {
      setError(`mode switch failed: ${err.message}`);
      try {
        const o = await api("/overview");
        setEditModeLocal(o.editMode ?? null);
      } catch {
        /* swallow */
      }
    }
  }, []);

  // Generic settings flipper for preset + effort. Both go through
  // /api/settings (which writes to ~/.reasonix/config.json). preset
  // applies next session, effort applies next turn — the buttons'
  // tooltips remind the user.
  const setSetting = useCallback(async (key, value) => {
    if (key === "preset") setPresetLocal(value);
    if (key === "reasoningEffort") setEffortLocal(value);
    try {
      await api("/settings", { method: "POST", body: { [key]: value } });
    } catch (err) {
      setError(`${key} switch failed: ${err.message}`);
      try {
        const o = await api("/overview");
        setPresetLocal(o.preset ?? null);
        setEffortLocal(o.reasoningEffort ?? null);
      } catch {
        /* swallow */
      }
    }
  }, []);

  return html`
    <div class="chat-shell">
      <div class="panel-header" style="margin-bottom: 12px;">
        <h2 class="panel-title">Chat</h2>
        <span class="panel-subtitle">
          mirrors the live ${MODE === "attached" ? "TUI" : "session"} — type here or in the terminal, both surfaces stay in sync
        </span>
        <div class="header-pickers" style="margin-left: auto;">
          ${
            effort
              ? html`
              <div class="mode-picker" title="reasoning_effort — applies next turn">
                ${["high", "max"].map(
                  (e) => html`
                  <button
                    key=${e}
                    class="mode-btn ${effort === e ? "active accent" : ""}"
                    onClick=${() => setSetting("reasoningEffort", e)}
                    title=${e === "max" ? "max (default — best quality)" : "high (cheaper / faster)"}
                  >${e}</button>
                `,
                )}
              </div>
            `
              : null
          }
          ${
            preset
              ? html`
              <div class="mode-picker" title="preset — model commitment">
                ${(() => {
                  // Anything that isn't one of the three new presets
                  // (including legacy fast/smart/max from old configs)
                  // highlights as `auto` — the safe default. User can
                  // re-pick explicitly if they want flash or pro.
                  const KNOWN = ["auto", "flash", "pro"];
                  const canonical = KNOWN.includes(preset) ? preset : "auto";
                  return ["auto", "flash", "pro"].map(
                    (p) => html`
                      <button
                        key=${p}
                        class="mode-btn ${canonical === p ? "active accent" : ""}"
                        onClick=${() => setSetting("preset", p)}
                        title=${
                          p === "auto"
                            ? "auto — flash baseline; auto-escalates to pro on hard turns (NEEDS_PRO / failure threshold)"
                            : p === "flash"
                              ? "flash — always flash; no auto-escalate. /pro still works for one-shot manual"
                              : "pro — always pro; ~3× flash cost (5/31 discount). Locks in on hard architecture work."
                        }
                      >${p}</button>
                    `,
                  );
                })()}
              </div>
            `
              : null
          }
          ${
            editMode
              ? html`
              <div class="mode-picker" title="edit gate — Shift+Tab cycles in TUI">
                ${["review", "auto", "yolo"].map(
                  (m) => html`
                  <button
                    key=${m}
                    class="mode-btn ${editMode === m ? "active" : ""} ${m === "yolo" ? "yolo" : ""}"
                    onClick=${() => setEditMode(m)}
                    title=${
                      m === "review"
                        ? "review — both edits and non-allowlisted shell ask first"
                        : m === "auto"
                          ? "auto — edits auto-apply, shell still asks"
                          : "yolo — edits AND shell auto-run, allowlist bypassed"
                    }
                  >${m}</button>
                `,
                )}
              </div>
            `
              : null
          }
        </div>
      </div>

      ${
        !busy && statusLine
          ? html`<div class="chat-status"><span class="muted">${statusLine}</span></div>`
          : null
      }
      ${
        semanticIndex === false && !semanticBannerDismissed
          ? html`<div class="chat-banner">
              <span class="chat-banner-icon">≈</span>
              <span class="chat-banner-text">
                <strong>Semantic search isn't enabled for this project.</strong>
                <span class="muted">
                  Build the index once and the model can find code by meaning ("where do we handle auth failures?") instead of grep on exact strings.
                </span>
              </span>
              <button
                class="primary"
                onClick=${() => appBus.dispatchEvent(new CustomEvent("navigate-tab", { detail: { tabId: "semantic" } }))}
              >Build it →</button>
              <button
                class="chat-banner-close"
                onClick=${() => setSemanticBannerDismissed(true)}
                title="dismiss (don't show again)"
              >×</button>
            </div>`
          : null
      }
      ${error ? html`<div class="notice err">${error}</div>` : null}

      ${
        modal
          ? modal.kind === "shell"
            ? html`<${ShellModal} modal=${modal} onResolve=${resolveModal} />`
            : modal.kind === "choice"
              ? html`<${ChoiceModal} modal=${modal} onResolve=${resolveModal} />`
              : modal.kind === "plan"
                ? html`<${PlanModal} modal=${modal} onResolve=${resolveModal} />`
                : modal.kind === "edit-review"
                  ? html`<${EditReviewModal} modal=${modal} onResolve=${resolveModal} />`
                  : modal.kind === "workspace"
                    ? html`<${WorkspaceModal} modal=${modal} onResolve=${resolveModal} />`
                    : modal.kind === "checkpoint"
                      ? html`<${CheckpointModal} modal=${modal} onResolve=${resolveModal} />`
                      : modal.kind === "revision"
                        ? html`<${RevisionModal} modal=${modal} onResolve=${resolveModal} />`
                        : null
          : null
      }

      <div class="chat-feed" ref=${feedRef}>
        ${
          allMessages.length === 0
            ? html`<div class="chat-empty">
                No conversation yet. Send a prompt below to begin.
              </div>`
            : allMessages.map(
                (m) => html`
                  <${ChatMessage}
                    key=${m.id}
                    msg=${m}
                    streaming=${streaming && streaming.id === m.id}
                  />
                `,
              )
        }
      </div>

      <div class="chat-input-area">
        <textarea
          placeholder=${busy ? "wait for the current turn to finish…" : "Type a prompt — Enter sends, Shift+Enter for a newline"}
          value=${input}
          onInput=${(e) => setInput(e.target.value)}
          onKeyDown=${onKeyDown}
          disabled=${busy}
          rows="2"
        ></textarea>
        <div style="display: flex; flex-direction: column; gap: 6px; align-self: stretch; justify-content: flex-end;">
          <button
            class="primary"
            onClick=${send}
            disabled=${busy || !input.trim()}
          >Send</button>
          <div style="display: flex; gap: 6px;">
            <button onClick=${newConversation} title="/new — wipe conversation context (loop log + scrollback)">New</button>
            <button onClick=${clearScrollback} title="/clear — wipe just visible scrollback (context kept)">Clear</button>
          </div>
        </div>
      </div>

      ${
        busy
          ? html`<${InFlightRow}
              streaming=${streaming}
              activeTool=${activeTool}
              startedAt=${turnStartedAt}
              statusLine=${statusLine}
              onAbort=${abort}
              tick=${nowTick}
            />`
          : null
      }
      <${ChatStatusBar} stats=${stats} model=${overviewModel} />
    </div>
  `;
}

// Summarize the dispatched tool in one line — what the user wants to
// know is "is this hung or really doing X". Per-tool projection so a
// write_file says "→ /path/foo (12,345 ch)" instead of just "tool is
// running". Returns null for tools we don't have a custom shape for;
// the row falls back to the bare tool name.
function summarizeActiveTool(activeTool) {
  if (!activeTool) return null;
  const name = activeTool.toolName ?? "tool";
  const args = parseToolArgs(activeTool.args);
  const path = args?.path ?? args?.file_path ?? args?.filename;
  if (name === "write_file" && path) {
    const len = typeof args?.content === "string" ? args.content.length : null;
    return `${name} → ${path}${len != null ? ` (${len.toLocaleString()} ch)` : ""}`;
  }
  if ((name === "edit_file" || name.endsWith("_edit_file")) && path) {
    return `${name} → ${path}`;
  }
  if ((name === "run_command" || name === "run_background") && typeof args?.command === "string") {
    const c = args.command;
    return `${name} → $ ${c.length > 80 ? `${c.slice(0, 80)}…` : c}`;
  }
  if ((name === "read_file" || name === "list_files" || name === "search_files") && path) {
    return `${name} → ${path}`;
  }
  if (path) return `${name} → ${path}`;
  return name;
}

// Live "what's the model doing right now" strip. Lives just above the
// ChatStatusBar so the user's eyes don't have to leave the input area
// to see whether the turn is alive — ticks every 500ms via the parent's
// nowTick so the seconds counter shows visible motion even when the
// SSE stream is silent (model thinking, waiting on a tool, etc).
function InFlightRow({ streaming, activeTool, startedAt, statusLine, onAbort, tick: _tick }) {
  const elapsedMs = startedAt ? Date.now() - startedAt : 0;
  const elapsed = (elapsedMs / 1000).toFixed(1);
  const reasoningLen = streaming?.reasoning?.length ?? 0;
  const textLen = streaming?.text?.length ?? 0;
  // Tool-running phase wins over text/reasoning since the model is
  // blocked on the tool — even if assistant_delta has fired we want
  // to show the active dispatch.
  const toolSummary = summarizeActiveTool(activeTool);
  const phase = toolSummary
    ? "running"
    : reasoningLen > 0 && textLen === 0
      ? "thinking"
      : textLen > 0
        ? "streaming"
        : "waiting";
  return html`
    <div class="chat-inflight">
      <span class="spinner"></span>
      <span class="chat-inflight-phase">${phase}</span>
      <span class="chat-inflight-sep">·</span>
      <span class="muted">${elapsed}s</span>
      ${
        toolSummary
          ? html`
            <span class="chat-inflight-sep">·</span>
            <span class="chat-inflight-tool" title=${toolSummary}>${toolSummary}</span>
          `
          : null
      }
      ${
        !toolSummary && (textLen > 0 || reasoningLen > 0)
          ? html`
            <span class="chat-inflight-sep">·</span>
            <span class="muted">
              ${reasoningLen > 0 ? html`reasoning ${reasoningLen.toLocaleString()} ch` : null}
              ${reasoningLen > 0 && textLen > 0 ? html`<span> · </span>` : null}
              ${textLen > 0 ? html`out ${textLen.toLocaleString()} ch` : null}
            </span>
          `
          : null
      }
      ${
        statusLine
          ? html`
            <span class="chat-inflight-sep">·</span>
            <span class="muted">${statusLine}</span>
          `
          : null
      }
      <button class="chat-inflight-abort" onClick=${onAbort}>Abort (Esc)</button>
    </div>
  `;
}

// ---------- Chat status bar ----------
//
// Mirrors the TUI's StatsPanel — turn / session cost, cache hit %,
// ctx token gauge, balance. Sits beneath the input area as a compact
// monospace strip. Renders as a placeholder ("· · ·") while stats
// haven't arrived yet so the layout doesn't shift on first paint.

function ChatStatusBar({ stats, model }) {
  if (!stats) {
    return html`
      <div class="chat-statusbar">
        <span class="muted">· · ·  waiting for live stats</span>
      </div>
    `;
  }
  const ctxPct =
    stats.contextCapTokens > 0 ? (stats.lastPromptTokens / stats.contextCapTokens) * 100 : 0;
  const balance = stats.balance && stats.balance.length > 0 ? stats.balance[0] : null;
  return html`
    <div class="chat-statusbar">
      <span class="status-item">
        <span class="status-label">model</span>
        <code>${model ?? "—"}</code>
      </span>
      <span class="status-item">
        <span class="status-label">ctx</span>
        <span class="status-bar-mini">
          <span class="status-bar-mini-fill" style=${`width: ${Math.min(100, ctxPct).toFixed(1)}%;`}></span>
        </span>
        <span class="muted">${stats.lastPromptTokens.toLocaleString()} / ${(stats.contextCapTokens / 1000).toFixed(0)}K</span>
      </span>
      <span class="status-item">
        <span class="status-label">cache</span>
        <span class=${stats.cacheHitRatio >= 0.9 ? "status-ok" : stats.cacheHitRatio >= 0.6 ? "status-warn" : "status-err"}>
          ${(stats.cacheHitRatio * 100).toFixed(1)}%
        </span>
      </span>
      <span class="status-item">
        <span class="status-label">turn</span>
        <code>${fmtUsd(stats.lastTurnCostUsd)}</code>
      </span>
      <span class="status-item">
        <span class="status-label">session</span>
        <code>${fmtUsd(stats.totalCostUsd)}</code>
        <span class="muted" style="font-size: 10px;">
          (${stats.turns} turn${stats.turns === 1 ? "" : "s"})
        </span>
      </span>
      ${
        balance
          ? html`
          <span class="status-item">
            <span class="status-label">balance</span>
            <code>${balance.total_balance} ${balance.currency}</code>
          </span>
        `
          : null
      }
    </div>
  `;
}

// ---------- System Health ----------

function SystemPanel() {
  const { data, error, loading } = usePoll("/health", 5000);
  if (loading && !data) return html`<div class="boot">loading health…</div>`;
  if (error) return html`<div class="notice err">health failed: ${error.message}</div>`;
  const h = data;
  const upToDate = h.latestVersion ? h.latestVersion === h.version : null;
  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">System Health</h2>
        <span class="panel-subtitle">disk · version · jobs</span>
      </div>
      <div class="metric-grid">
        ${MetricCard(
          "Reasonix",
          h.version,
          h.latestVersion === null
            ? "version check pending"
            : upToDate
              ? "up to date"
              : `latest: ${h.latestVersion}`,
          upToDate === false ? "warn" : null,
        )}
        ${MetricCard("Sessions", `${fmtNum(h.sessions.count)} files`, fmtBytes(h.sessions.totalBytes))}
        ${MetricCard("Memory", `${fmtNum(h.memory.fileCount)} files`, fmtBytes(h.memory.totalBytes))}
        ${MetricCard(
          "Semantic index",
          h.semantic.exists ? `${fmtNum(h.semantic.fileCount)} files` : "not built",
          h.semantic.exists ? fmtBytes(h.semantic.totalBytes) : "run `reasonix index` to build",
        )}
        ${MetricCard("Usage log", fmtBytes(h.usageLog.bytes), null)}
        ${MetricCard("Background jobs", h.jobs === null ? "—" : fmtNum(h.jobs), h.jobs === null ? "no live session" : null)}
      </div>
      <div class="section-title">Paths</div>
      <div class="card mono" style="font-size: 12px; line-height: 1.8;">
        <div><span class="pill pill-dim">home</span> ${h.reasonixHome}</div>
        <div><span class="pill pill-dim">sessions</span> ${h.sessions.path}</div>
        <div><span class="pill pill-dim">memory</span> ${h.memory.path}</div>
        <div><span class="pill pill-dim">semantic</span> ${h.semantic.path}</div>
        <div><span class="pill pill-dim">usage</span> ${h.usageLog.path}</div>
      </div>
    </div>
  `;
}

// ---------- Sessions browser ----------

function SessionsPanel() {
  const { data, error, loading } = usePoll("/sessions", 5000);
  const [open, setOpen] = useState(null); // { name, messages } or null
  const [openLoading, setOpenLoading] = useState(false);

  const view = useCallback(async (name) => {
    setOpen({ name, messages: null });
    setOpenLoading(true);
    try {
      const detail = await api(`/sessions/${encodeURIComponent(name)}`);
      setOpen({ name, messages: detail.messages });
    } catch (err) {
      setOpen({ name, messages: null, error: err.message });
    } finally {
      setOpenLoading(false);
    }
  }, []);

  if (loading && !data) return html`<div class="boot">loading sessions…</div>`;
  if (error) return html`<div class="notice err">sessions failed: ${error.message}</div>`;
  const sessions = data.sessions ?? [];

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
                    (m, i) => html`
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

// ---------- Plans archive ----------

function PlansPanel() {
  const { data, error, loading } = usePoll("/plans", 8000);
  const [open, setOpen] = useState(null);
  if (loading && !data) return html`<div class="boot">loading plans…</div>`;
  if (error) return html`<div class="notice err">plans failed: ${error.message}</div>`;
  const plans = data.plans ?? [];

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

// ---------- Usage time-series chart (uPlot) ----------

let uPlotPromise = null;
function loadUPlot() {
  if (!uPlotPromise) {
    uPlotPromise = import("https://esm.sh/uplot@1.6.31").then((m) => m.default ?? m);
  }
  return uPlotPromise;
}

function UsageChart({ days }) {
  const containerRef = useRef(null);
  const plotRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadUPlot().then((uPlot) => {
      if (cancelled || !containerRef.current) return;
      // Destroy previous instance on data refresh.
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
      // Don't render an empty chart — let the parent show a fallback.
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
          {
            stroke: "#94a3b8",
            grid: { stroke: "rgba(148, 163, 184, 0.08)" },
          },
          {
            scale: "y",
            label: "USD",
            stroke: "#94a3b8",
            grid: { stroke: "rgba(148, 163, 184, 0.08)" },
            values: (_u, v) => v.map((n) => `$${n.toFixed(4)}`),
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
          {
            label: "cost",
            stroke: "#67e8f9",
            width: 2,
            fill: "rgba(103, 232, 249, 0.10)",
          },
          {
            label: "cache saved",
            stroke: "#5eead4",
            width: 2,
            dash: [4, 4],
          },
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

    // Resize observer keeps the chart at full panel width.
    const ro = new ResizeObserver(() => {
      if (plotRef.current && containerRef.current) {
        plotRef.current.setSize({
          width: containerRef.current.clientWidth,
          height: 280,
        });
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

// ---------- existing UsagePanel rewrite — chart + table ----------

function UsageWithChart() {
  const { data: summary, error, loading } = usePoll("/usage", 5000);
  const [series, setSeries] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api("/usage/series");
        if (!cancelled) setSeries(s.days ?? []);
      } catch {
        /* keep null; chart hides */
      }
    })();
    const t = setInterval(async () => {
      try {
        const s = await api("/usage/series");
        if (!cancelled) setSeries(s.days ?? []);
      } catch {
        /* swallow */
      }
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (loading && !summary) return html`<div class="boot">loading usage…</div>`;
  if (error) return html`<div class="notice err">usage failed: ${error.message}</div>`;
  const u = summary;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Usage</h2>
        <span class="panel-subtitle">${u.recordCount.toLocaleString()} records · ${u.logSize}</span>
      </div>

      ${
        series && series.length > 0
          ? html`
          <div class="card" style="padding: 18px;">
            <div class="card-title" style="margin-bottom: 12px;">Daily usage (cost · cache saved · turns)</div>
            <${UsageChart} days=${series} />
          </div>
        `
          : null
      }

      ${
        u.recordCount === 0
          ? html`<div class="empty" style="margin-top: 16px;">No usage data yet — run a turn in <code>reasonix chat</code> / <code>code</code> / <code>run</code> and refresh.</div>`
          : html`
          <div class="section-title">Rolling windows</div>
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="numeric">turns</th>
                <th class="numeric">cache hit</th>
                <th class="numeric">cost (USD)</th>
                <th class="numeric">cache saved</th>
                <th class="numeric">vs Claude</th>
                <th class="numeric">saved</th>
              </tr>
            </thead>
            <tbody>
              ${u.buckets.map((b) => {
                const hitRatio =
                  b.cacheHitTokens + b.cacheMissTokens > 0
                    ? b.cacheHitTokens / (b.cacheHitTokens + b.cacheMissTokens)
                    : 0;
                const claudeSavings = b.claudeEquivUsd > 0 ? 1 - b.costUsd / b.claudeEquivUsd : 0;
                return html`
                  <tr>
                    <td>${b.label}</td>
                    <td class="numeric">${fmtNum(b.turns)}</td>
                    <td class="numeric">${b.turns > 0 ? fmtPct(hitRatio) : "—"}</td>
                    <td class="numeric">${b.turns > 0 ? fmtUsd(b.costUsd) : "—"}</td>
                    <td class="numeric">${b.turns > 0 && b.cacheSavingsUsd > 0 ? fmtUsd(b.cacheSavingsUsd) : "—"}</td>
                    <td class="numeric">${b.turns > 0 ? fmtUsd(b.claudeEquivUsd) : "—"}</td>
                    <td class="numeric">${b.turns > 0 && claudeSavings > 0 ? fmtPct(claudeSavings) : "—"}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        `
      }

      ${
        u.byModel.length > 0
          ? html`
          <div class="section-title">Most used models</div>
          <table>
            <thead><tr><th>model</th><th class="numeric">turns</th></tr></thead>
            <tbody>
              ${u.byModel.slice(0, 5).map(
                (m) => html`
                <tr><td><code>${m.model}</code></td><td class="numeric">${fmtNum(m.turns)}</td></tr>
              `,
              )}
            </tbody>
          </table>
        `
          : null
      }
    </div>
  `;
}

// ---------- Settings ----------

function SettingsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState({});

  const load = useCallback(async () => {
    try {
      const r = await api("/settings");
      setData(r);
      setDraft({});
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (fields) => {
      setSaving(true);
      setError(null);
      try {
        await api("/settings", { method: "POST", body: fields });
        await load();
        setSaved(`saved: ${Object.keys(fields).join(", ")}`);
        setTimeout(() => setSaved(null), 3000);
      } catch (err) {
        setError(err.message);
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  if (!data && !error) return html`<div class="boot">loading settings…</div>`;
  if (error && !data) return html`<div class="notice err">${error}</div>`;
  const v = data;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Settings</h2>
        <span class="panel-subtitle">~/.reasonix/config.json · most fields apply next session</span>
      </div>
      ${saved ? html`<div class="notice">${saved}</div>` : null}
      ${error ? html`<div class="notice err">${error}</div>` : null}

      <div class="section-title">DeepSeek API</div>
      <div class="card">
        <div class="row">
          <span class="card-title" style="margin: 0;">API key</span>
          <code style="margin-left: auto;">${v.apiKey ?? "(not set)"}</code>
        </div>
        <div class="row" style="margin-top: 8px;">
          <input
            type="password"
            placeholder="paste a fresh sk-… token to replace"
            value=${draft.apiKey ?? ""}
            onInput=${(e) => setDraft({ ...draft, apiKey: e.target.value })}
          />
          <button
            class="primary"
            disabled=${saving || !(draft.apiKey ?? "").trim()}
            onClick=${() => save({ apiKey: draft.apiKey })}
          >Save key</button>
        </div>
        <div class="row" style="margin-top: 12px;">
          <span class="card-title" style="margin: 0;">Base URL</span>
          <input
            type="text"
            value=${draft.baseUrl ?? v.baseUrl ?? ""}
            placeholder="https://api.deepseek.com (default)"
            onInput=${(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          />
          <button
            disabled=${saving || (draft.baseUrl ?? v.baseUrl ?? "") === (v.baseUrl ?? "")}
            onClick=${() => save({ baseUrl: draft.baseUrl })}
          >Save</button>
        </div>
      </div>

      <div class="section-title">Defaults</div>
      <div class="card">
        <div class="row">
          <span class="card-title" style="margin: 0; flex: 0 0 110px;">Preset</span>
          <select
            value=${
              // Unknown values (legacy fast/smart/max, or anything
              // hand-edited into config.json) display as `auto`.
              ["auto", "flash", "pro"].includes(v.preset) ? v.preset : "auto"
            }
            onChange=${(e) => save({ preset: e.target.value })}
            disabled=${saving}
          >
            <option value="auto">auto — flash → pro on hard turns (default)</option>
            <option value="flash">flash — always flash, no auto-escalate</option>
            <option value="pro">pro — always pro</option>
          </select>
          <span class="muted" style="margin-left: auto; font-size: 12px;">applies next turn</span>
        </div>
        <div class="row" style="margin-top: 12px;">
          <span class="card-title" style="margin: 0; flex: 0 0 110px;">Effort</span>
          <select
            value=${v.reasoningEffort}
            onChange=${(e) => save({ reasoningEffort: e.target.value })}
            disabled=${saving}
          >
            <option value="max">max (default — best)</option>
            <option value="high">high (cheaper / faster)</option>
          </select>
          <span class="muted" style="margin-left: auto; font-size: 12px;">applies next turn</span>
        </div>
        <div class="row" style="margin-top: 12px;">
          <span class="card-title" style="margin: 0; flex: 0 0 110px;">Web search</span>
          <button
            class=${v.search ? "primary" : ""}
            onClick=${() => save({ search: !v.search })}
            disabled=${saving}
          >${v.search ? "ON" : "off"}</button>
          <span class="muted" style="margin-left: auto; font-size: 12px;">web_fetch + web_search tools</span>
        </div>
      </div>

      <div class="section-title">Runtime</div>
      <div class="card">
        <div class="row">
          <span class="card-title" style="margin: 0; flex: 0 0 110px;">Active model</span>
          <code>${v.model ?? "—"}</code>
        </div>
        <div class="row" style="margin-top: 8px;">
          <span class="card-title" style="margin: 0; flex: 0 0 110px;">Edit mode</span>
          <code>${v.editMode}</code>
          <span class="muted" style="margin-left: auto; font-size: 12px;">switch from the Chat tab header</span>
        </div>
      </div>
    </div>
  `;
}

// ---------- Hooks ----------

function HooksPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState({}); // { project: jsonText, global: jsonText }
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api("/hooks");
      setData(r);
      setDrafts({
        project: JSON.stringify(r.project.hooks ?? {}, null, 2),
        global: JSON.stringify(r.global.hooks ?? {}, null, 2),
      });
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const saveScope = useCallback(
    async (scope) => {
      setBusy(true);
      setError(null);
      let parsed;
      try {
        parsed = JSON.parse(drafts[scope]);
      } catch (err) {
        setError(`${scope} JSON: ${err.message}`);
        setBusy(false);
        return;
      }
      try {
        await api("/hooks/save", { method: "POST", body: { scope, hooks: parsed } });
        await api("/hooks/reload", { method: "POST", body: {} });
        setInfo(`saved + reloaded ${scope}`);
        setTimeout(() => setInfo(null), 3000);
        await load();
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [drafts, load],
  );

  if (!data && !error) return html`<div class="boot">loading hooks…</div>`;
  if (error && !data) return html`<div class="notice err">${error}</div>`;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Hooks</h2>
        <span class="panel-subtitle">${data.resolved.length} resolved · events: ${data.events.join(", ")}</span>
      </div>
      ${info ? html`<div class="notice">${info}</div>` : null}
      ${error ? html`<div class="notice err">${error}</div>` : null}
      ${["project", "global"].map((scope) => {
        const meta = data[scope];
        return html`
          <div class="section-title">${scope} — <code>${meta.path ?? "(no project)"}</code></div>
          ${
            scope === "project" && !meta.path
              ? html`<div class="empty">No active project — open <code>/dashboard</code> from <code>reasonix code</code> to edit project hooks.</div>`
              : html`
              <textarea
                style="width: 100%; height: 240px; font-family: var(--mono); font-size: 12.5px; background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px;"
                value=${drafts[scope] ?? ""}
                onInput=${(e) => setDrafts({ ...drafts, [scope]: e.target.value })}
                disabled=${busy}
              ></textarea>
              <div class="row" style="margin-top: 8px;">
                <button class="primary" disabled=${busy} onClick=${() => saveScope(scope)}>Save + Reload</button>
                <button disabled=${busy} onClick=${load}>Discard changes</button>
              </div>
            `
          }
        `;
      })}
    </div>
  `;
}

// ---------- Memory ----------

function MemoryPanel() {
  const [tree, setTree] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null); // { scope, name } | null
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api("/memory");
      setTree(r);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const openFile = useCallback(async (scope, name) => {
    setOpen({ scope, name });
    setBusy(true);
    try {
      const path =
        scope === "project" ? "/memory/project" : `/memory/${scope}/${encodeURIComponent(name)}`;
      const r = await api(path);
      setBody(r.body);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (!open) return;
    setBusy(true);
    setError(null);
    try {
      const path =
        open.scope === "project"
          ? "/memory/project"
          : `/memory/${open.scope}/${encodeURIComponent(open.name)}`;
      await api(path, { method: "POST", body: { body } });
      setInfo(`saved ${open.scope}${open.name ? `/${open.name}` : ""}`);
      setTimeout(() => setInfo(null), 3000);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [open, body, load]);

  if (!tree && !error) return html`<div class="boot">loading memory…</div>`;
  if (error && !tree) return html`<div class="notice err">${error}</div>`;

  if (open) {
    return html`
      <div>
        <div class="panel-header">
          <h2 class="panel-title">Memory · ${open.scope}${open.name ? `/${open.name}` : ""}</h2>
          <button onClick=${() => setOpen(null)} style="margin-left: auto;">← back</button>
        </div>
        ${info ? html`<div class="notice">${info}</div>` : null}
        ${error ? html`<div class="notice err">${error}</div>` : null}
        <textarea
          style="width: 100%; height: 480px; font-family: var(--mono); font-size: 13px; background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px;"
          value=${body}
          onInput=${(e) => setBody(e.target.value)}
          disabled=${busy}
        ></textarea>
        <div class="row" style="margin-top: 8px;">
          <button class="primary" disabled=${busy} onClick=${save}>Save</button>
          <span class="muted" style="font-size: 12px;">${body.length.toLocaleString()} chars · re-applied on next /new or session restart</span>
        </div>
      </div>
    `;
  }

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Memory</h2>
        <span class="panel-subtitle">REASONIX.md (committable) + private notes (~/.reasonix/memory)</span>
      </div>
      <div class="section-title">Project — REASONIX.md</div>
      ${
        tree.project.path
          ? html`
          <div class="card row" style="cursor: pointer;" onClick=${() => openFile("project")}>
            <span><code>${tree.project.path}</code></span>
            <span class="pill ${tree.project.exists ? "pill-ok" : "pill-dim"}" style="margin-left: auto;">
              ${tree.project.exists ? "exists" : "create"}
            </span>
          </div>
        `
          : html`<div class="empty">No active project.</div>`
      }

      <div class="section-title">Global — ~/.reasonix/memory/global</div>
      ${
        tree.global.files.length === 0
          ? html`<div class="empty">No global memory files yet.</div>`
          : html`
          <table>
            <thead><tr><th>name</th><th class="numeric">size</th><th class="numeric">touched</th></tr></thead>
            <tbody>
              ${tree.global.files.map(
                (f) => html`
                <tr key=${f.name} style="cursor: pointer;" onClick=${() => openFile("global", f.name)}>
                  <td><code>${f.name}</code></td>
                  <td class="numeric">${fmtBytes(f.size)}</td>
                  <td class="numeric muted">${fmtRelativeTime(f.mtime)}</td>
                </tr>
              `,
              )}
            </tbody>
          </table>
        `
      }

      ${
        tree.projectMem.path
          ? html`
          <div class="section-title">Project private — ~/.reasonix/memory/&lt;hash&gt;</div>
          ${
            tree.projectMem.files.length === 0
              ? html`<div class="empty">No project-private memory yet.</div>`
              : html`
              <table>
                <thead><tr><th>name</th><th class="numeric">size</th><th class="numeric">touched</th></tr></thead>
                <tbody>
                  ${tree.projectMem.files.map(
                    (f) => html`
                    <tr key=${f.name} style="cursor: pointer;" onClick=${() => openFile("project-mem", f.name)}>
                      <td><code>${f.name}</code></td>
                      <td class="numeric">${fmtBytes(f.size)}</td>
                      <td class="numeric muted">${fmtRelativeTime(f.mtime)}</td>
                    </tr>
                  `,
                  )}
                </tbody>
              </table>
            `
          }
        `
          : null
      }
    </div>
  `;
}

// ---------- Skills ----------

function SkillsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState("global");

  const load = useCallback(async () => {
    try {
      setData(await api("/skills"));
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const openSkill = useCallback(async (scope, name) => {
    setOpen({ scope, name });
    setBusy(true);
    try {
      const r = await api(`/skills/${scope}/${encodeURIComponent(name)}`);
      setBody(r.body);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (!open) return;
    setBusy(true);
    try {
      await api(`/skills/${open.scope}/${encodeURIComponent(open.name)}`, {
        method: "POST",
        body: { body },
      });
      setInfo(`saved ${open.scope}/${open.name}`);
      setTimeout(() => setInfo(null), 3000);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [open, body, load]);

  const remove = useCallback(async () => {
    if (!open) return;
    if (!confirm(`Delete skill ${open.scope}/${open.name}?`)) return;
    setBusy(true);
    try {
      await api(`/skills/${open.scope}/${encodeURIComponent(open.name)}`, { method: "DELETE" });
      setOpen(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [open, load]);

  const create = useCallback(async () => {
    if (!newName.trim()) return;
    setBusy(true);
    const stub = `---\nname: ${newName.trim()}\ndescription: TODO — one-line description that helps the model match this skill\n---\n\n# ${newName.trim()}\n\n`;
    try {
      await api(`/skills/${newScope}/${encodeURIComponent(newName.trim())}`, {
        method: "POST",
        body: { body: stub },
      });
      setNewName("");
      await load();
      openSkill(newScope, newName.trim());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [newName, newScope, load, openSkill]);

  if (!data && !error) return html`<div class="boot">loading skills…</div>`;
  if (error && !data) return html`<div class="notice err">${error}</div>`;

  if (open) {
    return html`
      <div>
        <div class="panel-header">
          <h2 class="panel-title">Skill · ${open.scope}/${open.name}</h2>
          <button onClick=${() => setOpen(null)} style="margin-left: auto;">← back</button>
        </div>
        ${info ? html`<div class="notice">${info}</div>` : null}
        ${error ? html`<div class="notice err">${error}</div>` : null}
        <textarea
          style="width: 100%; height: 520px; font-family: var(--mono); font-size: 13px; background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px;"
          value=${body}
          onInput=${(e) => setBody(e.target.value)}
          disabled=${busy}
        ></textarea>
        <div class="row" style="margin-top: 8px;">
          <button class="primary" disabled=${busy} onClick=${save}>Save</button>
          <button class="danger" disabled=${busy} onClick=${remove}>Delete</button>
          <span class="muted" style="font-size: 12px; margin-left: auto;">re-loaded on next /new or session restart</span>
        </div>
      </div>
    `;
  }

  const renderList = (label, items, scope) => html`
    <div class="section-title">${label} (${items.length})</div>
    ${
      items.length === 0
        ? html`<div class="empty">none</div>`
        : html`
        <table>
          <thead><tr><th>name</th><th>description</th><th></th></tr></thead>
          <tbody>
            ${items.map(
              (s) => html`
              <tr key=${s.name} style="cursor: ${scope === "builtin" ? "default" : "pointer"};" onClick=${() => scope !== "builtin" && openSkill(scope, s.name)}>
                <td><code>${s.name}</code></td>
                <td>${s.description ?? html`<span class="muted">(no description)</span>`}</td>
                <td>${scope === "builtin" ? html`<span class="pill pill-dim">builtin</span>` : null}</td>
              </tr>
            `,
            )}
          </tbody>
        </table>
      `
    }
  `;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Skills</h2>
        <span class="panel-subtitle">click to edit · creates land in next /new</span>
      </div>
      ${error ? html`<div class="notice err">${error}</div>` : null}

      <div class="section-title">Create new</div>
      <div class="card row">
        <select value=${newScope} onChange=${(e) => setNewScope(e.target.value)}>
          <option value="global">global</option>
          ${data.paths.project ? html`<option value="project">project</option>` : null}
        </select>
        <input
          type="text"
          placeholder="skill-name"
          value=${newName}
          onInput=${(e) => setNewName(e.target.value)}
        />
        <button class="primary" disabled=${busy || !newName.trim()} onClick=${create}>Create</button>
      </div>

      ${renderList("Project", data.project, "project")}
      ${renderList("Global", data.global, "global")}
      ${renderList("Builtin (read-only)", data.builtin, "builtin")}
    </div>
  `;
}

// ---------- MCP ----------

// ---------- Semantic index ----------

function SemanticPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api("/semantic");
      setData(r);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // Poll fast while a job is running OR while ollama is pulling a
  // model (the latest-line readout updates every few hundred ms during
  // a download). Slow when idle so the panel doesn't burn network just
  // sitting open in a tab.
  useEffect(() => {
    load();
    const phase = data?.job?.phase;
    const running = phase === "scan" || phase === "embed" || phase === "write";
    const pulling = data?.pull?.status === "pulling";
    const ms = running || pulling ? 1200 : 5000;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [load, data?.job?.phase, data?.pull?.status]);

  const start = useCallback(
    async (rebuild) => {
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        await api("/semantic/start", { method: "POST", body: { rebuild: !!rebuild } });
        setInfo(rebuild ? "rebuild started" : "incremental index started");
        await load();
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/semantic/stop", { method: "POST", body: {} });
      setInfo("stopping requested — current chunk batch will finish first");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const startDaemon = useCallback(async () => {
    setBusy(true);
    setError(null);
    setInfo("starting ollama daemon (15s timeout)…");
    try {
      const r = await api("/semantic/ollama/start", { method: "POST", body: {} });
      setInfo(
        r.ready ? "daemon is up" : "daemon didn't come up in time — check `ollama serve` manually",
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const pullModel = useCallback(
    async (model) => {
      setBusy(true);
      setError(null);
      setInfo(`pulling ${model} — this may take a few minutes on first install`);
      try {
        await api("/semantic/ollama/pull", { method: "POST", body: { model } });
        await load();
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!data && !error) return html`<div class="boot">loading semantic status…</div>`;
  if (error && !data) return html`<div class="notice err">${error}</div>`;

  if (data && !data.attached) {
    return html`
      <div>
        <div class="panel-header">
          <h2 class="panel-title">Semantic</h2>
          <span class="panel-subtitle">code-mode required</span>
        </div>
        <div class="empty">${data.reason}</div>
      </div>
    `;
  }

  const job = data.job;
  const phase = job?.phase;
  const running = phase === "scan" || phase === "embed" || phase === "write";
  const pull = data.pull;
  const pulling = pull?.status === "pulling";

  // Tri-state Ollama check. Each level gates the next:
  //   binary missing → user must install (we won't run a package
  //                    manager on their behalf).
  //   daemon down    → one-click start (`ollama serve`).
  //   model missing  → one-click pull.
  //   all good       → ready to index.
  const o = data.ollama ?? {};
  const binaryFound = o.binaryFound === true;
  const daemonRunning = o.daemonRunning === true;
  const modelPulled = o.modelPulled === true;
  const modelName = o.modelName ?? "nomic-embed-text";
  const installedModels = o.installedModels ?? [];
  const ready = binaryFound && daemonRunning && modelPulled;

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">Semantic</h2>
        <span class="panel-subtitle">${data.index.exists ? "index built" : "no index yet"}</span>
      </div>
      ${info ? html`<div class="notice">${info}</div>` : null}
      ${error ? html`<div class="notice err">${error}</div>` : null}

      <div class="section-title">Status</div>
      <div class="kv">
        <div><span class="kv-key">project</span><code>${data.root}</code></div>
        <div>
          <span class="kv-key">ollama</span>
          ${
            binaryFound
              ? daemonRunning
                ? html`<span class="pill pill-ok">reachable</span><span class="muted" style="margin-left: 8px;">${installedModels.length} model(s)${
                    installedModels.length > 0
                      ? ` · ${installedModels.slice(0, 3).join(", ")}${installedModels.length > 3 ? "…" : ""}`
                      : ""
                  }</span>`
                : html`<span class="pill pill-warn">daemon down</span><span class="muted" style="margin-left: 8px;">binary on PATH but not serving</span>`
              : html`<span class="pill pill-err">not installed</span><span class="muted" style="margin-left: 8px;">${o.error ?? "ollama binary not on PATH"}</span>`
          }
        </div>
        <div>
          <span class="kv-key">model</span>
          <code>${modelName}</code>
          ${
            modelPulled
              ? html`<span class="pill pill-ok" style="margin-left: 8px;">pulled</span>`
              : daemonRunning
                ? html`<span class="pill pill-warn" style="margin-left: 8px;">not pulled</span>`
                : html`<span class="pill pill-dim" style="margin-left: 8px;">unknown (daemon down)</span>`
          }
        </div>
        <div>
          <span class="kv-key">index</span>
          ${
            data.index.exists
              ? html`<span class="muted">present at <code>.reasonix/semantic/</code></span>`
              : html`<span class="muted">none — run an index to enable <code>semantic_search</code></span>`
          }
        </div>
      </div>

      ${
        !binaryFound
          ? html`
            <div class="section-title">Install Ollama</div>
            <div class="card" style="font-size: 13px;">
              Reasonix doesn't run package managers for you. Install Ollama
              first, then come back to this panel:
              <ul style="margin: 10px 0 4px 18px; padding: 0;">
                <li><strong>macOS / Windows:</strong> download from <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a></li>
                <li><strong>Linux:</strong> <code>curl -fsSL https://ollama.com/install.sh | sh</code></li>
              </ul>
              <div class="muted" style="margin-top: 8px;">After install, this panel will offer to start the daemon and pull <code>${modelName}</code> for you. Refresh after installing.</div>
            </div>
          `
          : null
      }

      ${
        binaryFound && !daemonRunning
          ? html`
            <div class="section-title">Daemon</div>
            <div class="card" style="font-size: 13px;">
              <code>ollama</code> is on your PATH but the HTTP daemon isn't reachable.
              <div class="row" style="margin-top: 10px;">
                <button class="primary" disabled=${busy} onClick=${startDaemon}>Start daemon</button>
                <span class="muted" style="font-size: 12px; align-self: center;">runs <code>ollama serve</code> detached — survives Reasonix exit</span>
              </div>
            </div>
          `
          : null
      }

      ${
        daemonRunning && !modelPulled
          ? html`
            <div class="section-title">Model</div>
            <div class="card" style="font-size: 13px;">
              <code>${modelName}</code> isn't installed yet. ${pulling ? "" : "~270 MB download on first pull."}
              <div class="row" style="margin-top: 10px;">
                <button
                  class="primary"
                  disabled=${busy || pulling}
                  onClick=${() => pullModel(modelName)}
                >${pulling ? "pulling…" : `Pull ${modelName}`}</button>
              </div>
              ${
                pull
                  ? html`
                    <div class="kv" style="margin-top: 10px;">
                      <div>
                        <span class="kv-key">status</span>
                        <span class=${`pill ${pull.status === "done" ? "pill-ok" : pull.status === "error" ? "pill-err" : "pill-active"}`}>${pull.status}</span>
                        <span class="muted" style="margin-left: 8px;">${((Date.now() - pull.startedAt) / 1000).toFixed(1)}s</span>
                      </div>
                      ${
                        pull.lastLine
                          ? html`<div><span class="kv-key">last</span><code style="font-size: 11.5px;">${pull.lastLine}</code></div>`
                          : null
                      }
                    </div>
                  `
                  : null
              }
            </div>
          `
          : null
      }

      <div class="section-title">Job</div>
      ${job ? html`<${SemanticJobView} job=${job} running=${running} />` : html`<div class="muted">No job has run in this dashboard yet.</div>`}

      <div class="row" style="margin-top: 14px;">
        <button class="primary" disabled=${busy || running || !ready} onClick=${() => start(false)}>Index (incremental)</button>
        <button disabled=${busy || running || !ready} onClick=${() => start(true)}>Rebuild (wipe + full)</button>
        <button disabled=${busy || !running} onClick=${stop}>Stop</button>
      </div>

      <${SemanticExcludesCard} />
    </div>
  `;
}

function SemanticExcludesCard() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api("/index-config");
      setData(r);
      setDraft(toDraft(r.resolved));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    if (open && !data) load();
  }, [open, data, load]);

  const reset = useCallback(() => {
    if (data) setDraft(toDraft(data.defaults));
    setPreview(null);
  }, [data]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const payload = fromDraft(draft);
      const r = await api("/index-config", { method: "POST", body: payload });
      setInfo(`saved · ${r.changed.length || 0} fields updated · re-run index to apply`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [draft, load]);

  const runPreview = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setInfo("running dry walk against project root…");
    try {
      const payload = fromDraft(draft);
      const r = await api("/index-config/preview", { method: "POST", body: payload });
      setPreview(r);
      setInfo(null);
    } catch (err) {
      setError(err.message);
      setInfo(null);
    } finally {
      setBusy(false);
    }
  }, [draft]);

  return html`
    <div class="section-title" style="margin-top: 18px;">
      <span style="cursor: pointer;" onClick=${() => setOpen(!open)}>
        ${open ? "▼" : "▶"} Excludes
      </span>
      <span class="muted" style="margin-left: 8px; font-weight: normal; font-size: 12px;">
        config-driven skip rules applied during indexing
      </span>
    </div>
    ${
      !open
        ? null
        : !draft
          ? html`<div class="muted">loading…</div>`
          : html`
            <div class="card" style="font-size: 13px;">
              ${info ? html`<div class="notice">${info}</div>` : null}
              ${error ? html`<div class="notice err">${error}</div>` : null}
              <div class="muted" style="margin-bottom: 10px;">
                One value per line. Dirs / files match by basename. Patterns use picomatch (e.g. <code>**/*.generated.ts</code>, <code>vendor/**</code>).
              </div>
              <${ExcludesField} label="Exclude dirs" value=${draft.excludeDirs} onChange=${(v) => setDraft({ ...draft, excludeDirs: v })} />
              <${ExcludesField} label="Exclude files" value=${draft.excludeFiles} onChange=${(v) => setDraft({ ...draft, excludeFiles: v })} />
              <${ExcludesField} label="Exclude extensions" value=${draft.excludeExts} onChange=${(v) => setDraft({ ...draft, excludeExts: v })} />
              <${ExcludesField} label="Exclude patterns (glob)" value=${draft.excludePatterns} onChange=${(v) => setDraft({ ...draft, excludePatterns: v })} />
              <div class="row" style="margin-top: 10px; gap: 16px;">
                <label style="display: flex; align-items: center; gap: 6px;">
                  <input type="checkbox" checked=${draft.respectGitignore} onChange=${(e) => setDraft({ ...draft, respectGitignore: e.target.checked })} />
                  Respect <code>.gitignore</code>
                </label>
                <label style="display: flex; align-items: center; gap: 6px;">
                  Max file size:
                  <input type="number" min="1024" step="1024" value=${draft.maxFileBytes} onChange=${(e) => setDraft({ ...draft, maxFileBytes: Number(e.target.value) || 0 })} style="width: 110px;" />
                  <span class="muted">bytes</span>
                </label>
              </div>
              <div class="row" style="margin-top: 12px;">
                <button class="primary" disabled=${busy} onClick=${save}>Save</button>
                <button disabled=${busy} onClick=${runPreview}>Preview (dry-walk)</button>
                <button disabled=${busy} onClick=${reset}>Reset to defaults</button>
              </div>
              ${preview ? html`<${ExcludesPreview} preview=${preview} />` : null}
            </div>
          `
    }
  `;
}

function ExcludesPreview({ preview }) {
  const buckets = preview.skipBuckets || {};
  const samples = preview.skipSamples || {};
  const totalSkipped = Object.values(buckets).reduce((a, b) => a + (b || 0), 0);
  const reasons = [
    "gitignore",
    "pattern",
    "defaultDir",
    "defaultFile",
    "binaryExt",
    "binaryContent",
    "tooLarge",
    "readError",
  ].filter((k) => (buckets[k] || 0) > 0);
  return html`
    <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border, #2a2a2a);">
      <div style="font-weight: 500; margin-bottom: 6px;">
        Preview — would index <strong>${preview.filesIncluded}</strong> file(s), skip <strong>${totalSkipped}</strong>
      </div>
      ${
        reasons.length === 0
          ? html`<div class="muted" style="font-size: 12px;">nothing skipped — all walked files would be indexed.</div>`
          : html`
            <div style="font-size: 12px;">
              ${reasons.map(
                (r) => html`
                  <details style="margin-bottom: 6px;">
                    <summary><strong>${r}: ${buckets[r]}</strong></summary>
                    <ul style="margin: 4px 0 4px 18px; padding: 0;">
                      ${(samples[r] || []).map(
                        (p) => html`<li><code style="font-size: 11.5px;">${p}</code></li>`,
                      )}
                      ${
                        (buckets[r] || 0) > (samples[r] || []).length
                          ? html`<li class="muted">…${buckets[r] - samples[r].length} more</li>`
                          : null
                      }
                    </ul>
                  </details>
                `,
              )}
            </div>
          `
      }
      ${
        preview.sampleIncluded?.length
          ? html`
            <details style="margin-top: 8px;">
              <summary class="muted" style="font-size: 12px;">first ${preview.sampleIncluded.length} included file(s)</summary>
              <ul style="margin: 4px 0 4px 18px; padding: 0; font-size: 12px;">
                ${preview.sampleIncluded.map((p) => html`<li><code style="font-size: 11.5px;">${p}</code></li>`)}
              </ul>
            </details>
          `
          : null
      }
    </div>
  `;
}

function ExcludesField({ label, value, onChange }) {
  return html`
    <div style="margin-bottom: 8px;">
      <label style="display: block; font-weight: 500; margin-bottom: 4px;">${label}</label>
      <textarea
        rows="4"
        style="width: 100%; font-family: var(--mono, monospace); font-size: 12px;"
        value=${value}
        onChange=${(e) => onChange(e.target.value)}
      ></textarea>
    </div>
  `;
}

function toDraft(c) {
  return {
    excludeDirs: (c.excludeDirs ?? []).join("\n"),
    excludeFiles: (c.excludeFiles ?? []).join("\n"),
    excludeExts: (c.excludeExts ?? []).join("\n"),
    excludePatterns: (c.excludePatterns ?? []).join("\n"),
    respectGitignore: c.respectGitignore !== false,
    maxFileBytes: c.maxFileBytes ?? 262144,
  };
}

function fromDraft(d) {
  const lines = (s) =>
    s
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  return {
    excludeDirs: lines(d.excludeDirs),
    excludeFiles: lines(d.excludeFiles),
    excludeExts: lines(d.excludeExts),
    excludePatterns: lines(d.excludePatterns),
    respectGitignore: !!d.respectGitignore,
    maxFileBytes: d.maxFileBytes,
  };
}

function SemanticJobView({ job, running }) {
  const phaseLabel =
    {
      scan: "scanning files",
      embed: "embedding chunks",
      write: "writing index",
      done: "done",
      error: "error",
    }[job.phase] ?? job.phase;
  const total = job.chunksTotal ?? 0;
  const doneN = job.chunksDone ?? 0;
  const ratio = total > 0 ? Math.min(1, doneN / total) : 0;
  const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);

  return html`
    <div class="kv">
      <div><span class="kv-key">phase</span>
        <span class=${`pill ${job.phase === "error" ? "pill-err" : running ? "pill-active" : "pill-dim"}`}>${phaseLabel}</span>
        ${job.aborted ? html`<span class="pill pill-warn" style="margin-left: 6px;">stopping</span>` : null}
        <span class="muted" style="margin-left: 8px;">${elapsed}s</span>
      </div>
      ${
        job.filesScanned !== null && job.filesScanned !== undefined
          ? html`<div><span class="kv-key">files</span>scanned ${job.filesScanned}${
              job.filesChanged != null ? ` · changed ${job.filesChanged}` : ""
            }${job.filesSkipped ? ` · skipped ${job.filesSkipped}` : ""}</div>`
          : null
      }
      ${
        total > 0
          ? html`
            <div>
              <span class="kv-key">chunks</span>${doneN} / ${total} (${(ratio * 100).toFixed(0)}%)
            </div>
            <div class="bar" style="margin-top: 4px;">
              <div class="fill" style=${`width: ${(ratio * 100).toFixed(1)}%; background: var(--primary);`}></div>
            </div>
          `
          : null
      }
      ${
        job.error
          ? html`<div><span class="kv-key">error</span><span class="err">${job.error}</span></div>`
          : null
      }
      ${
        job.result
          ? html`<div><span class="kv-key">result</span>added ${job.result.chunksAdded} · removed ${job.result.chunksRemoved}${
              job.result.chunksSkipped ? ` · failed ${job.result.chunksSkipped}` : ""
            } · ${(job.result.durationMs / 1000).toFixed(1)}s</div>`
          : null
      }
      ${
        job.result?.skipBuckets
          ? html`<${SkipBucketsView} buckets=${job.result.skipBuckets} />`
          : null
      }
    </div>
  `;
}

function SkipBucketsView({ buckets }) {
  const order = [
    ["gitignore", "gitignore"],
    ["pattern", "pattern"],
    ["defaultDir", "defaultDir"],
    ["defaultFile", "defaultFile"],
    ["binaryExt", "binaryExt"],
    ["binaryContent", "binaryContent"],
    ["tooLarge", "tooLarge"],
    ["readError", "readError"],
  ];
  const total = order.reduce((a, [k]) => a + (buckets[k] || 0), 0);
  if (total === 0) return null;
  const parts = order
    .filter(([k]) => (buckets[k] || 0) > 0)
    .map(([k, label]) => `${label}: ${buckets[k]}`);
  return html`<div><span class="kv-key">skipped</span>${total} files <span class="muted">(${parts.join(", ")})</span></div>`;
}

function McpPanel() {
  const [data, setData] = useState(null);
  const [specs, setSpecs] = useState(null);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [newSpec, setNewSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null); // server detail

  const load = useCallback(async () => {
    try {
      setData(await api("/mcp"));
      setSpecs((await api("/mcp/specs")).specs);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const addSpec = useCallback(async () => {
    if (!newSpec.trim()) return;
    setBusy(true);
    try {
      const r = await api("/mcp/specs", { method: "POST", body: { spec: newSpec.trim() } });
      setInfo(
        r.requiresRestart ? "saved — restart `reasonix code` to bridge this server" : "saved",
      );
      setTimeout(() => setInfo(null), 4000);
      setNewSpec("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [newSpec, load]);

  const removeSpec = useCallback(
    async (spec) => {
      if (!confirm(`Remove MCP spec from config?\n\n${spec}`)) return;
      setBusy(true);
      try {
        await api("/mcp/specs", { method: "DELETE", body: { spec } });
        setInfo("removed — restart to drop the live bridge");
        setTimeout(() => setInfo(null), 4000);
        await load();
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!data && !error) return html`<div class="boot">loading MCP…</div>`;
  if (error && !data) return html`<div class="notice err">${error}</div>`;

  if (open) {
    return html`
      <div>
        <div class="panel-header">
          <h2 class="panel-title">MCP · ${open.label}</h2>
          <button onClick=${() => setOpen(null)} style="margin-left: auto;">← back</button>
        </div>
        <div class="card">
          <div class="row"><span class="card-title" style="margin: 0; flex: 0 0 110px;">spec</span><code>${open.spec}</code></div>
          <div class="row"><span class="card-title" style="margin: 0; flex: 0 0 110px;">server</span><span>${open.serverInfo?.name ?? "—"} ${open.serverInfo?.version ? `v${open.serverInfo.version}` : ""}</span></div>
          <div class="row"><span class="card-title" style="margin: 0; flex: 0 0 110px;">protocol</span><code>${open.protocolVersion}</code></div>
        </div>
        ${open.instructions ? html`<div class="notice">${open.instructions}</div>` : null}
        <div class="section-title">Tools (${open.tools.length})</div>
        <table>
          <thead><tr><th>name</th><th>description</th></tr></thead>
          <tbody>
            ${open.tools.map((t) => html`<tr><td><code>${t.name}</code></td><td>${t.description ?? ""}</td></tr>`)}
          </tbody>
        </table>
        ${
          open.resources.length > 0
            ? html`
          <div class="section-title">Resources (${open.resources.length})</div>
          <table>
            <thead><tr><th>name</th><th>uri</th></tr></thead>
            <tbody>
              ${open.resources.map((r) => html`<tr><td>${r.name}</td><td><code>${r.uri}</code></td></tr>`)}
            </tbody>
          </table>
        `
            : null
        }
        ${
          open.prompts.length > 0
            ? html`
          <div class="section-title">Prompts (${open.prompts.length})</div>
          <table>
            <thead><tr><th>name</th><th>description</th></tr></thead>
            <tbody>
              ${open.prompts.map((p) => html`<tr><td><code>${p.name}</code></td><td>${p.description ?? ""}</td></tr>`)}
            </tbody>
          </table>
        `
            : null
        }
      </div>
    `;
  }

  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">MCP</h2>
        <span class="panel-subtitle">${data.servers.length} bridged · ${specs?.length ?? 0} in config</span>
      </div>
      ${info ? html`<div class="notice">${info}</div>` : null}
      ${error ? html`<div class="notice err">${error}</div>` : null}

      <div class="section-title">Add server</div>
      <div class="card row">
        <input
          type="text"
          placeholder='spec — e.g. "fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe"'
          value=${newSpec}
          onInput=${(e) => setNewSpec(e.target.value)}
        />
        <button class="primary" disabled=${busy || !newSpec.trim()} onClick=${addSpec}>Add</button>
      </div>

      <div class="section-title">Bridged (${data.servers.length})</div>
      ${
        data.servers.length === 0
          ? html`<div class="empty">No MCP servers in this session.</div>`
          : html`
          <table>
            <thead><tr><th>label</th><th>spec</th><th class="numeric">tools</th><th></th></tr></thead>
            <tbody>
              ${data.servers.map(
                (s) => html`
                <tr key=${s.label} style="cursor: pointer;" onClick=${() => setOpen(s)}>
                  <td><code>${s.label}</code></td>
                  <td><code style="font-size: 11px;">${s.spec}</code></td>
                  <td class="numeric">${fmtNum(s.toolCount)}</td>
                  <td></td>
                </tr>
              `,
              )}
            </tbody>
          </table>
        `
      }

      <div class="section-title">Persisted specs (config.json)</div>
      ${
        (specs ?? []).length === 0
          ? html`<div class="empty">No MCP specs persisted in <code>~/.reasonix/config.json</code>.</div>`
          : html`
          <table>
            <thead><tr><th>spec</th><th></th></tr></thead>
            <tbody>
              ${specs.map(
                (spec) => html`
                <tr key=${spec}>
                  <td><code>${spec}</code></td>
                  <td class="numeric">
                    <button class="danger" disabled=${busy} onClick=${(e) => {
                      e.stopPropagation();
                      removeSpec(spec);
                    }}>remove</button>
                  </td>
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

// ---------- Editor (CodeMirror 6, multi-tab) ----------

// Lazy-loaded CodeMirror modules — kept off the initial bundle so users
// who never open Editor never pay the ~200KB cost. Cached after first
// resolve so tab switches don't re-fetch.
//
// CodeMirror loads from a locally bundled file (`/assets/codemirror.js`,
// produced by `scripts/bundle-codemirror.mjs`). One bundle = one copy
// of every package = no Tag identity mismatch between oneDark and the
// language parsers, no esm.sh round-trips on every cold load. The
// previous esm.sh + ?deps= setup hit silent failure modes whenever the
// CDN resolved a transitive @lezer/* to a different version than the
// bundled cache thought it would.
let cmModulesPromise = null;
async function loadCodeMirror() {
  if (cmModulesPromise) return cmModulesPromise;
  cmModulesPromise = import(`/assets/codemirror.js?token=${TOKEN}`);
  return cmModulesPromise;
}

// Map file path → CodeMirror language extension factory.
function langExtensionFor(path, langs) {
  const lang = langFromPath(path);
  if (!lang) return null;
  // CodeMirror's javascript pack handles ts/tsx/jsx via options.
  if (lang === "typescript") return langs.typescript ? langs.typescript() : null;
  if (lang === "javascript") return langs.javascript ? langs.javascript({ jsx: true }) : null;
  const fn = langs[lang];
  return fn ? fn() : null;
}

// Build a nested folder tree from a flat list of repo paths. Nodes use
// Maps so insertion order is stable; sorting happens at render time.
function buildFileTree(paths) {
  const root = { name: "", path: "", children: new Map(), isFile: false };
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const name = parts[i];
      const childPath = parts.slice(0, i + 1).join("/");
      let child = node.children.get(name);
      if (!child) {
        child = { name, path: childPath, children: new Map(), isFile: isLast };
        node.children.set(name, child);
      } else if (isLast && child.children.size === 0) {
        child.isFile = true;
      }
      node = child;
    }
  }
  return root;
}

// Walk the tree honoring the expanded set; produce a flat row list the
// renderer can map straight to JSX. Folders precede files; both sorted
// case-insensitively.
function flattenTree(node, expanded, depth, out) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const child of children) {
    out.push({ name: child.name, path: child.path, depth, isFile: child.isFile });
    if (!child.isFile && expanded.has(child.path)) {
      flattenTree(child, expanded, depth + 1, out);
    }
  }
  return out;
}

function EditorPanel({ onClose } = {}) {
  // tabs: { path, content, original, dirty, savedAt }
  const [tabs, setTabs] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [files, setFiles] = useState([]);
  const [filesError, setFilesError] = useState(null);
  const [openInput, setOpenInput] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cmReady, setCmReady] = useState(false);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  // View mode for markdown tabs: "edit" (source only), "split" (source +
  // preview side-by-side), "preview" (rendered only). Non-md tabs always
  // render in edit mode regardless of this state.
  const [viewMode, setViewMode] = useState("edit");
  const editorContainerRef = useRef(null);
  const viewRef = useRef(null);
  const cmRef = useRef(null);
  const tabsRef = useRef(tabs);
  const activeIdxRef = useRef(activeIdx);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activeIdxRef.current = activeIdx;
  }, [activeIdx]);

  // Load file list (gitignore-aware) for the picker.
  const loadFiles = useCallback(async () => {
    try {
      const r = await api("/files");
      setFiles(r.files ?? []);
    } catch (err) {
      setFilesError(err.message);
    }
  }, []);
  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // Open a file → fetch + push tab + activate. If already open, just
  // switch to the existing tab so we don't lose unsaved edits.
  const openPath = useCallback(async (path) => {
    if (!path) return;
    const existing = tabsRef.current.findIndex((t) => t.path === path);
    if (existing >= 0) {
      setActiveIdx(existing);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/file/${path.split("/").map(encodeURIComponent).join("/")}`);
      setTabs((prev) => [
        ...prev,
        { path, content: r.content, original: r.content, dirty: false, savedAt: r.mtime },
      ]);
      setActiveIdx(tabsRef.current.length);
    } catch (err) {
      setError(`open ${path}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  // Subscribe to "open-file" events fired from elsewhere (Chat panel
  // tool cards, file-mention links).
  useEffect(() => {
    const onOpen = (ev) => openPath(ev.detail.path);
    appBus.addEventListener("open-file", onOpen);
    return () => appBus.removeEventListener("open-file", onOpen);
  }, [openPath]);

  // Mount CodeMirror lazily on first render.
  useEffect(() => {
    let cancelled = false;
    loadCodeMirror().then((cm) => {
      if (!cancelled) {
        cmRef.current = cm;
        setCmReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-mount the editor view when active tab changes. Each tab's
  // content is held in React state — the view is just a presentation
  // layer over the current tab's string.
  useEffect(() => {
    if (!cmReady || !editorContainerRef.current) return;
    const cm = cmRef.current;
    if (!cm) return;
    const tab = tabs[activeIdx];
    if (!tab) {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      return;
    }

    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    const langExt = langExtensionFor(tab.path, cm.langs);
    const updateListener = cm.EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const text = update.state.doc.toString();
        // Mutate the tab's content + dirty flag without forcing a
        // full re-render of the editor (which would lose the cursor).
        // We DO setTabs so the tab bar's dirty dot updates.
        const idx = activeIdxRef.current;
        const live = tabsRef.current;
        if (live[idx]) {
          const next = [...live];
          next[idx] = { ...next[idx], content: text, dirty: text !== next[idx].original };
          tabsRef.current = next;
          setTabs(next);
        }
      }
    });

    const extensions = [
      cm.lineNumbers(),
      cm.highlightActiveLineGutter ? cm.highlightActiveLineGutter() : [],
      cm.foldGutter ? cm.foldGutter() : [],
      cm.highlightActiveLine(),
      cm.drawSelection(),
      cm.history(),
      cm.bracketMatching(),
      cm.indentOnInput(),
      cm.closeBrackets ? cm.closeBrackets() : [],
      cm.autocompletion
        ? cm.autocompletion({
            activateOnTyping: true,
            closeOnBlur: true,
            maxRenderedOptions: 30,
          })
        : [],
      cm.highlightSelectionMatches ? cm.highlightSelectionMatches() : [],
      cm.keymap.of([
        ...cm.defaultKeymap,
        ...cm.historyKeymap,
        ...(cm.closeBracketsKeymap ?? []),
        ...(cm.searchKeymap ?? []),
        ...(cm.completionKeymap ?? []),
        ...(cm.foldKeymap ?? []),
        cm.indentWithTab,
      ]),
      // oneDark is an array of [theme, syntaxHighlighting(oneDarkHighlightStyle)] —
      // including it gives both the dark UI and the highlight tags. Keep
      // defaultHighlightStyle as a fallback only for languages oneDark omits.
      cm.oneDark,
      cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }),
      cm.EditorView.lineWrapping,
      updateListener,
    ];
    if (langExt) extensions.push(langExt);

    const state = cm.EditorState.create({ doc: tab.content, extensions });
    viewRef.current = new cm.EditorView({ state, parent: editorContainerRef.current });

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [cmReady, activeIdx, tabs[activeIdx]?.path, viewMode]);

  const closeTab = useCallback((idx) => {
    const tab = tabsRef.current[idx];
    if (tab?.dirty && !confirm(`${tab.path} has unsaved changes. Discard?`)) return;
    setTabs((prev) => prev.filter((_, i) => i !== idx));
    if (activeIdxRef.current >= idx) {
      setActiveIdx(Math.max(0, activeIdxRef.current - 1));
    }
  }, []);

  const saveTab = useCallback(async (idx) => {
    const tab = tabsRef.current[idx];
    if (!tab) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/file/${tab.path.split("/").map(encodeURIComponent).join("/")}`, {
        method: "POST",
        body: { content: tab.content },
      });
      setTabs((prev) => {
        const next = [...prev];
        if (next[idx]) {
          next[idx] = { ...next[idx], original: tab.content, dirty: false, savedAt: r.mtime };
        }
        return next;
      });
      showToast(`saved ${tab.path}`, "info");
    } catch (err) {
      setError(`save ${tab.path}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  // Cmd/Ctrl+S — save active tab.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (tabsRef.current[activeIdxRef.current]) {
          saveTab(activeIdxRef.current);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveTab]);

  const tab = tabs[activeIdx];

  const tree = useMemo(() => buildFileTree(files), [files]);
  const treeRows = useMemo(() => flattenTree(tree, expanded, 0, []), [tree, expanded]);

  const toggleFolder = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const filtering = filter.trim().length > 0;
  const filteredFiles = filtering
    ? files.filter((f) => f.toLowerCase().includes(filter.toLowerCase())).slice(0, 80)
    : null;

  const openPaths = tabs.map((t) => t.path);

  return html`
    <div class="editor-shell">
      ${
        onClose
          ? html`
          <div class="editor-drawer-head">
            <span class="editor-drawer-title">Editor</span>
            <button class="editor-drawer-close" onClick=${onClose} title="close editor (Esc)">×</button>
          </div>
        `
          : null
      }
      <div class="editor-tabs">
        ${
          tabs.length === 0
            ? html`<div class="editor-no-tabs">No files open. Pick from the list, paste a path above, or click a path in chat.</div>`
            : tabs.map(
                (t, i) => html`
            <div
              key=${t.path}
              class="editor-tab ${i === activeIdx ? "active" : ""}"
              onClick=${() => setActiveIdx(i)}
            >
              <span class="editor-tab-name" title=${t.path}>${t.path.split("/").pop()}</span>
              ${t.dirty ? html`<span class="editor-tab-dirty">●</span>` : null}
              <span class="editor-tab-close" onClick=${(e) => {
                e.stopPropagation();
                closeTab(i);
              }}>×</span>
            </div>
          `,
              )
        }
      </div>
      <div class="editor-body">
      ${
        sideCollapsed
          ? html`
          <div class="editor-side collapsed">
            <button
              class="editor-side-toggle"
              onClick=${() => setSideCollapsed(false)}
              title="show files"
            >▶</button>
          </div>
        `
          : html`
          <div class="editor-side">
            <div class="editor-side-head">
              <span class="editor-side-label">FILES</span>
              <button
                class="editor-side-toggle"
                onClick=${() => setSideCollapsed(true)}
                title="hide files"
              >◀</button>
            </div>
            <div class="row" style="margin-bottom: 8px;">
              <input
                type="text"
                placeholder="open by path…"
                value=${openInput}
                onInput=${(e) => setOpenInput(e.target.value)}
                onKeyDown=${(e) => {
                  if (e.key === "Enter" && openInput.trim()) {
                    openPath(openInput.trim());
                    setOpenInput("");
                  }
                }}
              />
            </div>
            <input
              type="search"
              placeholder=${`filter ${files.length} files…`}
              value=${filter}
              onInput=${(e) => setFilter(e.target.value)}
              style="margin-bottom: 8px;"
            />
            ${
              filesError
                ? html`<div class="notice err">${filesError}</div>`
                : filtering
                  ? html`
                  <div class="editor-files">
                    ${filteredFiles.map(
                      (f) => html`
                      <div
                        key=${f}
                        class="editor-file ${openPaths.includes(f) ? "open" : ""}"
                        onClick=${() => openPath(f)}
                        title=${f}
                      >${f}</div>
                    `,
                    )}
                    ${files.length > 80 ? html`<div class="muted" style="padding: 8px; font-size: 11px;">narrow filter to see more</div>` : null}
                  </div>
                `
                  : html`
                  <div class="editor-files">
                    ${treeRows.map((row) =>
                      row.isFile
                        ? html`
                        <div
                          key=${row.path}
                          class="editor-tree-file ${openPaths.includes(row.path) ? "open" : ""}"
                          style=${`padding-left: ${row.depth * 12 + 22}px`}
                          onClick=${() => openPath(row.path)}
                          title=${row.path}
                        >${row.name}</div>
                      `
                        : html`
                        <div
                          key=${row.path}
                          class="editor-tree-folder"
                          style=${`padding-left: ${row.depth * 12 + 4}px`}
                          onClick=${() => toggleFolder(row.path)}
                        >
                          <span class="editor-tree-caret">${expanded.has(row.path) ? "▼" : "▶"}</span>
                          <span class="editor-tree-name">${row.name}</span>
                        </div>
                      `,
                    )}
                    ${files.length === 0 ? html`<div class="muted" style="padding: 8px; font-size: 11px;">no files</div>` : null}
                  </div>
                `
            }
          </div>
        `
      }

      <div class="editor-main">
        ${
          tab
            ? html`
            <div class="editor-bar">
              <code style="font-size: 12px;">${tab.path}</code>
              <span class="muted" style="font-size: 12px;">${langFromPath(tab.path) ?? "plaintext"}</span>
              ${
                langFromPath(tab.path) === "markdown"
                  ? html`
                  <div class="view-mode-group" style="margin-left: auto;">
                    <button
                      class=${`view-mode ${viewMode === "edit" ? "active" : ""}`}
                      onClick=${() => setViewMode("edit")}
                      title="source only"
                    >Edit</button>
                    <button
                      class=${`view-mode ${viewMode === "split" ? "active" : ""}`}
                      onClick=${() => setViewMode("split")}
                      title="source + preview side-by-side"
                    >Split</button>
                    <button
                      class=${`view-mode ${viewMode === "preview" ? "active" : ""}`}
                      onClick=${() => setViewMode("preview")}
                      title="rendered only"
                    >Preview</button>
                  </div>
                `
                  : null
              }
              <button
                class="primary"
                style=${langFromPath(tab.path) === "markdown" ? "" : "margin-left: auto;"}
                onClick=${() => saveTab(activeIdx)}
                disabled=${busy || !tab.dirty}
              >${tab.dirty ? "Save (⌘S)" : "Saved"}</button>
            </div>
            ${error ? html`<div class="notice err">${error}</div>` : null}
            ${(() => {
              const isMd = langFromPath(tab.path) === "markdown";
              const mode = isMd ? viewMode : "edit";
              if (mode === "preview") {
                return html`
                  <div
                    class="editor-host editor-md-preview md"
                    dangerouslySetInnerHTML=${{ __html: previewMarked.parse(tab.content ?? "") }}
                  ></div>
                `;
              }
              if (mode === "split") {
                return html`
                  <div class="editor-split">
                    <div ref=${editorContainerRef} class="editor-host editor-split-pane"></div>
                    <div
                      class="editor-host editor-md-preview md editor-split-pane"
                      dangerouslySetInnerHTML=${{
                        __html: previewMarked.parse(tab.content ?? ""),
                      }}
                    ></div>
                  </div>
                `;
              }
              return html`<div ref=${editorContainerRef} class="editor-host"></div>`;
            })()}
          `
            : html`
            <div class="editor-empty">
              ${
                cmReady
                  ? html`<div>Open a file to start editing.</div>`
                  : html`<div>Loading editor (~200KB CodeMirror)…</div>`
              }
            </div>
          `
        }
      </div>
      </div>
    </div>
  `;
}

function ComingSoonPanel({ name, milestone }) {
  return html`
    <div>
      <div class="panel-header">
        <h2 class="panel-title">${name}</h2>
        <span class="panel-subtitle">coming in ${milestone}</span>
      </div>
      <div class="empty">This panel lands in ${milestone} (see CHANGELOG).</div>
    </div>
  `;
}

// ---------- shell ----------

const TABS = [
  {
    id: "chat",
    name: "Chat",
    glyph: "◆",
    panel: () => html`<${ChatPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "editor",
    name: "Editor",
    glyph: "✎",
    panel: () => html`<${EditorPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "overview",
    name: "Overview",
    glyph: "◈",
    panel: () => html`<${OverviewPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "usage",
    name: "Usage",
    glyph: "$",
    panel: () => html`<${UsageWithChart} />`,
    ready: true,
    badge: null,
  },
  {
    id: "sessions",
    name: "Sessions",
    glyph: "›",
    panel: () => html`<${SessionsPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "plans",
    name: "Plans",
    glyph: "P",
    panel: () => html`<${PlansPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "tools",
    name: "Tools",
    glyph: "▣",
    panel: () => html`<${ToolsPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "permissions",
    name: "Permissions",
    glyph: "▎",
    panel: () => html`<${PermissionsPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "health",
    name: "System",
    glyph: "+",
    panel: () => html`<${SystemPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "semantic",
    name: "Semantic",
    glyph: "≈",
    panel: () => html`<${SemanticPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "mcp",
    name: "MCP",
    glyph: "M",
    panel: () => html`<${McpPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "skills",
    name: "Skills",
    glyph: "S",
    panel: () => html`<${SkillsPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "memory",
    name: "Memory",
    glyph: "·",
    panel: () => html`<${MemoryPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "hooks",
    name: "Hooks",
    glyph: "H",
    panel: () => html`<${HooksPanel} />`,
    ready: true,
    badge: null,
  },
  {
    id: "settings",
    name: "Settings",
    glyph: "⌘",
    panel: () => html`<${SettingsPanel} />`,
    ready: true,
    badge: null,
  },
];

// ---------- Toast system ----------
//
// One Set of currently-displayed toast objects, pushed via a custom
// DOM event so any panel can fire a toast without prop-drilling. Auto-
// dismiss after `ttl` ms (default 3000). The stack lives at the App
// level so toasts persist across tab switches.

const toastBus = new EventTarget();
function showToast(text, kind = "info", ttl = 3000) {
  toastBus.dispatchEvent(new CustomEvent("toast", { detail: { text, kind, ttl } }));
}

// ---------- App-wide event bus ----------
//
// Three events:
//   - "open-file"     { path }              Editor panel opens the path in a tab
//   - "navigate-tab"  { tabId }             App switches active sidebar tab
//   - "error"         { error, source }     global ErrorOverlay shows it full-screen
//
// Used by Chat tool cards / file-mention links to deep-link into the
// Editor without prop-drilling, and by global error handlers to surface
// crashes in a full-screen modal with a "Report on GitHub" button.

const appBus = new EventTarget();
function openFileInEditor(path) {
  if (!path) return;
  // Just signal "open this file" — the App-level editor drawer subscribes
  // and pops itself open. We don't navigate the sidebar; the drawer
  // sits over the current panel so the user can keep their place in
  // chat / overview / wherever they were.
  appBus.dispatchEvent(new CustomEvent("open-file", { detail: { path } }));
}

// ---------- Global error capture ----------
//
// Three sources feed into one overlay:
//   1. window.error              — sync exceptions, script load failures
//   2. window.unhandledrejection — async promise rejections
//   3. Preact ErrorBoundary       — render-time component exceptions
//
// All three normalize to `{ error, source, info? }` and dispatch via
// appBus. ErrorOverlay queues the most recent and lets the user copy
// the trace or open a pre-filled GitHub issue.

function reportAppError(error, source, info) {
  // Console-log so devtools still has the message even when the
  // overlay is dismissed; keeps "what just broke" debuggable.
  // eslint-disable-next-line no-console
  console.error(`[reasonix dashboard] ${source}:`, error, info);
  appBus.dispatchEvent(
    new CustomEvent("error", { detail: { error, source, info, ts: Date.now() } }),
  );
}

window.addEventListener("error", (ev) => {
  // Resource-load errors (failing img/script) come through with no
  // `error` object and are noisy; only surface real exceptions.
  if (!ev.error) return;
  reportAppError(ev.error, "window", ev.message);
});

window.addEventListener("unhandledrejection", (ev) => {
  reportAppError(ev.reason, "promise");
});

function ToastStack() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    const onToast = (ev) => {
      const id = `${Date.now()}-${Math.random()}`;
      const t = { id, ...ev.detail };
      setToasts((prev) => [...prev, t]);
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), t.ttl);
    };
    toastBus.addEventListener("toast", onToast);
    return () => toastBus.removeEventListener("toast", onToast);
  }, []);
  if (toasts.length === 0) return null;
  return html`
    <div class="toast-stack">
      ${toasts.map((t) => html`<div key=${t.id} class="toast ${t.kind}">${t.text}</div>`)}
    </div>
  `;
}

// ---------- Error overlay ----------
//
// Renders a full-screen modal whenever a window error / promise
// rejection / Preact render error fires through `appBus`. Includes a
// "Copy details" button (clipboard) and "Report on GitHub" link with a
// pre-filled body containing redacted environment info — the URL is
// safe to surface (token is never embedded; just version + UA + the
// trace itself).

const REPO_URL = "https://github.com/esengine/reasonix";

function buildIssueBody({ error, source, info }) {
  const ua = typeof navigator === "object" ? navigator.userAgent : "(unknown)";
  const errMsg = error?.message ?? String(error);
  const stack = error?.stack ?? "(no stack)";
  return [
    "**What happened**",
    "(describe what you were doing — typing, switching tabs, clicking a tool path, etc.)",
    "",
    "**Error**",
    "```",
    `${source}: ${errMsg}`,
    info ? `info: ${info}` : null,
    "",
    stack,
    "```",
    "",
    "**Environment**",
    `- Reasonix: ${MODE}`,
    `- Browser: ${ua}`,
    `- URL: ${location.pathname} (token redacted)`,
    "",
    "_Reported from the local dashboard's error overlay._",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function ErrorOverlay() {
  const [err, setErr] = useState(null); // { error, source, info, ts }
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onError = (ev) => {
      // Show only the latest — if a second fires while overlay is up,
      // it replaces. Cumulative replay would be nice but for now the
      // user can copy / file the issue with the most recent.
      setErr(ev.detail);
      setCopied(false);
    };
    appBus.addEventListener("error", onError);
    return () => appBus.removeEventListener("error", onError);
  }, []);

  // Esc dismisses (assuming non-fatal).
  useEffect(() => {
    if (!err) return;
    const onKey = (e) => {
      if (e.key === "Escape") setErr(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [err]);

  if (!err) return null;
  const error = err.error;
  const errMsg = error?.message ?? String(error);
  const stack = error?.stack ?? "(no stack)";

  const issueUrl = `${REPO_URL}/issues/new?title=${encodeURIComponent(`[dashboard] ${errMsg.slice(0, 80)}`)}&body=${encodeURIComponent(buildIssueBody(err))}`;

  const copyDetails = async () => {
    const body = buildIssueBody(err);
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can still hit "report on GitHub" */
    }
  };

  return html`
    <div class="error-overlay">
      <div class="error-overlay-card">
        <div class="error-overlay-head">
          <span class="error-overlay-icon">✦</span>
          <div>
            <div class="error-overlay-title">Something broke in the dashboard</div>
            <div class="error-overlay-subtitle">${err.source} error · ${errMsg}</div>
          </div>
        </div>

        <pre class="error-overlay-trace">${stack}</pre>

        ${
          err.info
            ? html`<div class="error-overlay-info"><strong>info:</strong> ${err.info}</div>`
            : null
        }

        <div class="error-overlay-help">
          The TUI is unaffected — only this browser tab tripped. You can
          dismiss and keep working, or report it so we can fix the
          underlying cause.
        </div>

        <div class="error-overlay-actions">
          <button class="primary" onClick=${copyDetails}>
            ${copied ? "Copied ✓" : "Copy details"}
          </button>
          <a class="button" href=${issueUrl} target="_blank" rel="noopener noreferrer">
            Report on GitHub
          </a>
          <button onClick=${() => setErr(null)} style="margin-left: auto;">Dismiss (Esc)</button>
        </div>
      </div>
    </div>
  `;
}

// Preact ErrorBoundary — catches render-time exceptions in the App
// subtree and dispatches them to the error overlay instead of leaving
// the user with a blank white page. Recovers automatically the first
// few times so transient hiccups don't strand the user; if a panel
// throws repeatedly we stop the loop and render a manual "Try again"
// fallback so the page never looks blank-but-ticking.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { caught: false, lastErr: null, attempts: 0 };
  }
  static getDerivedStateFromError(error) {
    return { caught: true, lastErr: error };
  }
  componentDidCatch(error, info) {
    reportAppError(error, "render", info?.componentStack ?? "");
    const attempts = (this.state.attempts ?? 0) + 1;
    if (attempts >= 3) {
      // Stop the auto-recover loop — the panel is genuinely broken,
      // surface a "Try again" button instead of flickering.
      this.setState({ attempts });
      return;
    }
    setTimeout(() => this.setState({ caught: false, attempts }), 100);
  }
  render() {
    if (this.state.caught) {
      if ((this.state.attempts ?? 0) >= 3) {
        return html`
          <div class="boot" style="flex-direction: column; gap: 12px;">
            <div>this panel keeps crashing — the error overlay has the trace.</div>
            <button onClick=${() => this.setState({ caught: false, attempts: 0 })}>
              Try again
            </button>
          </div>
        `;
      }
      return html`<div class="boot">recovering…</div>`;
    }
    return this.props.children;
  }
}

function App() {
  const [activeId, setActiveId] = useState("chat");
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  // Desktop "icon only" collapse — narrow sidebar that shows just the
  // glyphs. Persisted so the choice survives reload.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("rx.sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("rx.sidebarCollapsed", sidebarCollapsed ? "1" : "0");
    } catch {
      /* private mode / disabled storage — ignore */
    }
  }, [sidebarCollapsed]);
  // Editor drawer — opens whenever any panel fires "open-file" via
  // appBus. Lives at the App level so the editor's tab state persists
  // across sidebar-tab switches; you can open a file from Chat, switch
  // to Usage to glance at numbers, come back, and the editor's still
  // there. × on the drawer or Esc closes it.
  const [editorOpen, setEditorOpen] = useState(false);
  const active = TABS.find((t) => t.id === activeId) ?? TABS[0];

  // Esc anywhere closes the mobile drawer (modals already handle their
  // own Esc). On desktop the drawer is always-open so this is a no-op.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cross-component navigation — sidebar-tab switching when something
  // fires `navigate-tab` (kept in case other features want it; the
  // editor drawer no longer uses it).
  useEffect(() => {
    const onNav = (ev) => {
      const id = ev.detail?.tabId;
      if (id) setActiveId(id);
    };
    appBus.addEventListener("navigate-tab", onNav);
    return () => appBus.removeEventListener("navigate-tab", onNav);
  }, []);

  // Open the editor drawer whenever any panel signals a file-open.
  // The drawer's <EditorPanel> is permanently mounted (with display:
  // none when closed) so its tab state survives toggling — opening
  // the same file twice from chat doesn't lose unsaved changes.
  useEffect(() => {
    const onOpenFile = () => setEditorOpen(true);
    appBus.addEventListener("open-file", onOpenFile);
    return () => appBus.removeEventListener("open-file", onOpenFile);
  }, []);

  // Esc also closes the editor (in addition to the mobile drawer).
  useEffect(() => {
    if (!editorOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") setEditorOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorOpen]);

  const pickTab = useCallback((id) => {
    setActiveId(id);
    setSidebarOpen(false); // collapse drawer after pick on mobile
  }, []);

  return html`
    <div class=${`sidebar ${sidebarOpen ? "open" : ""} ${sidebarCollapsed ? "collapsed" : ""}`}>
      <div class="sidebar-header">
        <div class="sidebar-brand" title="Reasonix"><span class="glyph">◈</span><span class="sidebar-label"> REASONIX</span></div>
        <div class="sidebar-version sidebar-label">dashboard</div>
        <div class="sidebar-mode sidebar-label">${MODE}</div>
      </div>
      <div class="gradient-rule"></div>
      <div class="sidebar-tabs">
        ${TABS.map(
          (tab) => html`
          <div
            class="tab ${tab.id === active.id ? "active" : ""} ${!tab.ready ? "tab-stub" : ""}"
            onClick=${() => tab.ready && pickTab(tab.id)}
            title=${tab.name}
          >
            <span class="glyph">${tab.glyph}</span>
            <span class="sidebar-label">${tab.name}</span>
            ${tab.badge ? html`<span class="badge sidebar-label">${tab.badge}</span>` : null}
          </div>
        `,
        )}
      </div>
      <button
        class="sidebar-collapse-toggle"
        onClick=${() => setSidebarCollapsed((c) => !c)}
        title=${sidebarCollapsed ? "expand sidebar" : "collapse to icons"}
      >${sidebarCollapsed ? "▶" : "◀"}<span class="sidebar-label">  ${sidebarCollapsed ? "expand" : "collapse"}</span></button>
      <div class="sidebar-footer sidebar-label">127.0.0.1 only · token-gated</div>
    </div>
    <div class="sidebar-backdrop" onClick=${() => setSidebarOpen(false)}></div>
    <button class="menu-toggle" onClick=${() => setSidebarOpen((s) => !s)} aria-label="Toggle sidebar">≡</button>
    <div class=${`main ${active.id === "editor" ? "main-editor" : ""}`}>
      <${ErrorBoundary}>${active.panel()}<//>
    </div>
    <div class=${`editor-drawer-host ${editorOpen ? "open" : ""}`}>
      <${ErrorBoundary}>
        <${EditorPanel} onClose=${() => setEditorOpen(false)} />
      <//>
    </div>
    <${ToastStack} />
    <${ErrorOverlay} />
  `;
}

render(html`<${App} />`, document.getElementById("root"));
