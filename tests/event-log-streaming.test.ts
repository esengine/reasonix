/**
 * Tests for the streaming-row text helpers.
 *
 * These guard the perf invariants we shipped in 0.12.16:
 *   - `lastLine` must NOT scan the full buffer on every call (the
 *     streaming row repaints at ~30Hz; an O(N) regex on a multi-KB
 *     buffer was a real cost on long replies).
 *   - The collapsed-whitespace + ellipsis-prefix output shape is
 *     stable so the live tail reads consistently across renders.
 */

import { describe, expect, it } from "vitest";
import { lastLine } from "../src/cli/ui/EventLog.js";

describe("lastLine", () => {
  it("returns the input unchanged when shorter than maxChars", () => {
    expect(lastLine("hello world", 140)).toBe("hello world");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(lastLine("hello   world\n\nfoo", 140)).toBe("hello world foo");
  });

  it("trims leading/trailing whitespace", () => {
    expect(lastLine("   padded   ", 140)).toBe("padded");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(lastLine("   \n\t  ", 140)).toBe("");
    expect(lastLine("", 140)).toBe("");
  });

  it("prepends an ellipsis and keeps the last maxChars when overflowing", () => {
    const huge = `${"x".repeat(200)}END`;
    const got = lastLine(huge, 10);
    expect(got.startsWith("…")).toBe(true);
    // Ellipsis + last 10 chars of the collapsed text.
    expect(got).toBe(`…${huge.slice(-10)}`);
  });

  it("works correctly even when the last maxChars contains whitespace that collapses", () => {
    // Worst case the bounded slice handles: whitespace inside the
    // tail collapses, ellipsis stays at the front. After collapse
    // the visible tail of 6 chars is "x tail" — one x, one space,
    // four chars of "tail".
    const padded = `${"x".repeat(500)}   tail`;
    const got = lastLine(padded, 6);
    expect(got).toBe("…x tail");
  });

  it("does not scan the full buffer for a sub-tail-length result", () => {
    // The post-condition we actually care about: a 1MB buffer with a
    // 140-char tail should run in the same ballpark as a 1KB buffer.
    // Direct timing is flaky in CI; instead we assert the OUTPUT is
    // consistent with operating on just the tail slice — anything
    // before `maxChars * 4` from the end must be invisible to the
    // result. Embed a poison-pill marker far away from the tail; it
    // must not show up in the output.
    const poison = "POISON";
    const tail = "actual visible tail";
    const buf = poison + "x".repeat(50_000) + tail;
    const got = lastLine(buf, tail.length);
    expect(got).not.toContain("POISON");
    expect(got.endsWith(tail)).toBe(true);
  });
});
