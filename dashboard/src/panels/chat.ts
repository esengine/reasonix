import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ChatMessage,
  type ChatMsg,
  CheckpointModal,
  ChoiceModal,
  EditReviewModal,
  type OnResolve,
  PlanModal,
  RevisionModal,
  ShellModal,
  WorkspaceModal,
  parseToolArgs,
} from "../components/chat-internals.js";
import { MODE, TOKEN, api } from "../lib/api.js";
import { appBus, showToast } from "../lib/bus.js";
import { fmtUsd } from "../lib/format.js";
import { html } from "../lib/html.js";

interface StreamingState {
  id: string;
  text: string;
  reasoning: string;
}

interface ActiveToolState {
  id: string;
  toolName?: string;
  args?: string;
}

interface ModalState {
  kind: string;
  [k: string]: unknown;
}

interface ChatStats {
  contextCapTokens: number;
  lastPromptTokens: number;
  lastTurnCostUsd: number;
  totalCostUsd: number;
  cacheHitRatio: number;
  turns: number;
  balance?: { total_balance: string; currency: string }[];
}

interface MessagesResponse {
  messages?: ChatMsg[];
  busy?: boolean;
}

interface ModalEnvelope {
  modal?: ModalState | null;
}

interface SlashCommand {
  cmd: string;
  summary: string;
  argsHint?: string;
  contextual?: "code";
}

type PopoverKind = "slash" | "mention" | null;

interface PopoverItem {
  label: string;
  meta?: string;
  /** Replacement string inserted in place of the trigger token (without leading / or @). */
  insert: string;
}

interface RailPlan {
  id: string;
  title: string;
  totalSteps: number;
  completedSteps: number;
  status: "active" | "done";
  whenMs: number;
}

interface OverviewLite {
  editMode?: string;
  preset?: string;
  reasoningEffort?: string;
  stats?: ChatStats;
  model?: string;
  semanticIndex?: boolean;
  budgetUsd?: number | null;
  cockpit?: { recentPlans?: ReadonlyArray<RailPlan> | null };
}

interface SubmitResponse {
  reply?: ChatMsg;
  error?: string;
}

interface SettingsPatch {
  preset?: string;
  reasoningEffort?: string;
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [activeTool, setActiveTool] = useState<ActiveToolState | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [editMode, setEditModeLocal] = useState<string | null>(null);
  const [preset, setPresetLocal] = useState<string | null>(null);
  const [effort, setEffortLocal] = useState<string | null>(null);
  const [stats, setStats] = useState<ChatStats | null>(null);
  const [overviewModel, setOverviewModel] = useState<string | null>(null);
  const [budgetUsd, setBudgetUsd] = useState<number | null>(null);
  const [activePlan, setActivePlan] = useState<RailPlan | null>(null);
  const [semanticIndex, setSemanticIndex] = useState<boolean | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [popoverKind, setPopoverKind] = useState<PopoverKind>(null);
  const [popoverItems, setPopoverItems] = useState<PopoverItem[]>([]);
  const [popoverSel, setPopoverSel] = useState(0);
  const [semanticBannerDismissed, setSemanticBannerDismissed] = useState<boolean>(() => {
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
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
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
  const shouldAutoScroll = useRef(true);
  const feedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<MessagesResponse>("/messages");
        if (cancelled) return;
        setMessages(data.messages ?? []);
        setBusy(Boolean(data.busy));
      } catch (err) {
        if (!cancelled) setBootError((err as Error).message);
      }
      try {
        const m = await api<ModalEnvelope>("/modal");
        if (!cancelled && m.modal) setModal(m.modal);
      } catch {
        /* skip — modal endpoint optional in standalone */
      }
      try {
        const r = await api<{ commands: SlashCommand[] }>("/slash");
        if (!cancelled) setSlashCommands(r.commands);
      } catch {
        /* skip — popover degrades gracefully */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      const res = await api<{ accepted: boolean; reason?: string }>("/submit", {
        method: "POST",
        body: { prompt: text },
      });
      if (!res.accepted) {
        setError(res.reason ?? "rejected");
        return;
      }
      setInput("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, [input, busy]);

  const abort = useCallback(async () => {
    try {
      await api("/abort", { method: "POST" });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

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
      setTimeout(async () => {
        try {
          const r = await api<MessagesResponse>("/messages");
          setMessages(r.messages ?? []);
        } catch {
          /* swallow */
        }
      }, 200);
    } catch (err) {
      setError(`/new failed: ${(err as Error).message}`);
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
          const r = await api<MessagesResponse>("/messages");
          setMessages(r.messages ?? []);
        } catch {
          /* swallow */
        }
      }, 200);
    } catch (err) {
      setError(`/clear failed: ${(err as Error).message}`);
    }
  }, []);

  const updatePopover = useCallback(
    async (text: string) => {
      const slashMatch = /^\/([A-Za-z0-9_-]*)$/.exec(text);
      if (slashMatch) {
        const prefix = slashMatch[1]!.toLowerCase();
        const items: PopoverItem[] = slashCommands
          .filter((c) => c.cmd.startsWith(prefix))
          .slice(0, 12)
          .map((c) => ({
            label: `/${c.cmd}`,
            meta: c.summary,
            insert: `/${c.cmd}${c.argsHint ? " " : ""}`,
          }));
        setPopoverKind("slash");
        setPopoverItems(items);
        setPopoverSel(0);
        return;
      }
      const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(text);
      if (mentionMatch && MODE === "attached") {
        const prefix = mentionMatch[1] ?? "";
        try {
          const r = await api<{ files: string[] }>("/files", {
            method: "POST",
            body: { prefix },
          });
          const items: PopoverItem[] = r.files.slice(0, 12).map((f) => ({
            label: f,
            insert: `@${f} `,
          }));
          setPopoverKind("mention");
          setPopoverItems(items);
          setPopoverSel(0);
        } catch {
          setPopoverKind(null);
        }
        return;
      }
      setPopoverKind(null);
    },
    [slashCommands],
  );

  const applyPopover = useCallback(() => {
    const item = popoverItems[popoverSel];
    if (!item) return false;
    if (popoverKind === "slash") {
      setInput(item.insert);
    } else if (popoverKind === "mention") {
      const m = /(?:^|\s)@([^\s@]*)$/.exec(input);
      if (!m) return false;
      const start = input.length - m[0].length + (m[0].startsWith(" ") ? 1 : 0);
      setInput(`${input.slice(0, start)}${item.insert}`);
    }
    setPopoverKind(null);
    return true;
  }, [popoverItems, popoverSel, popoverKind, input]);

  const onInput = useCallback(
    (e: Event) => {
      const v = (e.target as HTMLTextAreaElement).value;
      setInput(v);
      updatePopover(v);
    },
    [updatePopover],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (popoverKind && popoverItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setPopoverSel((i) => (i + 1) % popoverItems.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setPopoverSel((i) => (i - 1 + popoverItems.length) % popoverItems.length);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          if (applyPopover() && e.key === "Enter" && popoverKind === "slash") {
            send();
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setPopoverKind(null);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send, popoverKind, popoverItems, applyPopover],
  );

  if (bootError) {
    return html`<div class="notice err">chat unavailable: ${bootError}</div>`;
  }

  /** Suppresses scroll listener during programmatic auto-snap so it doesn't re-arm shouldAutoScroll. */
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

  useEffect(() => {
    if (!shouldAutoScroll.current) return;
    const el = feedRef.current;
    if (!el) return;
    autoScrollInFlight.current = true;
    el.scrollTop = el.scrollHeight;
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

  const resolveModal = useCallback<OnResolve>(async (kind, choice, text) => {
    try {
      await api("/modal/resolve", {
        method: "POST",
        body: text !== undefined ? { kind, choice, text } : { kind, choice },
      });
    } catch (err) {
      setError(`modal resolve failed: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const o = await api<OverviewLite & { semanticIndexExists?: boolean }>("/overview");
        if (cancelled) return;
        setEditModeLocal(o.editMode ?? null);
        setPresetLocal(o.preset ?? null);
        setEffortLocal(o.reasoningEffort ?? null);
        setStats(o.stats ?? null);
        setOverviewModel(o.model ?? null);
        setBudgetUsd(o.budgetUsd ?? null);
        const recent = o.cockpit?.recentPlans ?? [];
        setActivePlan(recent.find((p) => p.status === "active") ?? null);
        setSemanticIndex(o.semanticIndexExists ?? null);
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

  const setEditMode = useCallback(async (next: string) => {
    setEditModeLocal(next);
    try {
      await api("/edit-mode", { method: "POST", body: { mode: next } });
    } catch (err) {
      setError(`mode switch failed: ${(err as Error).message}`);
      try {
        const o = await api<OverviewLite>("/overview");
        setEditModeLocal(o.editMode ?? null);
      } catch {
        /* swallow */
      }
    }
  }, []);

  const setSetting = useCallback(async (key: keyof SettingsPatch, value: string) => {
    if (key === "preset") setPresetLocal(value);
    if (key === "reasoningEffort") setEffortLocal(value);
    try {
      await api("/settings", { method: "POST", body: { [key]: value } });
    } catch (err) {
      setError(`${key} switch failed: ${(err as Error).message}`);
      try {
        const o = await api<OverviewLite>("/overview");
        setPresetLocal(o.preset ?? null);
        setEffortLocal(o.reasoningEffort ?? null);
      } catch {
        /* swallow */
      }
    }
  }, []);

  return html`
    <div class="chat-shell">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <div class="chips" style="padding:0">
          <span class="chip-f active">${MODE === "attached" ? "TUI mirror" : "session view"}</span>
        </div>
        <div class="header-pickers" style="margin-left:auto">
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

      <div class="chat-body">
        <div class="chat-main">
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

          <div class="chat-input-area" style="position:relative">
            ${
              popoverKind && popoverItems.length > 0
                ? html`
                  <div class="popover" style="position:absolute;bottom:calc(100% + 6px);left:0;width:380px;max-height:280px;overflow-y:auto;z-index:10">
                    <div class="popover-h">${popoverKind === "slash" ? "slash commands" : "project files"}</div>
                    ${popoverItems.map(
                      (it, i) => html`
                        <div
                          class=${`popover-row ${i === popoverSel ? "sel" : ""}`}
                          onMouseDown=${(e: Event) => {
                            e.preventDefault();
                            setPopoverSel(i);
                            applyPopover();
                          }}
                        >
                          <span class="g">${popoverKind === "slash" ? "/" : "@"}</span>
                          <span class="name">${it.label}</span>
                          ${it.meta ? html`<span class="meta">${it.meta}</span>` : null}
                        </div>
                      `,
                    )}
                  </div>
                `
                : null
            }
            <textarea
              placeholder=${busy ? "wait for the current turn to finish…" : "Type a prompt — Enter sends, Shift+Enter for a newline · / @ for pickers"}
              value=${input}
              onInput=${onInput}
              onKeyDown=${onKeyDown}
              onBlur=${() => setTimeout(() => setPopoverKind(null), 150)}
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

        <${SideRail} stats=${stats} budgetUsd=${budgetUsd} activePlan=${activePlan} />
      </div>
    </div>
  `;
}

interface SideRailProps {
  stats: ChatStats | null;
  budgetUsd: number | null;
  activePlan: RailPlan | null;
}

function SideRail({ stats, budgetUsd, activePlan }: SideRailProps) {
  if (!stats && !activePlan) return html`<aside class="chat-rail"></aside>`;
  const cachePct = stats ? Math.round(stats.cacheHitRatio * 100) : 0;
  const cacheTone = cachePct >= 80 ? "ok" : cachePct >= 50 ? "" : "warn";
  const showBudget = stats != null && typeof budgetUsd === "number" && budgetUsd > 0;
  const budgetPct = showBudget ? Math.min(120, (stats.totalCostUsd / budgetUsd) * 100) : 0;
  const budgetTone = budgetPct >= 100 ? "err" : budgetPct >= 80 ? "warn" : "";
  return html`
    <aside class="chat-rail">
      ${activePlan ? html`<${ActivePlanCard} plan=${activePlan} />` : null}
      ${
        stats
          ? html`
            <div class="rail-card">
              <div class="rh">Session</div>
              <div class="rail-kv"><span class="k">turns</span><span class="v">${stats.turns.toLocaleString()}</span></div>
              <div class="rail-kv"><span class="k">prompt tok</span><span class="v">${stats.lastPromptTokens.toLocaleString()}</span></div>
              <div class="rail-kv"><span class="k">cost</span><span class="v">${fmtUsd(stats.totalCostUsd)}</span></div>
              <div class="progress-row" style="margin-top:8px">
                <span class="lbl">cache hit</span>
                <div class=${`progress ${cacheTone}`}><div class="progress-fill" style=${`width:${cachePct}%`}></div></div>
                <span class="v">${cachePct}%</span>
              </div>
            </div>
          `
          : null
      }
      ${
        showBudget
          ? html`
            <div class="rail-card">
              <div class="rh">Tool budget</div>
              <div class="progress-row">
                <span class="lbl">spend</span>
                <div class=${`progress ${budgetTone}`}><div class="progress-fill" style=${`width:${Math.min(100, budgetPct)}%`}></div></div>
                <span class="v" style=${budgetTone === "err" ? "color:var(--c-err)" : budgetTone === "warn" ? "color:var(--c-warn)" : ""}>${fmtUsd(stats.totalCostUsd)} / ${fmtUsd(budgetUsd)}</span>
              </div>
            </div>
          `
          : null
      }
    </aside>
  `;
}

function ActivePlanCard({ plan }: { plan: RailPlan }) {
  const dots = [];
  for (let i = 0; i < plan.totalSteps; i++) {
    const done = i < plan.completedSteps;
    const active = i === plan.completedSteps;
    dots.push(
      html`<div class=${`step-dot ${done ? "done" : active ? "active" : ""}`}>${i + 1}</div>`,
    );
    if (i < plan.totalSteps - 1) {
      dots.push(html`<div class=${`step-line ${done ? "done" : active ? "active" : ""}`}></div>`);
    }
  }
  return html`
    <div class="rail-card">
      <div class="rh">Active plan</div>
      <div class="steps" style="margin-bottom:8px">${dots}</div>
      <div class="rail-kv"><span class="k" style="font-family:var(--font-sans);color:var(--fg-1);font-size:12.5px">${plan.title}</span></div>
      <div class="rail-kv"><span class="k">progress</span><span class="v">${plan.completedSteps} / ${plan.totalSteps}</span></div>
    </div>
  `;
}

function summarizeActiveTool(activeTool: ActiveToolState | null): string | null {
  if (!activeTool) return null;
  const name = activeTool.toolName ?? "tool";
  const args = parseToolArgs(activeTool.args) as {
    path?: string;
    file_path?: string;
    filename?: string;
    content?: unknown;
    command?: unknown;
  } | null;
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

interface InFlightRowProps {
  streaming: StreamingState | null;
  activeTool: ActiveToolState | null;
  startedAt: number | null;
  statusLine: string | null;
  onAbort: () => void;
  tick: number;
}

function InFlightRow({
  streaming,
  activeTool,
  startedAt,
  statusLine,
  onAbort,
  tick: _tick,
}: InFlightRowProps) {
  const elapsedMs = startedAt ? Date.now() - startedAt : 0;
  const elapsed = (elapsedMs / 1000).toFixed(1);
  const reasoningLen = streaming?.reasoning?.length ?? 0;
  const textLen = streaming?.text?.length ?? 0;
  /** Tool dispatch wins over text/reasoning — model is blocked on the tool, show that. */
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

interface ChatStatusBarProps {
  stats: ChatStats | null;
  model: string | null;
}

function ChatStatusBar({ stats, model }: ChatStatusBarProps) {
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
