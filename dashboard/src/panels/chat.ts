// @ts-nocheck — bulk JS-style migration; tighten types in a follow-up.
import { useCallback, useEffect, useRef, useState } from "https://esm.sh/preact@10.22.0/hooks";
import {
  ChatMessage,
  CheckpointModal,
  ChoiceModal,
  EditReviewModal,
  PlanModal,
  RevisionModal,
  ShellModal,
  WorkspaceModal,
} from "../components/chat-internals.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/bus.js";
import { fmtUsd } from "../lib/format.js";
import { html } from "../lib/html.js";

export function ChatPanel() {
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


