/** Port: memory pyramid. Today wraps user-memory + project-memory + hash-memory. */

import type { MemoryEntry, MemoryScope, MemoryType } from "../user-memory.js";

export interface MemoryWriteInput {
  name: string;
  type: MemoryType;
  scope: MemoryScope;
  description: string;
  body: string;
}

export interface MemoryStore {
  query(scope: MemoryScope, name: string): Promise<MemoryEntry | null>;
  list(scope: MemoryScope): Promise<ReadonlyArray<MemoryEntry>>;
  write(input: MemoryWriteInput): Promise<void>;
  remove(scope: MemoryScope, name: string): Promise<boolean>;
}
