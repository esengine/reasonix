/** Per-server ring-buffered latency tracker; emits a "slow" event on threshold cross only. */

const SAMPLE_SIZE = 5;
const DEFAULT_THRESHOLD_MS = 4000;

export interface SlowEvent {
  serverName: string;
  p95Ms: number;
  sampleSize: number;
}

export interface LatencyTrackerOptions {
  thresholdMs?: number;
  onSlow?: (ev: SlowEvent) => void;
}

export class LatencyTracker {
  private samples: number[] = [];
  private wasOverThreshold = false;
  private readonly thresholdMs: number;
  private readonly onSlow?: (ev: SlowEvent) => void;

  constructor(
    private readonly serverName: string,
    opts: LatencyTrackerOptions = {},
  ) {
    this.thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
    this.onSlow = opts.onSlow;
  }

  record(elapsedMs: number): void {
    this.samples.push(elapsedMs);
    if (this.samples.length > SAMPLE_SIZE) this.samples.shift();
    if (this.samples.length < SAMPLE_SIZE) return;
    const p95 = computeP95(this.samples);
    const nowOver = p95 > this.thresholdMs;
    if (nowOver && !this.wasOverThreshold) {
      this.onSlow?.({ serverName: this.serverName, p95Ms: p95, sampleSize: this.samples.length });
    }
    this.wasOverThreshold = nowOver;
  }
}

/** Plain p95 — sort the buffer and pick the index at floor(N * 0.95). */
export function computeP95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx] ?? 0;
}
