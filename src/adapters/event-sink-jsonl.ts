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

export function openEventSink(path: string): JsonlEventSink {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: "a" });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* chmod no-op on Windows */
  }
  return new JsonlEventSink(stream);
}
