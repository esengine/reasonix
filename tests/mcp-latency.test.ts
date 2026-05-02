import { describe, expect, it, vi } from "vitest";
import { formatMcpSlowToast } from "../src/cli/ui/mcp-toast.js";
import { LatencyTracker, computeP95 } from "../src/mcp/latency.js";

describe("computeP95", () => {
  it("returns 0 on an empty buffer", () => {
    expect(computeP95([])).toBe(0);
  });

  it("returns the largest sample for tiny buffers", () => {
    expect(computeP95([100, 200, 300])).toBe(300);
  });

  it("picks the floor(N*0.95) index of the sorted sample", () => {
    expect(computeP95([100, 200, 300, 400, 500])).toBe(500);
    expect(computeP95([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toBe(100);
  });
});

describe("LatencyTracker", () => {
  it("does not fire onSlow before the buffer fills (5 samples)", () => {
    const onSlow = vi.fn();
    const t = new LatencyTracker("notion", { thresholdMs: 1000, onSlow });
    for (const ms of [9000, 9000, 9000, 9000]) t.record(ms);
    expect(onSlow).not.toHaveBeenCalled();
  });

  it("fires onSlow exactly once on the first sample that crosses the threshold", () => {
    const onSlow = vi.fn();
    const t = new LatencyTracker("notion", { thresholdMs: 1000, onSlow });
    for (const ms of [9000, 9000, 9000, 9000, 9000]) t.record(ms);
    expect(onSlow).toHaveBeenCalledTimes(1);
    expect(onSlow.mock.calls[0]?.[0]).toMatchObject({
      serverName: "notion",
      p95Ms: 9000,
      sampleSize: 5,
    });
    // Subsequent samples that stay over threshold do NOT re-fire.
    t.record(9000);
    t.record(9000);
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it("fires again when p95 dips below and crosses back over", () => {
    const onSlow = vi.fn();
    const t = new LatencyTracker("notion", { thresholdMs: 1000, onSlow });
    for (const ms of [9000, 9000, 9000, 9000, 9000]) t.record(ms);
    expect(onSlow).toHaveBeenCalledTimes(1);
    // Drain the buffer with fast samples so p95 drops below.
    for (const ms of [100, 100, 100, 100, 100]) t.record(ms);
    expect(onSlow).toHaveBeenCalledTimes(1);
    // Slow again — should re-fire.
    for (const ms of [9000, 9000, 9000, 9000, 9000]) t.record(ms);
    expect(onSlow).toHaveBeenCalledTimes(2);
  });

  it("uses the default 4000ms threshold when none is given", () => {
    const onSlow = vi.fn();
    const t = new LatencyTracker("notion", { onSlow });
    for (const ms of [3000, 3000, 3000, 3000, 3000]) t.record(ms);
    expect(onSlow).not.toHaveBeenCalled();
    for (const ms of [5000, 5000, 5000, 5000, 5000]) t.record(ms);
    expect(onSlow).toHaveBeenCalledTimes(1);
  });
});

describe("formatMcpSlowToast", () => {
  it("renders the p95-over-N-calls warn line", () => {
    expect(formatMcpSlowToast({ name: "notion", p95Ms: 8400, sampleSize: 5 })).toBe(
      "⚠ MCP `notion` slow · 8.4s p95 over the last 5 calls",
    );
  });

  it("rounds to one decimal place", () => {
    expect(formatMcpSlowToast({ name: "linear", p95Ms: 4250, sampleSize: 5 })).toBe(
      "⚠ MCP `linear` slow · 4.3s p95 over the last 5 calls",
    );
  });
});
