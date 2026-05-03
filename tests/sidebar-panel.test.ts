import { describe, expect, it } from "vitest";
import { findActivePlan, windowSteps } from "../src/cli/ui/layout/SidebarPanel.js";
import type { Card, PlanCard, PlanStep } from "../src/cli/ui/state/cards.js";

function step(id: string, status: PlanStep["status"] = "queued"): PlanStep {
  return { id, title: `step ${id}`, status };
}

function planCard(steps: PlanStep[], variant: PlanCard["variant"] = "active"): PlanCard {
  return {
    kind: "plan",
    id: "p1",
    ts: 0,
    variant,
    title: "test plan",
    steps,
  };
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

describe("findActivePlan", () => {
  it("returns null when every step is queued — plan is awaiting approval", () => {
    const cards: Card[] = [planCard([step("a"), step("b"), step("c")])];
    expect(findActivePlan(cards)).toBeNull();
  });

  it("returns the plan once any step has left queued", () => {
    const cards: Card[] = [planCard([step("a", "running"), step("b"), step("c")])];
    expect(findActivePlan(cards)).toBe(cards[0]);
  });

  it("returns null when every step is done or skipped — plan finished", () => {
    const cards: Card[] = [planCard([step("a", "done"), step("b", "skipped")])];
    expect(findActivePlan(cards)).toBeNull();
  });

  it("returns null for non-active variants (resumed / replay)", () => {
    const running = [step("a", "running")];
    expect(findActivePlan([planCard(running, "resumed")])).toBeNull();
    expect(findActivePlan([planCard(running, "replay")])).toBeNull();
  });

  it("returns the latest active plan when multiple exist", () => {
    const older = planCard([step("a", "running")]);
    const newer: typeof older = { ...older, id: "p2", steps: [step("x", "running")] };
    expect(findActivePlan([older, newer])).toBe(newer);
  });
});
