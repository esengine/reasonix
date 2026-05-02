import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { fmtBytes, fmtNum, fmtRelativeTime } from "../lib/format.js";
import { html } from "../lib/html.js";
import { t, useLang } from "../i18n/index.js";

interface SemanticData {
  attached?: boolean;
  reason?: string;
  root?: string;
  index?: IndexInfo;
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

interface IndexInfo {
  exists: boolean;
  chunks?: number;
  files?: number;
  dim?: number;
  sizeBytes?: number;
  lastBuiltMs?: number;
  model?: string;
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
  useLang();
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
        setInfo(rebuild ? t("semantic.rebuildStarted") : t("semantic.incrementalStarted"));
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
      setInfo(t("semantic.stopRequested"));
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
    setInfo(t("semantic.startingDaemon"));
    try {
      const r = await api<{ ready: boolean }>("/semantic/ollama/start", { method: "POST", body: {} });
      setInfo(
        r.ready ? t("semantic.daemonUp") : t("semantic.daemonTimeout"),
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
      setInfo(t("semantic.pullingModel", { model }));
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
    return html`<div class="card" style="color:var(--fg-3)">${t("common.loading")}</div>`;
  if (error && !data) return html`<div class="card accent-err">${error}</div>`;
  if (!data) return null;

  if (!data.attached) {
    return html`
      <div class="card" style="color:var(--fg-3)">
        <div class="card-h"><span class="title">${t("semantic.codeRequired")}</span></div>
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

  const idx = data.index;
  return html`
    <div style="display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:14px;align-items:start">
      <div style="display:flex;flex-direction:column;gap:10px;min-width:0">
        <div class="chips">
          <span class=${`chip-f ${idx?.exists ? "active" : ""}`}>
            ${idx?.exists ? t("semantic.indexBuilt") : t("semantic.noIndex")}
          </span>
          ${
            ready
              ? html`<span class="chip-f" style="border-color:var(--c-ok);color:var(--c-ok)">${t("semantic.ready")}</span>`
              : html`<span class="chip-f" style="border-color:var(--c-warn);color:var(--c-warn)">${t("semantic.setupNeeded")}</span>`
          }
        </div>
        ${info ? html`<div><span class="pill info">${info}</span></div>` : null}
        ${error ? html`<div class="card accent-err">${error}</div>` : null}

        ${idx?.exists ? html`<${SemanticSearchSection} />` : null}

        ${
          !binaryFound
            ? html`
              <div class="card">
                <div class="card-h"><span class="title">${t("semantic.installOllama")}</span></div>
                <div class="card-b" style="font-size:13px">
                  ${t("semantic.installOllamaDesc")}
                  <ul style="margin:10px 0 4px 18px;padding:0">
                    <li><strong>${t("semantic.macWindows")}</strong> ${t("semantic.download")} <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a></li>
                    <li><strong>${t("semantic.linux")}</strong> <code class="mono">curl -fsSL https://ollama.com/install.sh | sh</code></li>
                  </ul>
                  <div style="color:var(--fg-3);margin-top:8px">${t("semantic.refreshHint", { model: modelName })}</div>
                </div>
              </div>
            `
            : null
        }
        ${
          binaryFound && !daemonRunning
            ? html`
              <div class="card">
                <div class="card-h"><span class="title">${t("semantic.daemon")}</span></div>
                <div class="card-b" style="font-size:13px">
                  ${t("semantic.daemonDesc")}
                  <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
                    <button class="primary" disabled=${busy} onClick=${startDaemon}>${t("semantic.startDaemon")}</button>
                    <span style="color:var(--fg-3);font-size:12px">${t("semantic.runsOllama")}</span>
                  </div>
                </div>
              </div>
            `
            : null
        }
        ${
          daemonRunning && !modelPulled
            ? html`
              <div class="card">
                <div class="card-h"><span class="title">${t("semantic.model")}</span></div>
                <div class="card-b" style="font-size:13px">
                  ${t("semantic.modelMissing", { model: modelName })}${pulling ? "" : ` ${t("semantic.modelSize")}`}
                  <div style="display:flex;gap:8px;margin-top:10px">
                    <button class="primary" disabled=${busy || pulling} onClick=${() => pullModel(modelName)}>
                      ${pulling ? t("semantic.pulling") : t("semantic.pullModel", { model: modelName })}
                    </button>
                  </div>
                  ${
                    pull
                      ? html`
                        <div style="margin-top:10px;display:flex;gap:10px;align-items:center;font-size:11.5px">
                          <span class=${`pill ${pull.status === "done" ? "ok" : pull.status === "error" ? "err" : ""}`}>${pull.status}</span>
                          <span style="color:var(--fg-3)">${((Date.now() - pull.startedAt) / 1000).toFixed(1)}s</span>
                          ${pull.lastLine ? html`<code class="mono" style="color:var(--fg-3)">${pull.lastLine}</code>` : null}
                        </div>
                      `
                      : null
                  }
                </div>
              </div>
            `
            : null
        }

        ${
          job
            ? html`
              ${sectionH3(t("semantic.job"))}
              <${SemanticJobView} job=${job} running=${running} />
            `
            : null
        }
      </div>

      <aside style="display:flex;flex-direction:column;gap:10px">
        <div class="card">
          <div class="card-h">
            <span class="title">${t("semantic.indexStatus")}</span>
            <span class="meta">
              ${
                idx?.exists
                  ? html`<span class="pill ok">${t("semantic.builtStatus")}</span>`
                  : html`<span class="pill">${t("system.none")}</span>`
              }
            </span>
          </div>
          ${
            idx?.exists
              ? html`
                <div class="rail-kv"><span class="k">${t("semantic.chunks")}</span><span class="v">${fmtNum(idx.chunks)}</span></div>
                <div class="rail-kv"><span class="k">${t("semantic.files")}</span><span class="v">${fmtNum(idx.files)}</span></div>
                <div class="rail-kv"><span class="k">${t("semantic.model")}</span><span class="v" style="font-size:11px">${idx.model ?? modelName}</span></div>
                <div class="rail-kv"><span class="k">${t("semantic.dim")}</span><span class="v">${fmtNum(idx.dim)}</span></div>
                <div class="rail-kv"><span class="k">${t("semantic.size")}</span><span class="v">${fmtBytes(idx.sizeBytes)}</span></div>
                <div class="rail-kv"><span class="k">${t("semantic.lastBuild")}</span><span class="v">${fmtRelativeTime(idx.lastBuiltMs ?? null)}</span></div>
              `
              : html`
                <div style="color:var(--fg-3);font-size:12.5px;padding:6px 0">
                  ${t("semantic.runIndexHint")}
                </div>
              `
          }
          <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
            <button class="primary" disabled=${busy || running || !ready} onClick=${() => start(false)}>${idx?.exists ? t("semantic.reIndex") : t("semantic.build")}</button>
            ${
              idx?.exists
                ? html`<button disabled=${busy || running || !ready} onClick=${() => start(true)}>${t("semantic.rebuild")}</button>`
                : null
            }
            ${running ? html`<button onClick=${stop} style="border-color:var(--c-err);color:var(--c-err)">${t("semantic.stop")}</button>` : null}
          </div>
        </div>

        <div class="card">
          <div class="card-h"><span class="title">${t("semantic.ollama")}</span></div>
          <div class="rail-kv">
            <span class="k">${t("semantic.binary")}</span>
            <span class="v">${binaryFound ? html`<span class="pill ok">${t("semantic.found")}</span>` : html`<span class="pill err">${t("semantic.missing")}</span>`}</span>
          </div>
          <div class="rail-kv">
            <span class="k">${t("semantic.daemonStatus")}</span>
            <span class="v">${daemonRunning ? html`<span class="pill ok">${t("semantic.up")}</span>` : html`<span class="pill warn">${t("semantic.down")}</span>`}</span>
          </div>
          <div class="rail-kv">
            <span class="k">${t("semantic.model")}</span>
            <span class="v">${modelPulled ? html`<span class="pill ok">${t("semantic.pulled")}</span>` : html`<span class="pill warn">${t("semantic.missing")}</span>`}</span>
          </div>
        </div>

        <${SemanticExcludesCard} />
      </aside>
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
  excludeDirs: string[];
  excludeFiles: string[];
  excludeExts: string[];
  excludePatterns: string[];
  respectGitignore: boolean;
  maxFileBytes: number;
}

interface PreviewData {
  filesIncluded: number;
  skipBuckets?: Record<string, number>;
  skipSamples?: Record<string, string[]>;
  sampleIncluded?: string[];
}

interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

interface SearchResponse {
  hits: SearchHit[];
  elapsedMs: number;
  model: string;
}

function SemanticSearchSection() {
  useLang();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [meta, setMeta] = useState<{ elapsedMs: number; model: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<SearchResponse>("/semantic/search", {
        method: "POST",
        body: { query: q, topK: 8, minScore: 0.3 },
      });
      setHits(r.hits);
      setMeta({ elapsedMs: r.elapsedMs, model: r.model });
    } catch (err) {
      setError((err as Error).message);
      setHits(null);
    } finally {
      setBusy(false);
    }
  }, [query, busy]);

  return html`
    <div style="margin-bottom:14px">
      <div style="position:relative">
        <div style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--c-brand);font-family:var(--font-mono);font-size:14px;pointer-events:none">≈</div>
        <input
          type="text"
          class="mono"
          style="width:100%;padding:10px 14px 10px 38px;font-size:13.5px;background:var(--bg-input);border:1px solid var(--bd);border-radius:var(--r);color:var(--fg-0);outline:none"
          placeholder=${t("semantic.searchPlaceholder")}
          value=${query}
          disabled=${busy}
          onInput=${(e: Event) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runSearch();
            }
          }}
        />
      </div>
      ${
        hits || busy || error
          ? html`
            <div style="font-family:var(--font-mono);font-size:11px;color:var(--fg-3);margin:8px 0 6px;display:flex;align-items:center;gap:8px">
              ${busy
                ? html`<span>${t("semantic.searching")}</span>`
                : error
                ? html`<span style="color:var(--c-err)">${error}</span>`
                : hits
                ? html`<span>${t("semantic.results", { count: hits.length, s: hits.length === 1 ? "" : "s", ms: meta?.elapsedMs ?? 0, model: meta?.model ?? "" })}</span>`
                : null}
            </div>
            ${
              hits && hits.length > 0
                ? html`
                  <div class="card" style="padding:0;max-height:420px;overflow-y:auto">
                    ${hits.map(
                      (h) => html`
                        <div class="sr-card">
                          <div class="sr-h">
                            <span class="sr-path">${h.path}</span>
                            <span class="sr-loc">L${h.startLine} – L${h.endLine}</span>
                            <span class="sr-score">${h.score.toFixed(3)}</span>
                          </div>
                          <div class="sr-snip">${truncateSnippet(h.snippet)}</div>
                        </div>
                      `,
                    )}
                  </div>
                `
                : hits && hits.length === 0 && !busy
                ? html`<div class="card" style="color:var(--fg-3);font-size:12px">${t("semantic.noMatches")}</div>`
                : null
            }
          `
          : null
      }
    </div>
  `;
}

function truncateSnippet(text: string, maxLines = 8): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n  …(${lines.length - maxLines} more lines)`;
}

function toDraft(c: IndexConfig): ExcludeDraft {
  return {
    excludeDirs: c.excludeDirs ?? [],
    excludeFiles: c.excludeFiles ?? [],
    excludeExts: c.excludeExts ?? [],
    excludePatterns: c.excludePatterns ?? [],
    respectGitignore: c.respectGitignore !== false,
    maxFileBytes: c.maxFileBytes ?? 262144,
  };
}

function fromDraft(d: ExcludeDraft): IndexConfig {
  return {
    excludeDirs: d.excludeDirs,
    excludeFiles: d.excludeFiles,
    excludeExts: d.excludeExts,
    excludePatterns: d.excludePatterns,
    respectGitignore: !!d.respectGitignore,
    maxFileBytes: d.maxFileBytes,
  };
}

function SemanticExcludesCard() {
  useLang();
  const [data, setData] = useState<IndexConfigResponse | null>(null);
  const [draft, setDraft] = useState<ExcludeDraft | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

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
    load();
  }, [load]);

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
      const r = await api<{ changed: string[] }>("/index-config", {
        method: "POST",
        body: payload,
      });
      setInfo(t("semantic.savedConfig", { count: r.changed.length || 0 }));
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
    setInfo(t("semantic.runningPreview"));
    try {
      const payload = fromDraft(draft);
      const r = await api<PreviewData>("/index-config/preview", {
        method: "POST",
        body: payload,
      });
      setPreview(r);
      setInfo(null);
    } catch (err) {
      setError((err as Error).message);
      setInfo(null);
    } finally {
      setBusy(false);
    }
  }, [draft]);

  if (!draft) {
    return html`
      <div class="card">
        <div class="card-h"><span class="title">${t("semantic.indexConfig")}</span></div>
        <div style="color:var(--fg-3);font-size:12.5px">${t("common.loading")}</div>
      </div>
    `;
  }

  return html`
    <div class="card">
      <div class="card-h">
        <span class="title">${t("semantic.indexConfig")}</span>
        <span class="meta">
          <a
            class="mono"
            style="color:var(--c-brand);text-decoration:none;font-size:11px;cursor:pointer"
            onClick=${reset}
          >${t("semantic.reset")}</a>
        </span>
      </div>
      ${info ? html`<div style="margin-bottom:8px"><span class="pill ok">${info}</span></div>` : null}
      ${error ? html`<div class="card accent-err" style="margin-bottom:8px">${error}</div>` : null}

      <${ChipFormRow}
        label=${t("semantic.excludeDirs")}
        value=${draft.excludeDirs}
        onChange=${(v: string[]) => setDraft({ ...draft, excludeDirs: v })}
        placeholder="dist"
      />
      <${ChipFormRow}
        label=${t("semantic.excludeFiles")}
        value=${draft.excludeFiles}
        onChange=${(v: string[]) => setDraft({ ...draft, excludeFiles: v })}
        placeholder="package-lock.json"
      />
      <${ChipFormRow}
        label=${t("semantic.excludeExts")}
        value=${draft.excludeExts}
        onChange=${(v: string[]) => setDraft({ ...draft, excludeExts: v })}
        placeholder=".lock"
      />
      <${ChipFormRow}
        label=${t("semantic.excludePatterns")}
        sub=${t("semantic.glob")}
        value=${draft.excludePatterns}
        onChange=${(v: string[]) => setDraft({ ...draft, excludePatterns: v })}
        placeholder="**/*.test.ts"
      />

      <div
        class="checkbox-row"
        style="margin-top:8px;cursor:pointer"
        onClick=${() => setDraft({ ...draft, respectGitignore: !draft.respectGitignore })}
      >
        <span class=${`box ${draft.respectGitignore ? "on" : ""}`}>${draft.respectGitignore ? "✓" : ""}</span>
        <span>${t("semantic.respectGitignore")}</span>
      </div>

      <div class="form-row" style="margin-top:10px">
        <span class="lbl">${t("semantic.maxFileBytes")}</span>
        <input
          class="input mono"
          type="number"
          min="1024"
          step="1024"
          value=${draft.maxFileBytes}
          onInput=${(e: Event) =>
            setDraft({ ...draft, maxFileBytes: Number((e.target as HTMLInputElement).value) || 0 })}
          style="font-size:12px"
        />
        <span class="help">${t("semantic.skipLarger", { size: (draft.maxFileBytes / 1024 / 1024).toFixed(1) })}</span>
      </div>

      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="btn ghost" style="flex:1" disabled=${busy} onClick=${runPreview}>
          <span class="g">⊕</span><span>${t("semantic.preview")}</span>
        </button>
        <button class="btn primary" style="flex:1" disabled=${busy} onClick=${save}>${t("common.save")}</button>
      </div>

      ${preview ? html`<div style="margin-top:10px"><${ExcludesPreview} preview=${preview} /></div>` : null}
    </div>
  `;
}

function ExcludesPreview({ preview }: { preview: PreviewData }) {
  useLang();
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
        ${t("semantic.previewSummary", { included: preview.filesIncluded, skipped: totalSkipped })}
      </div>
      ${
        reasons.length === 0
          ? html`<div style="color:var(--fg-3)">${t("semantic.nothingSkipped")}</div>`
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
              <summary>${t("semantic.firstIncluded", { count: preview.sampleIncluded.length })}</summary>
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

function ChipFormRow({
  label,
  sub,
  value,
  onChange,
  placeholder = "+ add",
}: {
  label: string;
  sub?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [adding, setAdding] = useState("");
  const remove = (entry: string) => onChange(value.filter((v) => v !== entry));
  const commit = () => {
    const trimmed = adding.trim();
    if (!trimmed || value.includes(trimmed)) {
      setAdding("");
      return;
    }
    onChange([...value, trimmed]);
    setAdding("");
  };
  return html`
    <div class="form-row">
      <span class="lbl">
        ${label}
        ${sub ? html`<span style="color:var(--fg-3);font-weight:400;text-transform:none;letter-spacing:0"> · ${sub}</span>` : null}
      </span>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${value.map(
          (e) => html`
            <span class="chip-f">
              <span>${e}</span>
              <span class="x" style="cursor:pointer" onClick=${() => remove(e)} title="remove">×</span>
            </span>
          `,
        )}
        <input
          type="text"
          class="chip-add-input"
          value=${adding}
          placeholder=${placeholder}
          onInput=${(ev: Event) => setAdding((ev.target as HTMLInputElement).value)}
          onKeyDown=${(ev: KeyboardEvent) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              commit();
            }
          }}
          onBlur=${commit}
        />
      </div>
    </div>
  `;
}

function SemanticJobView({ job, running }: { job: SemanticJob; running: boolean }) {
  useLang();
  const phaseLabel =
    ({
      scan: t("semantic.phaseScan"),
      embed: t("semantic.phaseEmbed"),
      write: t("semantic.phaseWrite"),
      done: t("semantic.phaseDone"),
      error: t("semantic.phaseError"),
    } as Record<string, string>)[job.phase] ?? job.phase;
  const total = job.chunksTotal ?? 0;
  const doneN = job.chunksDone ?? 0;
  const ratio = total > 0 ? Math.min(1, doneN / total) : 0;
  const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);

  return html`
    <div class="kv">
      <div><span class="kv-key">phase</span>
        <span class=${`pill ${job.phase === "error" ? "pill-err" : running ? "pill-active" : "pill-dim"}`}>${phaseLabel}</span>
        ${job.aborted ? html`<span class="pill warn" style="margin-left: 6px;">${t("semantic.stopping")}</span>` : null}
        <span style="color:var(--fg-3);margin-left:8px">${elapsed}s</span>
      </div>
      ${
        job.filesScanned !== null && job.filesScanned !== undefined
          ? html`<div><span class="kv-key">${t("semantic.files")}</span>${t("semantic.scanned", { count: job.filesScanned })}${
              job.filesChanged != null ? ` · ${t("semantic.changed", { count: job.filesChanged })}` : ""
            }${job.filesSkipped ? ` · ${t("semantic.skipped", { count: job.filesSkipped })}` : ""}</div>`
          : null
      }
      ${
        total > 0
          ? html`
            <div>
              <span class="kv-key">${t("semantic.chunks")}</span>${t("semantic.chunksProgress", { done: doneN, total, pct: (ratio * 100).toFixed(0) })}
            </div>
            <div class="bar" style="margin-top: 4px;">
              <div class="fill" style=${`width: ${(ratio * 100).toFixed(1)}%; background: var(--primary);`}></div>
            </div>
          `
          : null
      }
      ${
        job.error
          ? html`<div><span class="kv-key">${t("semantic.phaseError")}</span><span class="err">${job.error}</span></div>`
          : null
      }
      ${
        job.result
          ? html`<div><span class="kv-key">${t("semantic.result")}</span>${t("semantic.added", { count: job.result.chunksAdded })} · ${t("semantic.removed", { count: job.result.chunksRemoved })}${
              job.result.chunksSkipped ? ` · ${t("semantic.failed", { count: job.result.chunksSkipped })}` : ""
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
  useLang();
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
  return html`<div><span class="kv-key">${t("semantic.skipped")}</span>${t("semantic.skippedFiles", { total, details: parts.join(", ") })}</div>`;
}
