/**
 * Concrete `EventSink` adapter — writes the kernel Event log to a
 * `<sessionsDir>/<name>.events.jsonl` sidecar alongside the existing
 * ChatMessage session file. One Event per line; append-only.
 *
 * Mirrors the design of `src/transcript.ts:openTranscriptFile` so the
 * disk shape is consistent across artifacts (jsonl, durable, parseable
 * by streaming readers).
 */

import { type WriteStream, chmodSync, createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Event } from "../core/events.js";
import type { EventSink } from "../ports/event-sink.js";
import { sanitizeName, sessionsDir } from "../session.js";

export function eventLogPath(sessionName: string): string {
  return join(sessionsDir(), `${sanitizeName(sessionName)}.events.jsonl`);
}

export class JsonlEventSink implements EventSink {
  private buffered = 0;

  constructor(private readonly stream: WriteStream) {}

  append(ev: Event): void {
    this.stream.write(`${JSON.stringify(ev)}\n`);
    this.buffered++;
  }

  flush(): Promise<void> {
    return new Promise((resolve) => {
      if (this.buffered === 0) return resolve();
      // `cork`/`uncork` is the documented way to ask Node to release
      // batched writes; we rely on the OS to actually fsync. For a
      // session log that's fine — losing the last few events on a
      // hard crash is acceptable since the transcript file carries
      // the same conversation.
      this.stream.uncork();
      this.buffered = 0;
      resolve();
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}

/**
 * Open (or create) the sidecar file for `sessionName`. Creates parent
 * directory if missing; chmods to 0600 on Unix to match the session
 * file's permissions (chmod no-ops on Windows).
 */
export function openEventSink(path: string): JsonlEventSink {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: "a" });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* chmod not supported on this platform */
  }
  return new JsonlEventSink(stream);
}
