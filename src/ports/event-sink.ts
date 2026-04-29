/** Port: append-only persistence of the kernel event log. */

import type { Event } from "../core/events.js";

export interface EventSink {
  append(ev: Event): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface EventSource {
  read(sessionName: string): AsyncIterable<Event>;
}
