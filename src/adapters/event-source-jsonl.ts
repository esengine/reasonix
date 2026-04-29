import { existsSync, readFileSync } from "node:fs";
import type { Event } from "../core/events.js";
import type { EventSource } from "../ports/event-sink.js";
import { eventLogPath } from "./event-sink-jsonl.js";

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
