/** Port: workspace file snapshots. Async-shaped for remote backends. */

import type {
  CheckpointMeta,
  CreateCheckpointOptions,
  RestoreResult,
} from "../code/checkpoints.js";

export interface CheckpointStore {
  create(opts: CreateCheckpointOptions): Promise<CheckpointMeta>;
  restore(rootDir: string, id: string): Promise<RestoreResult>;
  list(rootDir: string): ReadonlyArray<CheckpointMeta>;
  remove(rootDir: string, id: string): Promise<boolean>;
}
