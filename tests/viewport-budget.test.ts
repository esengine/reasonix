import { describe, expect, it } from "vitest";
import { type ZoneId, allocateRows } from "../src/cli/ui/layout/viewport-budget.js";

const ZONE_PRIORITY: Record<ZoneId, number> = {
  modal: 100,
  "plan-card": 80,
  status: 60,
  input: 50,
  stream: 10,
  safety: 5,
};

function claim(zone: ZoneId, min: number, max: number) {
  return { zone, priority: ZONE_PRIORITY[zone], min, max };
}

describe("allocateRows — priority-greedy allocation", () => {
  it("single claim gets exactly its max when terminal is large enough", () => {
    const out = allocateRows([claim("modal", 18, 30)], 50);
    expect(out.get("modal")).toBe(30);
  });

  it("single claim is capped to its max even with rows to spare", () => {
    const out = allocateRows([claim("status", 1, 1)], 50);
    expect(out.get("status")).toBe(1);
  });

  it("modal wins over stream when rows are tight", () => {
    // Total 30 rows; modal wants 26-26 (fixed), stream wants 4..∞
    const out = allocateRows(
      [claim("modal", 26, 26), claim("stream", 4, Number.POSITIVE_INFINITY)],
      30,
    );
    expect(out.get("modal")).toBe(26);
    // Stream gets the remaining 4
    expect(out.get("stream")).toBe(4);
  });

  it("stream soaks remainder when stream max is unbounded", () => {
    const out = allocateRows([claim("stream", 4, Number.POSITIVE_INFINITY)], 50);
    expect(out.get("stream")).toBe(50);
  });

  it("higher priority claim always allocated first regardless of insertion order", () => {
    // Insert stream before modal — priority sort still puts modal first.
    const out = allocateRows(
      [claim("stream", 4, Number.POSITIVE_INFINITY), claim("modal", 20, 25)],
      30,
    );
    expect(out.get("modal")).toBe(25);
    expect(out.get("stream")).toBe(5);
  });

  it("low-priority claim may exceed remaining rows when forced to its min", () => {
    // 30-row term; modal claims 26, plan-card claims 5..5, stream wants min 4
    const out = allocateRows(
      [
        claim("modal", 26, 26),
        claim("plan-card", 5, 5),
        claim("stream", 4, Number.POSITIVE_INFINITY),
      ],
      30,
    );
    expect(out.get("modal")).toBe(26);
    // After modal, 4 rows left. plan-card forced to its min of 5 (exceeds avail).
    expect(out.get("plan-card")).toBe(5);
    // After plan-card forced to 5, stream gets its min of 4.
    expect(out.get("stream")).toBe(4);
  });

  it("zero total rows still allocates each claim's min (defensive)", () => {
    const out = allocateRows([claim("modal", 18, 30), claim("stream", 4, 100)], 0);
    expect(out.get("modal")).toBe(18);
    expect(out.get("stream")).toBe(4);
  });

  it("typical lamyc-video scenario: 50-row term, EditConfirm + streaming card", () => {
    // EditConfirm: 18 chrome + 8 min diff = 26 min; max = rows - 4 = 46
    // StreamingCard: 4 min, unbounded max
    const out = allocateRows(
      [claim("modal", 26, 46), claim("stream", 4, Number.POSITIVE_INFINITY)],
      50,
    );
    // Modal greedy-grabs 46 of 50.
    expect(out.get("modal")).toBe(46);
    // Stream forced to its min of 4 (remaining was 4, min is 4 — fits exactly).
    expect(out.get("stream")).toBe(4);
    // Total claimed: 50 — fits the viewport. No race.
  });

  it("no claims yields empty map", () => {
    const out = allocateRows([], 50);
    expect(out.size).toBe(0);
  });
});
