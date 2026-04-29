/**
 * Concrete `EventSource` adapter — reads the kernel event log sidecar
 * back as a typed Event stream. Matches `JsonlEventSink`'s on-disk
 * format: one JSON Event per line, append-only.
 *
 * Used by replay / projection consumers — anything that wants to
 * reconstruct session state from the durable event log without going
 * through loop or transcript.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Event } from "../core/events.js";
import type { EventSource } from "../ports/event-sink.js";
import { eventLogPath } from "./event-sink-jsonl.js";

/**
 * Parse a JSONL event log file into an Event array. Skips blank lines
 * and unparseable rows silently (the live writer may have crashed mid-
 * line). Caller decides what to do with the result — typically pipe
 * through `core/reducers.ts:apply` to project into views.
 */
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
      // Malformed line — partial write or truncation. Skip silently
      // and carry on; replay should be best-effort, not fail-stop.
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
