import { t } from "../../../../i18n/index.js";
import {
  deleteSession,
  listSessions,
  pruneStaleSessions,
  renameSession,
} from "../../../../memory/session.js";
import type { SlashHandler } from "../dispatch.js";

const STALE_THRESHOLD_DAYS = 90;

const sessions: SlashHandler = () => ({ openSessionsPicker: true });

const forget: SlashHandler = (_args, loop) => {
  if (!loop.sessionName) {
    return { info: t("handlers.sessions.forgetNoSession") };
  }
  const name = loop.sessionName;
  const ok = deleteSession(name);
  return {
    info: ok
      ? t("handlers.sessions.forgetInfo", { name })
      : t("handlers.sessions.forgetFailed", { name }),
  };
};

const pruneSessions: SlashHandler = (args) => {
  const raw = args?.[0];
  const days = raw ? Number.parseInt(raw, 10) : STALE_THRESHOLD_DAYS;
  if (!Number.isFinite(days) || days < 1) {
    return {
      info: t("handlers.sessions.pruneUsage", { default: STALE_THRESHOLD_DAYS }),
    };
  }
  const removed = pruneStaleSessions(days);
  if (removed.length === 0) {
    return { info: t("handlers.sessions.pruneNone", { days }) };
  }
  return {
    info: t("handlers.sessions.pruneInfo", {
      count: removed.length,
      s: removed.length === 1 ? "" : "s",
      days,
      names: removed.join(", "),
    }),
  };
};

const rename: SlashHandler = (args, loop) => {
  const newName = args?.[0]?.trim();
  if (!newName) return { info: t("handlers.sessions.renameUsage") };
  if (!loop.sessionName) return { info: t("handlers.sessions.renameNoSession") };
  const ok = renameSession(loop.sessionName, newName);
  if (!ok) {
    return { info: t("handlers.sessions.renameFailed", { name: newName }) };
  }
  return { info: t("handlers.sessions.renameInfo", { name: newName }) };
};

const resume: SlashHandler = (args) => {
  const name = args?.[0]?.trim();
  if (!name) return { info: t("handlers.sessions.resumeUsage") };
  const exists = listSessions().some((s) => s.name === name);
  if (!exists) return { info: t("handlers.sessions.resumeNotFound", { name }) };
  return { info: t("handlers.sessions.resumeInfo", { name }) };
};

export const handlers: Record<string, SlashHandler> = {
  sessions,
  forget,
  rename,
  resume,
  "prune-sessions": pruneSessions,
};
