import type { WorldState } from "./types.js";

/** Deep-clone a WorldState — `structuredClone` is enough since the type is JSON-shaped by contract. */
export function cloneDb(db: WorldState): WorldState {
  return structuredClone(db);
}

export function getRow(
  db: WorldState,
  table: string,
  id: string,
): Record<string, unknown> | undefined {
  return db[table]?.[id];
}

export function setField(
  db: WorldState,
  table: string,
  id: string,
  field: string,
  value: unknown,
): boolean {
  const row = db[table]?.[id];
  if (!row) return false;
  row[field] = value;
  return true;
}
