import { deleteSession, listSessions, pruneStaleSessions } from "../../../../session.js";
import type { SlashHandler } from "../dispatch.js";

const STALE_THRESHOLD_DAYS = 90;

const sessions: SlashHandler = (_args, loop) => {
  const items = listSessions();
  if (items.length === 0) {
    return {
      info: "no saved sessions yet — chat normally and your messages will be saved automatically",
    };
  }
  const now = Date.now();
  const lines = ["Saved sessions:"];
  let staleCount = 0;
  for (const s of items) {
    const sizeKb = (s.size / 1024).toFixed(1);
    const when = s.mtime.toISOString().replace("T", " ").slice(0, 16);
    const marker = s.name === loop.sessionName ? "▸" : " ";
    const ageDays = Math.floor((now - s.mtime.getTime()) / (24 * 60 * 60 * 1000));
    const isStale = ageDays >= STALE_THRESHOLD_DAYS;
    const ageTag = isStale ? `  (${ageDays}d — stale)` : "";
    if (isStale) staleCount++;
    lines.push(
      `  ${marker} ${s.name.padEnd(22)} ${String(s.messageCount).padStart(5)} msgs  ${sizeKb.padStart(7)} KB  ${when}${ageTag}`,
    );
  }
  lines.push("");
  lines.push("Resume with: reasonix chat --session <name>");
  if (staleCount > 0) {
    lines.push(
      `${staleCount} session${staleCount === 1 ? "" : "s"} idle ≥${STALE_THRESHOLD_DAYS} days — /prune-sessions to remove`,
    );
  }
  return { info: lines.join("\n") };
};

const forget: SlashHandler = (_args, loop) => {
  if (!loop.sessionName) {
    return { info: "not in a session — nothing to forget" };
  }
  const name = loop.sessionName;
  const ok = deleteSession(name);
  return {
    info: ok
      ? `▸ deleted session "${name}" — current screen still shows the conversation, but next launch starts fresh`
      : `could not delete session "${name}" (already gone?)`,
  };
};

const pruneSessions: SlashHandler = (args) => {
  // Optional first arg: cutoff in days (default 90). Lets users
  // tighten the threshold for a one-off purge without editing code.
  const raw = args?.[0];
  const days = raw ? Number.parseInt(raw, 10) : STALE_THRESHOLD_DAYS;
  if (!Number.isFinite(days) || days < 1) {
    return {
      info: `▸ usage: /prune-sessions [days]   — defaults to ${STALE_THRESHOLD_DAYS}, must be ≥1`,
    };
  }
  const removed = pruneStaleSessions(days);
  if (removed.length === 0) {
    return { info: `▸ nothing to prune — no sessions idle ≥${days} days` };
  }
  return {
    info: `▸ pruned ${removed.length} session${removed.length === 1 ? "" : "s"} idle ≥${days} days: ${removed.join(", ")}`,
  };
};

export const handlers: Record<string, SlashHandler> = {
  sessions,
  forget,
  "prune-sessions": pruneSessions,
};
