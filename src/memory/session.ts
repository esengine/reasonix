/** JSONL append-only message log under `~/.reasonix/sessions/`; concurrent-write safe. */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatMessage } from "../types.js";

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

/** Compact sortable timestamp: YYYYMMDDHHmm (e.g. 202604301432) */
export function timestampSuffix(): string {
  return new Date().toISOString().replace(/[^\d]/g, "").slice(0, 12);
}

/** Alpha-reverse by filename — newest session first (no stat I/O).
 *  TODO: switch to `statSync(f).mtimeMs` for "most recently used" order
 *  (costs O(n) reads but discounts idle-but-recent activity). */
export function findSessionsByPrefix(prefix: string): string[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".events.jsonl") && f.startsWith(prefix))
      .sort()
      .reverse();
    return files.map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

/** Session picker metadata. */
export interface SessionPreview {
  messageCount: number;
  lastActive: Date;
}

/** Resolve session name + picker preview. Priority order in description.md. */
export function resolveSession(
  sessionName: string | undefined,
  forceNew?: boolean,
  forceResume?: boolean,
): { resolved: string | undefined; preview: SessionPreview | undefined } {
  let resolved = sessionName;
  let preview: SessionPreview | undefined;

  if (sessionName && forceNew) {
    resolved = `${sessionName}-${timestampSuffix()}`;
  } else if (sessionName && !forceResume) {
    let sessionToCheck = sessionName;
    const prefixed = findSessionsByPrefix(`${sessionName}-`);
    if (prefixed.length > 0) {
      sessionToCheck = prefixed[0]!;
    }
    const prior = loadSessionMessages(sessionToCheck);
    if (prior.length > 0) {
      resolved = sessionToCheck;
      const p = sessionPath(sessionToCheck);
      const mtime = existsSync(p) ? statSync(p).mtime : new Date();
      preview = { messageCount: prior.length, lastActive: mtime };
    }
  } else if (sessionName && forceResume) {
    const prefixed = findSessionsByPrefix(`${sessionName}-`);
    if (prefixed.length > 0) {
      resolved = prefixed[0]!;
    }
  }

  return { resolved, preview };
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

/** Best-effort: per-file delete errors are swallowed so partial pruning still finishes. */
export function pruneStaleSessions(daysOld = 90): string[] {
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  for (const s of listSessions()) {
    if (s.mtime.getTime() < cutoff) {
      if (deleteSession(s.name)) deleted.push(s.name);
    }
  }
  return deleted;
}

export function deleteSession(name: string): boolean {
  const path = sessionPath(name);
  try {
    unlinkSync(path);
    // Best-effort cleanup of side-car files that belong to this session
    // so `/forget` doesn't leave orphans in `sessionsDir()`:
    //   - .pending.json   pending-edits checkpoint (src/code/pending-edits.ts)
    //   - .plan.json      structured plan state (src/code/plan-store.ts)
    const sidecars = [
      path.replace(/\.jsonl$/, ".pending.json"),
      path.replace(/\.jsonl$/, ".plan.json"),
    ];
    for (const sc of sidecars) {
      try {
        unlinkSync(sc);
      } catch {
        /* no sidecar present — expected */
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Non-atomic truncate+write window is acceptable — concurrent crash here = `/forget`. */
export function rewriteSession(name: string, messages: ChatMessage[]): void {
  const path = sessionPath(name);
  mkdirSync(dirname(path), { recursive: true });
  const body = messages.map((m) => JSON.stringify(m)).join("\n");
  writeFileSync(path, body ? `${body}\n` : "", "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* chmod not supported */
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
