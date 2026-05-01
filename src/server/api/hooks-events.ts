import { existsSync } from "node:fs";
import { readEventLogFile, recentEventFiles } from "../../adapters/event-source-jsonl.js";
import { sessionsDir as defaultSessionsDir } from "../../memory/session.js";

export interface HookRunRow {
  hookName: string;
  phase: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
  outcome: "ok" | "blocked" | "modified" | "error";
  whenMs: number;
}

const HOOK_LOG_CAP = 12;

export function readRecentHookRuns(
  now: number = Date.now(),
  sessionsDirOverride?: string,
): ReadonlyArray<HookRunRow> | null {
  const dir = sessionsDirOverride ?? defaultSessionsDir();
  if (!existsSync(dir)) return null;
  const files = recentEventFiles(dir, now);
  if (files.length === 0) return null;

  const rows: HookRunRow[] = [];
  for (const file of files) {
    const events = readEventLogFile(file);
    for (const ev of events) {
      if (ev.type !== "hook.fired") continue;
      const ts = Date.parse(ev.ts);
      if (!Number.isFinite(ts)) continue;
      rows.push({
        hookName: ev.hookName,
        phase: ev.phase,
        outcome: ev.outcome,
        whenMs: ts,
      });
    }
  }
  rows.sort((a, b) => b.whenMs - a.whenMs);
  return rows.slice(0, HOOK_LOG_CAP);
}
