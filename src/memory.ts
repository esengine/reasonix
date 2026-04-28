import { createHash } from "node:crypto";
import type { ChatMessage, ToolSpec } from "./types.js";

export interface ImmutablePrefixOptions {
  system: string;
  toolSpecs?: readonly ToolSpec[];
  fewShots?: readonly ChatMessage[];
}

export class ImmutablePrefix {
  readonly system: string;
  /**
   * Backing array for `toolSpecs`. Originally `Object.freeze`d at
   * construction (hence the class name) — but `addTool` now lets the
   * dashboard register `semantic_search` after a mid-session
   * `reasonix index` build without forcing the user to restart. Each
   * add is documented to cost one cache-miss turn (the cached prefix
   * on DeepSeek's side is keyed by the full tool list); subsequent
   * turns re-cache against the new shape.
   */
  private _toolSpecs: ToolSpec[];
  readonly fewShots: readonly ChatMessage[];
  /**
   * Cached SHA-256 of the prefix payload. Computed lazily on first
   * `fingerprint` access, invalidated only by mutations that go
   * through `addTool` (the one legitimate post-construction mutation
   * path). The TUI reads `fingerprint` on every render — without the
   * cache, that means a fresh `JSON.stringify` + sha256 over the
   * full prefix (system prompt + tools list + few-shots, typically
   * 5-10KB) on every keystroke.
   *
   * The lazy-init also acts as a cheap drift guard: if some future
   * code path mutates `_toolSpecs` directly without going through
   * `addTool`, `fingerprint` will return the stale cached value
   * while the actual prefix sent to DeepSeek diverges — the cache
   * miss would be the first symptom. {@link verifyFingerprint}
   * lets dev / test code assert the cache matches reality.
   */
  private _fingerprintCache: string | null = null;

  constructor(opts: ImmutablePrefixOptions) {
    this.system = opts.system;
    this._toolSpecs = [...(opts.toolSpecs ?? [])];
    this.fewShots = Object.freeze([...(opts.fewShots ?? [])]);
  }

  get toolSpecs(): readonly ToolSpec[] {
    return this._toolSpecs;
  }

  toMessages(): ChatMessage[] {
    return [{ role: "system", content: this.system }, ...this.fewShots.map((m) => ({ ...m }))];
  }

  tools(): ToolSpec[] {
    return this._toolSpecs.map((t) => structuredClone(t) as ToolSpec);
  }

  /**
   * Add a tool spec to the prefix. Returns `true` if added, `false`
   * if a tool with the same name was already present (callers can
   * decide whether to ignore or surface the no-op). The model picks
   * up the new tool on the next turn after the cache busts once.
   */
  addTool(spec: ToolSpec): boolean {
    const name = spec.function?.name;
    if (!name) return false;
    if (this._toolSpecs.some((t) => t.function?.name === name)) return false;
    this._toolSpecs.push(spec);
    this._fingerprintCache = null;
    return true;
  }

  get fingerprint(): string {
    if (this._fingerprintCache !== null) return this._fingerprintCache;
    this._fingerprintCache = this.computeFingerprint();
    return this._fingerprintCache;
  }

  /**
   * Recompute the fingerprint from scratch and assert it matches the
   * cached value. Returns the freshly-computed hash on success; throws
   * with a diff if the cache drifted, which always indicates a bug —
   * either a non-`addTool` mutation path was added, or `addTool`
   * forgot to invalidate the cache. Dev / test only; the live loop
   * doesn't call this on the hot path.
   */
  verifyFingerprint(): string {
    const fresh = this.computeFingerprint();
    if (this._fingerprintCache !== null && this._fingerprintCache !== fresh) {
      throw new Error(
        `ImmutablePrefix fingerprint drift: cached=${this._fingerprintCache}, fresh=${fresh}. ` +
          "A mutation path bypassed addTool's cache invalidation — DeepSeek will see prefix " +
          "churn that the TUI / transcript log don't know about.",
      );
    }
    this._fingerprintCache = fresh;
    return fresh;
  }

  private computeFingerprint(): string {
    const blob = JSON.stringify({
      system: this.system,
      tools: this._toolSpecs,
      shots: this.fewShots,
    });
    return createHash("sha256").update(blob).digest("hex").slice(0, 16);
  }
}

export class AppendOnlyLog {
  private _entries: ChatMessage[] = [];

  append(message: ChatMessage): void {
    if (!message || typeof message !== "object" || !("role" in message)) {
      throw new Error(`invalid log entry: ${JSON.stringify(message)}`);
    }
    this._entries.push(message);
  }

  extend(messages: ChatMessage[]): void {
    for (const m of messages) this.append(m);
  }

  /**
   * Bulk-replace entries. Intentionally named to be hard to reach for —
   * this is the one mutation path that breaks the log's append-only
   * spirit, reserved for compaction flows (`/compact`) and recovery
   * where the caller has consciously decided to drop old history. Any
   * other use is almost certainly wrong; append() is what you want.
   */
  compactInPlace(replacement: ChatMessage[]): void {
    this._entries = [...replacement];
  }

  get entries(): readonly ChatMessage[] {
    return this._entries;
  }

  toMessages(): ChatMessage[] {
    return this._entries.map((e) => ({ ...e }));
  }

  get length(): number {
    return this._entries.length;
  }
}

export class VolatileScratch {
  reasoning: string | null = null;
  planState: Record<string, unknown> | null = null;
  notes: string[] = [];

  reset(): void {
    this.reasoning = null;
    this.planState = null;
    this.notes = [];
  }
}
