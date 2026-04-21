/**
 * Session persistence.
 *
 * Every turn's log entries (user / assistant / tool messages) are appended to
 * a JSONL file under `~/.reasonix/sessions/<name>.jsonl`. Next time the user
 * starts the CLI with the same session name, the loop pre-loads the file
 * into its AppendOnlyLog so the new turn has full prior context.
 *
 * Design notes:
 *   - JSONL rather than JSON so concurrent writes don't corrupt.
 *   - 0600 permissions on Unix (chmod no-ops on Windows).
 *   - Name sanitization keeps paths safe: only [\w-] and CJK letters pass;
 *     anything else is replaced with underscore, max 64 chars.
 *   - The loop's stats/session aren't persisted — only the message log.
 *     Cost accounting resets each run (by design — old costs are sunk).
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatMessage } from "./types.js";

export interface SessionInfo {
  name: string;
  path: string;
  size: number;
  messageCount: number;
  mtime: Date;
}

export function sessionsDir(): string {
  return join(homedir(), ".reasonix", "sessions");
}

export function sessionPath(name: string): string {
  return join(sessionsDir(), `${sanitizeName(name)}.jsonl`);
}

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^\w\-\u4e00-\u9fa5]/g, "_").slice(0, 64);
  return cleaned || "default";
}

export function loadSessionMessages(name: string): ChatMessage[] {
  const path = sessionPath(name);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const out: ChatMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as ChatMessage;
        if (msg && typeof msg === "object" && "role" in msg) out.push(msg);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function appendSessionMessage(name: string, message: ChatMessage): void {
  const path = sessionPath(name);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(message)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* chmod not supported on this platform */
  }
}

export function listSessions(): SessionInfo[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    return files
      .map((file) => {
        const path = join(dir, file);
        const stat = statSync(path);
        const name = file.replace(/\.jsonl$/, "");
        const messageCount = countLines(path);
        return { name, path, size: stat.size, messageCount, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  } catch {
    return [];
  }
}

export function deleteSession(name: string): boolean {
  const path = sessionPath(name);
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function countLines(path: string): number {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.split(/\r?\n/).filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}
