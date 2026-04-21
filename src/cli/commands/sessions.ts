/**
 * `reasonix sessions` — CLI equivalent of the `/sessions` slash command.
 *
 * Two modes:
 *   - `reasonix sessions`           list every session under ~/.reasonix/sessions/
 *   - `reasonix sessions <name>`    dump one session's messages in readable form
 *
 * Neither needs an API key — pure filesystem reads of JSONL files written
 * by previous chat runs.
 */

import { listSessions, loadSessionMessages, sessionPath } from "../../index.js";
import type { ChatMessage } from "../../index.js";

export interface SessionsOptions {
  /** When present, inspect that session instead of listing. */
  name?: string;
  /** Include assistant tool-call metadata in the inspect output. */
  verbose?: boolean;
}

export function sessionsCommand(opts: SessionsOptions): void {
  if (opts.name) {
    inspectSession(opts.name, !!opts.verbose);
  } else {
    listAll();
  }
}

function listAll(): void {
  const items = listSessions();
  if (items.length === 0) {
    console.log(
      "no saved sessions yet — run `reasonix chat` (sessions are auto-saved unless --no-session).",
    );
    return;
  }
  console.log("Saved sessions (~/.reasonix/sessions/):");
  console.log("");
  console.log(`  ${"name".padEnd(22)} ${"msgs".padStart(6)}  ${"size".padStart(8)}  modified`);
  console.log(`  ${"─".repeat(60)}`);
  for (const s of items) {
    const sizeKb = `${(s.size / 1024).toFixed(1)} KB`;
    const when = s.mtime.toISOString().replace("T", " ").slice(0, 16);
    console.log(
      `  ${s.name.padEnd(22)} ${String(s.messageCount).padStart(6)}  ${sizeKb.padStart(8)}  ${when}`,
    );
  }
  console.log("");
  console.log("Inspect:  reasonix sessions <name>");
  console.log("Resume:   reasonix chat --session <name>");
}

function inspectSession(name: string, verbose: boolean): void {
  const path = sessionPath(name);
  const messages = loadSessionMessages(name);
  if (messages.length === 0) {
    console.error(`no session named "${name}" (or it's empty).`);
    console.error(`looked at: ${path}`);
    process.exit(1);
  }

  console.log(`[session] ${name}   ${messages.length} messages   ${path}`);
  console.log("");

  let turnIndex = 0;
  for (const msg of messages) {
    renderMessage(msg, turnIndex, verbose);
    // Roughly bump "turn" after each user message so the reader can follow
    // the conversation shape without the transcript's richer turn numbering.
    if (msg.role === "user") turnIndex++;
  }
}

function renderMessage(msg: ChatMessage, turnIdx: number, verbose: boolean): void {
  const turn = turnIdx > 0 ? `[t${turnIdx}]` : "[start]";
  const content = typeof msg.content === "string" ? msg.content : "";
  const flat = oneLine(content);

  if (msg.role === "user") {
    console.log(`${turn} USER: ${flat}`);
  } else if (msg.role === "assistant") {
    console.log(`${turn} AGENT: ${flat || "(tool call only)"}`);
    if (verbose && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        console.log(
          `         → call ${tc.function?.name} ${truncate(tc.function?.arguments ?? "", 80)}`,
        );
      }
    }
  } else if (msg.role === "tool") {
    console.log(`${turn} TOOL ${msg.name ?? "?"}: ${truncate(flat, 160)}`);
  } else if (msg.role === "system") {
    if (verbose) console.log(`${turn} SYSTEM: ${truncate(flat, 160)}`);
    // otherwise suppress — session's system prompt is usually session-wide
    // boilerplate.
  }
}

function oneLine(s: string, max = 200): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
