import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "../core/events.js";
import type { EventSource } from "../ports/event-sink.js";
import { eventLogPath } from "./event-sink-jsonl.js";

const DAY_MS = 86_400_000;

/** Most-recently-modified `*.events.jsonl` files, capped + filtered by stale-mtime cutoff. */
export function recentEventFiles(dir: string, now: number, cap = 8, staleDays = 30): string[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = now - staleDays * DAY_MS;
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".events.jsonl")) continue;
    const path = join(dir, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) continue;
    candidates.push({ path, mtime });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.slice(0, cap).map((c) => c.path);
}

export function readEventLogFile(path: string): Event[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: Event[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as Event;
      if (ev && typeof ev === "object" && typeof (ev as { type?: unknown }).type === "string") {
        out.push(ev);
      }
    } catch {
      /* malformed mid-line write — best-effort skip */
    }
  }
  return out;
}

export class JsonlEventSource implements EventSource {
  async *read(sessionName: string): AsyncIterable<Event> {
    const events = readEventLogFile(eventLogPath(sessionName));
    for (const ev of events) yield ev;
  }
}
