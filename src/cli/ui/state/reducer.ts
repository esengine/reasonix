import type {
  Card,
  CardId,
  LiveCard,
  ReasoningCard,
  StreamingCard,
  ToolCard,
  UserCard,
} from "./cards.js";
import type { AgentEvent } from "./events.js";
import type { AgentState, Toast } from "./state.js";

export function reduce(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "user.submit":
      return appendCard(state, makeUserCard(event.text));

    case "turn.start":
      return { ...state, turnInProgress: true };

    case "turn.thinking":
      return appendCard(
        state,
        makeLiveCard("thinking", `thinking · ${state.session.model}`, "brand"),
      );

    case "reasoning.start":
      return appendCard(state, makeReasoningCard(event.id, state.session.model));

    case "reasoning.chunk":
      return mutateCard(state, event.id, "reasoning", (c) => ({ ...c, text: c.text + event.text }));

    case "reasoning.end":
      return mutateCard(state, event.id, "reasoning", (c) => ({
        ...c,
        paragraphs: event.paragraphs,
        tokens: event.tokens,
        streaming: false,
        endedAt: Date.now(),
        ...(event.aborted ? { aborted: true } : {}),
      }));

    case "streaming.start":
      return appendCard(state, makeStreamingCard(event.id, state.session.model));

    case "streaming.chunk":
      return mutateCard(state, event.id, "streaming", (c) => ({ ...c, text: c.text + event.text }));

    case "streaming.end":
      return mutateCard(state, event.id, "streaming", (c) => ({
        ...c,
        done: true,
        endedAt: Date.now(),
        ...(event.aborted ? { aborted: true } : {}),
      }));

    case "tool.start":
      return appendCard(state, makeToolCard(event.id, event.name, event.args));

    case "tool.chunk":
      return mutateCard(state, event.id, "tool", (c) => ({ ...c, output: c.output + event.text }));

    case "tool.end":
      return mutateCard(state, event.id, "tool", (c) => ({
        ...c,
        done: true,
        output: event.output ?? c.output,
        exitCode: event.exitCode,
        elapsedMs: event.elapsedMs,
        ...(event.aborted ? { aborted: true } : {}),
      }));

    case "tool.retry":
      return mutateCard(state, event.id, "tool", (c) => ({
        ...c,
        retry: { attempt: event.attempt, max: event.max },
      }));

    case "turn.abort":
      return {
        ...state,
        turnInProgress: false,
        composer: { ...state.composer, abortedHint: true },
      };

    case "turn.end": {
      const sessionCost = state.status.sessionCost + event.usage.cost;
      return {
        ...state,
        turnInProgress: false,
        status: {
          ...state.status,
          cost: event.usage.cost,
          sessionCost,
          cacheHit: event.usage.cacheHit,
        },
      };
    }

    case "mode.change":
      return { ...state, status: { ...state.status, mode: event.mode } };

    case "network.change":
      return {
        ...state,
        status: { ...state.status, network: event.state, networkDetail: event.detail },
      };

    case "session.update":
      return { ...state, status: { ...state.status, ...event.patch } };

    case "focus.move":
      return {
        ...state,
        focusedCardId: moveFocus(state.cards, state.focusedCardId, event.direction),
      };

    case "focus.set":
      return { ...state, focusedCardId: event.cardId };

    case "card.toggle":
      return state;

    case "composer.input":
      return {
        ...state,
        composer: {
          ...state.composer,
          value: event.value,
          cursor: event.value.length,
          abortedHint: false,
        },
      };

    case "composer.cursor":
      return { ...state, composer: { ...state.composer, cursor: event.index } };

    case "composer.history":
      return state;

    case "picker.open":
      return { ...state, composer: { ...state.composer, picker: event.kind } };

    case "picker.close":
      return { ...state, composer: { ...state.composer, picker: null } };

    case "toast.show":
      return { ...state, toasts: [...state.toasts, makeToast(event)] };

    case "toast.hide":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== event.id) };

    case "live.show":
      return appendCard(state, {
        kind: "live",
        id: event.id,
        ts: event.ts,
        variant: event.variant,
        tone: event.tone,
        text: event.text,
        meta: event.meta,
      });

    case "session.reset":
      return { ...state, cards: [], focusedCardId: null, toasts: [] };

    case "plan.show":
      return appendCard(state, {
        kind: "plan",
        id: event.id,
        ts: Date.now(),
        title: event.title,
        steps: event.steps,
        variant: event.variant,
      });

    case "plan.drop": {
      // Latest still-active plan flips to "replay" — preserves it in scrollback
      // but signals "no longer the live plan" to selectors and UI.
      let dropped = false;
      const cards = state.cards.map((c, i) => {
        if (dropped) return c;
        if (c.kind !== "plan" || c.variant !== "active") return c;
        // Walk from end — only the LAST active plan should drop.
        if (state.cards.slice(i + 1).some((cc) => cc.kind === "plan" && cc.variant === "active")) {
          return c;
        }
        dropped = true;
        return { ...c, variant: "replay" as const };
      });
      return dropped ? { ...state, cards } : state;
    }

    case "plan.step.complete": {
      let changed = false;
      const cards = state.cards.map((c) => {
        if (c.kind !== "plan") return c;
        let stepChanged = false;
        const next = c.steps.map((s) => {
          if (s.id !== event.stepId || s.status === "done") return s;
          stepChanged = true;
          return { ...s, status: "done" as const };
        });
        if (!stepChanged) return c;
        changed = true;
        return { ...c, steps: next };
      });
      return changed ? { ...state, cards } : state;
    }

    case "ctx.show":
      return appendCard(state, {
        kind: "ctx",
        id: event.id,
        ts: Date.now(),
        text: event.text,
        systemTokens: event.systemTokens,
        toolsTokens: event.toolsTokens,
        logTokens: event.logTokens,
        inputTokens: event.inputTokens,
        ctxMax: event.ctxMax,
        toolsCount: event.toolsCount,
        logMessages: event.logMessages,
        topTools: event.topTools,
      });

    case "doctor.show":
      return appendCard(state, {
        kind: "doctor",
        id: event.id,
        ts: Date.now(),
        checks: event.checks,
      });

    case "usage.show":
      return appendCard(state, {
        kind: "usage",
        id: event.id,
        ts: Date.now(),
        turn: event.turn,
        tokens: event.tokens,
        cacheHit: event.cacheHit,
        cost: event.cost,
        sessionCost: event.sessionCost,
        balance: event.balance,
        elapsedMs: event.elapsedMs,
      });

    case "branch.start":
      return appendCard(state, {
        kind: "branch",
        id: event.id,
        ts: Date.now(),
        completed: 0,
        total: event.total,
        latestIndex: 0,
        latestTemperature: 0,
        latestUncertainties: 0,
        done: false,
      });

    case "branch.progress":
      return mutateCard(state, event.id, "branch", (c) => ({
        ...c,
        completed: event.completed,
        total: event.total,
        latestIndex: event.latestIndex,
        latestTemperature: event.latestTemperature,
        latestUncertainties: event.latestUncertainties,
      }));

    case "branch.end":
      return mutateCard(state, event.id, "branch", (c) => ({
        ...c,
        done: true,
        ...(event.aborted ? { aborted: true } : {}),
      }));
  }
}

function appendCard(state: AgentState, card: Card): AgentState {
  return { ...state, cards: [...state.cards, card] };
}

function mutateCard<K extends Card["kind"]>(
  state: AgentState,
  id: CardId,
  kind: K,
  patch: (card: Extract<Card, { kind: K }>) => Extract<Card, { kind: K }>,
): AgentState {
  const idx = state.cards.findIndex((c) => c.id === id && c.kind === kind);
  if (idx < 0) return state;
  const next = state.cards.slice();
  next[idx] = patch(state.cards[idx] as Extract<Card, { kind: K }>);
  return { ...state, cards: next };
}

function moveFocus(
  cards: ReadonlyArray<Card>,
  current: CardId | null,
  dir: "next" | "prev" | "first" | "last",
): CardId | null {
  const last = cards.length - 1;
  if (last < 0) return null;
  if (dir === "first") return cards[0]!.id;
  if (dir === "last") return cards[last]!.id;
  const idx = current ? cards.findIndex((c) => c.id === current) : -1;
  if (idx < 0) return cards[last]!.id;
  const next = dir === "next" ? Math.min(idx + 1, last) : Math.max(idx - 1, 0);
  return cards[next]!.id;
}

let toastSeq = 0;
function makeToast(event: Extract<AgentEvent, { type: "toast.show" }>): Toast {
  toastSeq += 1;
  return {
    id: `toast-${toastSeq}`,
    tone: event.tone,
    title: event.title,
    detail: event.detail,
    bornAt: Date.now(),
    ttlMs: event.ttlMs,
  };
}

let cardSeq = 0;
function nextId(prefix: string): string {
  cardSeq += 1;
  return `${prefix}-${cardSeq}`;
}

function makeUserCard(text: string): UserCard {
  return { kind: "user", id: nextId("user"), ts: Date.now(), text };
}

function makeReasoningCard(id: string, model?: string): ReasoningCard {
  return {
    kind: "reasoning",
    id,
    ts: Date.now(),
    text: "",
    paragraphs: 0,
    tokens: 0,
    streaming: true,
    ...(model ? { model } : {}),
  };
}

function makeStreamingCard(id: string, model?: string): StreamingCard {
  return {
    kind: "streaming",
    id,
    ts: Date.now(),
    text: "",
    done: false,
    ...(model ? { model } : {}),
  };
}

function makeToolCard(id: string, name: string, args: unknown): ToolCard {
  return {
    kind: "tool",
    id,
    ts: Date.now(),
    name,
    args,
    output: "",
    done: false,
    elapsedMs: 0,
  };
}

function makeLiveCard(
  variant: LiveCard["variant"],
  text: string,
  tone: LiveCard["tone"],
): LiveCard {
  return { kind: "live", id: nextId("live"), ts: Date.now(), variant, text, tone };
}
