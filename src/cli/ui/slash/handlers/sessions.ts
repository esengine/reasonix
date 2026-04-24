import { deleteSession, listSessions } from "../../../../session.js";
import type { SlashHandler } from "../dispatch.js";

const sessions: SlashHandler = (_args, loop) => {
  const items = listSessions();
  if (items.length === 0) {
    return {
      info: "no saved sessions yet — chat normally and your messages will be saved automatically",
    };
  }
  const lines = ["Saved sessions:"];
  for (const s of items) {
    const sizeKb = (s.size / 1024).toFixed(1);
    const when = s.mtime.toISOString().replace("T", " ").slice(0, 16);
    const marker = s.name === loop.sessionName ? "▸" : " ";
    lines.push(
      `  ${marker} ${s.name.padEnd(22)} ${String(s.messageCount).padStart(5)} msgs  ${sizeKb.padStart(7)} KB  ${when}`,
    );
  }
  lines.push("");
  lines.push("Resume with: reasonix chat --session <name>");
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

export const handlers: Record<string, SlashHandler> = {
  sessions,
  forget,
};
