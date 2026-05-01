import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { html } from "../lib/html.js";

interface SemanticData {
  attached?: boolean;
  reason?: string;
  root?: string;
  index?: { exists: boolean };
  job?: SemanticJob | null;
  pull?: { status: string; startedAt: number; lastLine?: string } | null;
  ollama?: {
    binaryFound?: boolean;
    daemonRunning?: boolean;
    modelPulled?: boolean;
    modelName?: string;
    installedModels?: string[];
    error?: string;
  };
}

interface SemanticJob {
  phase: string;
  startedAt: number;
  chunksTotal?: number;
  chunksDone?: number;
  filesScanned?: number;
  filesChanged?: number;
  filesSkipped?: number;
  aborted?: boolean;
  error?: string;
  result?: {
    chunksAdded: number;
    chunksRemoved: number;
    chunksSkipped?: number;
    durationMs: number;
    skipBuckets?: Record<string, number>;
  };
}

export function SemanticPanel() {
  const [data, setData] = useState<SemanticData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<SemanticData>("/semantic");
      setData(r);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

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
    async (rebuild: boolean) => {
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        await api("/semantic/start", { method: "POST", body: { rebuild: !!rebuild } });
        setInfo(rebuild ? "rebuild started" : "incremental index started");
        await load();
      } catch (err) {
        setError((err as Error).message);
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
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const startDaemon = useCallback(async () => {
    setBusy(true);
    setError(null);
    setInfo("starting ollama daemon (15s timeout)…");
    try {
      const r = await api<{ ready: boolean }>("/semantic/ollama/start", { method: "POST", body: {} });
      setInfo(
        r.ready ? "daemon is up" : "daemon didn't come up in time — check `ollama serve` manually",
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const pullModel = useCallback(
    async (model: string) => {
      setBusy(true);
      setError(null);
      setInfo(`pulling ${model} — this may take a few minutes on first install`);
      try {
        await api("/semantic/ollama/pull", { method: "POST", body: { model } });
        await load();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!data && !error)
    return html`<div class="card" style="color:var(--fg-3)">loading semantic status…</div>`;
  if (error && !data) return html`<div class="card accent-err">${error}</div>`;
  if (!data) return null;

  if (!data.attached) {
    return html`
      <div class="card" style="color:var(--fg-3)">
        <div class="card-h"><span class="title">Semantic — code-mode required</span></div>
        <div class="card-b">${data.reason}</div>
      </div>
    `;
  }

  const job = data.job;
  const phase = job?.phase;
  const running = phase === "scan" || phase === "embed" || phase === "write";
  const pull = data.pull;
  const pulling = pull?.status === "pulling";

  const o = data.ollama ?? {};
  const binaryFound = o.binaryFound === true;
  const daemonRunning = o.daemonRunning === true;
  const modelPulled = o.modelPulled === true;
  const modelName = o.modelName ?? "nomic-embed-text";
  const installedModels = o.installedModels ?? [];
  const ready = binaryFound && daemonRunning && modelPulled;

  const sectionH3 = (text: string) => html`
    <h3 style="margin:18px 0 8px;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.1em">${text}</h3>
  `;

  return html`
    <div style="display:flex;flex-direction:column;gap:6px">
      <div class="chips">
        <span class=${`chip-f ${data.index?.exists ? "active" : ""}`}>
          ${data.index?.exists ? "index built" : "no index yet"}
        </span>
        ${
          ready
            ? html`<span class="chip-f" style="border-color:var(--c-ok);color:var(--c-ok)">ready</span>`
            : html`<span class="chip-f" style="border-color:var(--c-warn);color:var(--c-warn)">setup needed</span>`
        }
      </div>
      ${info ? html`<div><span class="pill info">${info}</span></div>` : null}
      ${error ? html`<div class="card accent-err">${error}</div>` : null}

      ${sectionH3("Status")}
      <div class="kv">
        <div><span class="kv-key">project</span><code>${data.root}</code></div>
        <div>
          <span class="kv-key">ollama</span>
          ${
            binaryFound
              ? daemonRunning
                ? html`<span class="pill ok">reachable</span><span style="color:var(--fg-3);margin-left:8px">${installedModels.length} model(s)${
                    installedModels.length > 0
                      ? ` · ${installedModels.slice(0, 3).join(", ")}${installedModels.length > 3 ? "…" : ""}`
                      : ""
                  }</span>`
                : html`<span class="pill warn">daemon down</span><span style="color:var(--fg-3);margin-left:8px">binary on PATH but not serving</span>`
              : html`<span class="pill err">not installed</span><span style="color:var(--fg-3);margin-left:8px">${o.error ?? "ollama binary not on PATH"}</span>`
          }
        </div>
        <div>
          <span class="kv-key">model</span>
          <code>${modelName}</code>
          ${
            modelPulled
              ? html`<span class="pill ok" style="margin-left: 8px;">pulled</span>`
              : daemonRunning
                ? html`<span class="pill warn" style="margin-left: 8px;">not pulled</span>`
                : html`<span class="pill" style="margin-left: 8px;">unknown (daemon down)</span>`
          }
        </div>
        <div>
          <span class="kv-key">index</span>
          ${
            data.index?.exists
              ? html`<span style="color:var(--fg-3)">present at <code>.reasonix/semantic/</code></span>`
              : html`<span style="color:var(--fg-3)">none — run an index to enable <code>semantic_search</code></span>`
          }
        </div>
      </div>

      ${
        !binaryFound
          ? html`
            ${sectionH3("Install Ollama")}
            <div class="card" style="font-size: 13px;">
              Reasonix doesn't run package managers for you. Install Ollama
              first, then come back to this panel:
              <ul style="margin: 10px 0 4px 18px; padding: 0;">
                <li><strong>macOS / Windows:</strong> download from <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a></li>
                <li><strong>Linux:</strong> <code>curl -fsSL https://ollama.com/install.sh | sh</code></li>
              </ul>
              <div style="color:var(--fg-3);margin-top:8px">After install, this panel will offer to start the daemon and pull <code>${modelName}</code> for you. Refresh after installing.</div>
            </div>
          `
          : null
      }

      ${
        binaryFound && !daemonRunning
          ? html`
            ${sectionH3("Daemon")}
            <div class="card" style="font-size: 13px;">
              <code>ollama</code> is on your PATH but the HTTP daemon isn't reachable.
              <div class="row" style="margin-top: 10px;">
                <button class="primary" disabled=${busy} onClick=${startDaemon}>Start daemon</button>
                <span style="color:var(--fg-3);font-size:12px;align-self:center">runs <code>ollama serve</code> detached — survives Reasonix exit</span>
              </div>
            </div>
          `
          : null
      }

      ${
        daemonRunning && !modelPulled
          ? html`
            ${sectionH3("Model")}
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
                        <span style="color:var(--fg-3);margin-left:8px">${((Date.now() - pull.startedAt) / 1000).toFixed(1)}s</span>
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

      ${sectionH3("Job")}
      ${job ? html`<${SemanticJobView} job=${job} running=${running} />` : html`<div style="color:var(--fg-3)">No job has run in this dashboard yet.</div>`}

      <div class="row" style="margin-top: 14px;">
        <button class="primary" disabled=${busy || running || !ready} onClick=${() => start(false)}>Index (incremental)</button>
        <button disabled=${busy || running || !ready} onClick=${() => start(true)}>Rebuild (wipe + full)</button>
        <button disabled=${busy || !running} onClick=${stop}>Stop</button>
      </div>

      <${SemanticExcludesCard} />
    </div>
  `;
}

interface IndexConfig {
  excludeDirs?: string[];
  excludeFiles?: string[];
  excludeExts?: string[];
  excludePatterns?: string[];
  respectGitignore?: boolean;
  maxFileBytes?: number;
}

interface IndexConfigResponse {
  resolved: IndexConfig;
  defaults: IndexConfig;
}

interface ExcludeDraft {
  excludeDirs: string;
  excludeFiles: string;
  excludeExts: string;
  excludePatterns: string;
  respectGitignore: boolean;
  maxFileBytes: number;
}

interface PreviewData {
  filesIncluded: number;
  skipBuckets?: Record<string, number>;
  skipSamples?: Record<string, string[]>;
  sampleIncluded?: string[];
}

function toDraft(c: IndexConfig): ExcludeDraft {
  return {
    excludeDirs: (c.excludeDirs ?? []).join("\n"),
    excludeFiles: (c.excludeFiles ?? []).join("\n"),
    excludeExts: (c.excludeExts ?? []).join("\n"),
    excludePatterns: (c.excludePatterns ?? []).join("\n"),
    respectGitignore: c.respectGitignore !== false,
    maxFileBytes: c.maxFileBytes ?? 262144,
  };
}

function fromDraft(d: ExcludeDraft): IndexConfig {
  const lines = (s: string) =>
    s.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 0);
  return {
    excludeDirs: lines(d.excludeDirs),
    excludeFiles: lines(d.excludeFiles),
    excludeExts: lines(d.excludeExts),
    excludePatterns: lines(d.excludePatterns),
    respectGitignore: !!d.respectGitignore,
    maxFileBytes: d.maxFileBytes,
  };
}

function SemanticExcludesCard() {
  const [data, setData] = useState<IndexConfigResponse | null>(null);
  const [draft, setDraft] = useState<ExcludeDraft | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<IndexConfigResponse>("/index-config");
      setData(r);
      setDraft(toDraft(r.resolved));
    } catch (err) {
      setError((err as Error).message);
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
      const r = await api<{ changed: string[] }>("/index-config", { method: "POST", body: payload });
      setInfo(`saved · ${r.changed.length || 0} fields updated · re-run index to apply`);
      await load();
    } catch (err) {
      setError((err as Error).message);
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
      const r = await api<PreviewData>("/index-config/preview", { method: "POST", body: payload });
      setPreview(r);
      setInfo(null);
    } catch (err) {
      setError((err as Error).message);
      setInfo(null);
    } finally {
      setBusy(false);
    }
  }, [draft]);

  return html`
    <div class="excludes-toggle" onClick=${() => setOpen(!open)}>
      <span class="caret">${open ? "▼" : "▶"}</span>
      <span class="label">Excludes</span>
      <span class="hint">config-driven skip rules applied during indexing</span>
    </div>
    ${
      !open
        ? null
        : !draft
          ? html`<div class="empty">loading…</div>`
          : html`
            <div class="card excludes-card">
              ${info ? html`<div class="notice">${info}</div>` : null}
              ${error ? html`<div class="notice err">${error}</div>` : null}
              <div class="lead">
                One value per line. Dirs / files match by basename. Patterns use picomatch syntax (e.g. <code>**/*.generated.ts</code>, <code>vendor/**</code>, <code>!keep-me</code>).
              </div>
              <div class="excludes-grid">
                <${ExcludesField} label="Exclude dirs" value=${draft.excludeDirs} onChange=${(v: string) => setDraft({ ...draft, excludeDirs: v })} />
                <${ExcludesField} label="Exclude files" value=${draft.excludeFiles} onChange=${(v: string) => setDraft({ ...draft, excludeFiles: v })} />
                <${ExcludesField} label="Exclude extensions" value=${draft.excludeExts} onChange=${(v: string) => setDraft({ ...draft, excludeExts: v })} />
                <${ExcludesField} label="Exclude patterns (glob)" value=${draft.excludePatterns} onChange=${(v: string) => setDraft({ ...draft, excludePatterns: v })} />
              </div>
              <div class="excludes-options">
                <label>
                  <input type="checkbox" checked=${draft.respectGitignore} onChange=${(e: Event) => setDraft({ ...draft, respectGitignore: (e.target as HTMLInputElement).checked })} />
                  Respect <code>.gitignore</code>
                </label>
                <label>
                  Max file size
                  <input type="number" min="1024" step="1024" value=${draft.maxFileBytes} onChange=${(e: Event) => setDraft({ ...draft, maxFileBytes: Number((e.target as HTMLInputElement).value) || 0 })} />
                  <span style="color:var(--fg-3)">bytes</span>
                </label>
              </div>
              <div class="excludes-actions">
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

function ExcludesPreview({ preview }: { preview: PreviewData }) {
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
    <div class="excludes-preview">
      <div class="summary">
        Preview — would index <strong>${preview.filesIncluded}</strong> file(s), skip <strong>${totalSkipped}</strong>
      </div>
      ${
        reasons.length === 0
          ? html`<div style="color:var(--fg-3)">nothing skipped — all walked files would be indexed.</div>`
          : reasons.map(
              (r) => html`
                <details>
                  <summary><strong>${r}: ${buckets[r]}</strong></summary>
                  <ul>
                    ${(samples[r] || []).map((p) => html`<li><code>${p}</code></li>`)}
                    ${
                      (buckets[r] || 0) > (samples[r] || []).length
                        ? html`<li style="color:var(--fg-3)">…${(buckets[r] || 0) - (samples[r] || []).length} more</li>`
                        : null
                    }
                  </ul>
                </details>
              `,
            )
      }
      ${
        preview.sampleIncluded?.length
          ? html`
            <details>
              <summary>first ${preview.sampleIncluded.length} included file(s)</summary>
              <ul>
                ${preview.sampleIncluded.map((p) => html`<li><code>${p}</code></li>`)}
              </ul>
            </details>
          `
          : null
      }
    </div>
  `;
}

function ExcludesField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return html`
    <div class="excludes-field">
      <label>${label}</label>
      <textarea rows="5" value=${value} onChange=${(e: Event) => onChange((e.target as HTMLTextAreaElement).value)}></textarea>
    </div>
  `;
}

function SemanticJobView({ job, running }: { job: SemanticJob; running: boolean }) {
  const phaseLabel =
    ({
      scan: "scanning files",
      embed: "embedding chunks",
      write: "writing index",
      done: "done",
      error: "error",
    } as Record<string, string>)[job.phase] ?? job.phase;
  const total = job.chunksTotal ?? 0;
  const doneN = job.chunksDone ?? 0;
  const ratio = total > 0 ? Math.min(1, doneN / total) : 0;
  const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);

  return html`
    <div class="kv">
      <div><span class="kv-key">phase</span>
        <span class=${`pill ${job.phase === "error" ? "pill-err" : running ? "pill-active" : "pill-dim"}`}>${phaseLabel}</span>
        ${job.aborted ? html`<span class="pill warn" style="margin-left: 6px;">stopping</span>` : null}
        <span style="color:var(--fg-3);margin-left:8px">${elapsed}s</span>
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

function SkipBucketsView({ buckets }: { buckets: Record<string, number> }) {
  const order: [string, string][] = [
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
  return html`<div><span class="kv-key">skipped</span>${total} files <span style="color:var(--fg-3)">(${parts.join(", ")})</span></div>`;
}
