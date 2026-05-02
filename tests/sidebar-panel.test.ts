import { describe, expect, it } from "vitest";
import { windowSteps } from "../src/cli/ui/layout/SidebarPanel.js";
import type { PlanStep } from "../src/cli/ui/state/cards.js";

function step(id: string, status: PlanStep["status"] = "queued"): PlanStep {
  return { id, title: `step ${id}`, status };
}

describe("windowSteps", () => {
  it("returns all steps when total ≤ 2*padding+1", () => {
    const steps = [step("a"), step("b"), step("c")];
    const r = windowSteps(steps, 1, 5);
    expect(r.kind).toBe("all");
    expect(r.steps).toHaveLength(3);
    expect(r.startIndex).toBe(0);
  });

  it("windows around focus step in the middle of a long plan", () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(`s${i}`));
    const r = windowSteps(steps, 10, 3);
    expect(r.kind).toBe("windowed");
    if (r.kind !== "windowed") throw new Error("type guard");
    expect(r.steps).toHaveLength(7); // 2*3 + 1
    expect(r.startIndex).toBe(7);
    expect(r.hidden).toBe(7);
    expect(r.hiddenAfter).toBe(6);
  });

  it("clamps window to start when focus is near beginning", () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(`s${i}`));
    const r = windowSteps(steps, 0, 3);
    expect(r.kind).toBe("windowed");
    if (r.kind !== "windowed") throw new Error("type guard");
    expect(r.startIndex).toBe(0);
    expect(r.hidden).toBe(0);
    expect(r.hiddenAfter).toBe(13);
  });

  it("clamps window to end when focus is near end", () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(`s${i}`));
    const r = windowSteps(steps, 19, 3);
    expect(r.kind).toBe("windowed");
    if (r.kind !== "windowed") throw new Error("type guard");
    expect(r.startIndex).toBe(13);
    expect(r.hidden).toBe(13);
    expect(r.hiddenAfter).toBe(0);
    expect(r.steps).toHaveLength(7);
  });

  it("falls back to focus=0 when no running step", () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(`s${i}`));
    const r = windowSteps(steps, -1, 3);
    expect(r.kind).toBe("windowed");
    if (r.kind !== "windowed") throw new Error("type guard");
    expect(r.startIndex).toBe(0);
  });
});
