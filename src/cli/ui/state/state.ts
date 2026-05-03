import { getLanguage } from "../../../i18n/index.js";
import type { LanguageCode } from "../../../i18n/types.js";
import type { Card, CardId } from "./cards.js";

export type Mode = "auto" | "ask" | "plan" | "edit";
export type NetworkState = "online" | "slow" | "disconnected" | "reconnecting";
export type ToastTone = "ok" | "info" | "warn" | "err";

export interface SessionInfo {
  readonly id: string;
  readonly branch: string;
  readonly workspace: string;
  readonly model: string;
}

export interface ComposerState {
  value: string;
  cursor: number;
  picker: "slash" | "mention" | "history" | "slasharg" | null;
  shell: boolean;
  abortedHint: boolean;
}

export interface StatusBar {
  mode: Mode;
  network: NetworkState;
  networkDetail?: string;
  cost: number;
  sessionCost: number;
  balance?: number;
  cacheHit: number;
  countdownSeconds?: number;
  recording?: { sizeBytes: number; events: number; path: string };
}

export interface Toast {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly detail?: string;
  readonly bornAt: number;
  readonly ttlMs: number;
}

export interface AgentState {
  readonly lang: LanguageCode;
  readonly session: SessionInfo;
  readonly cards: ReadonlyArray<Card>;
  readonly composer: ComposerState;
  readonly status: StatusBar;
  readonly focusedCardId: CardId | null;
  readonly toasts: ReadonlyArray<Toast>;
  readonly turnInProgress: boolean;
}

export function initialState(session: SessionInfo, cards: ReadonlyArray<Card> = []): AgentState {
  return {
    lang: getLanguage(),
    session,
    cards,
    composer: {
      value: "",
      cursor: 0,
      picker: null,
      shell: false,
      abortedHint: false,
    },
    status: {
      mode: "auto",
      network: "online",
      cost: 0,
      sessionCost: 0,
      cacheHit: 0,
    },
    focusedCardId: null,
    toasts: [],
    turnInProgress: false,
  };
}
