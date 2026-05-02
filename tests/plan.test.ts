/** Plan Mode — read-only dispatch gate + submit_plan tool's PlanProposedError → tool_result protocol. */

import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import {
  PlanCheckpointError,
  PlanProposedError,
  PlanRevisionProposedError,
  registerPlanTool,
} from "../src/tools/plan.js";

describe("ToolRegistry plan mode", () => {
  it("starts with plan mode off by default", () => {
    const reg = new ToolRegistry();
    expect(reg.planMode).toBe(false);
  });

  it("setPlanMode toggles the flag", () => {
    const reg = new ToolRegistry();
    reg.setPlanMode(true);
    expect(reg.planMode).toBe(true);
    reg.setPlanMode(false);
    expect(reg.planMode).toBe(false);
  });

  it("blocks non-readOnly tools when plan mode is on", async () => {
    const reg = new ToolRegistry();
    let ran = false;
    reg.register({
      name: "mutate",
      // readOnly: undefined → treated as write
      fn: () => {
        ran = true;
        return "ok";
      },
    });
    reg.setPlanMode(true);
    const out = await reg.dispatch("mutate", "{}");
    expect(ran).toBe(false);
    const payload = JSON.parse(out);
    expect(payload.error).toMatch(/unavailable in plan mode/);
    expect(payload.error).toMatch(/submit_plan/);
  });

  it("allows readOnly tools when plan mode is on", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "read_thing",
      readOnly: true,
      fn: () => "the-thing",
    });
    reg.setPlanMode(true);
    const out = await reg.dispatch("read_thing", "{}");
    expect(out).toBe("the-thing");
  });

  it("honors readOnlyCheck taking the actual arguments into account", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "maybe_read",
      readOnlyCheck: (args: { kind?: string }) => args.kind === "read",
      fn: (args: { kind?: string }) => `did-${args.kind}`,
    });
    reg.setPlanMode(true);
    // Read call: allowed.
    const readOut = await reg.dispatch("maybe_read", '{"kind":"read"}');
    expect(readOut).toBe("did-read");
    // Write call: refused.
    const writeOut = await reg.dispatch("maybe_read", '{"kind":"write"}');
    expect(JSON.parse(writeOut).error).toMatch(/unavailable in plan mode/);
  });

  it("readOnlyCheck takes precedence over readOnly when both are set", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "mixed",
      readOnly: false,
      readOnlyCheck: () => true,
      fn: () => "ran",
    });
    reg.setPlanMode(true);
    const out = await reg.dispatch("mixed", "{}");
    expect(out).toBe("ran");
  });

  it("with plan mode off, readOnly flags don't interfere", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "normal",
      fn: () => "ran",
    });
    expect(reg.planMode).toBe(false);
    const out = await reg.dispatch("normal", "{}");
    expect(out).toBe("ran");
  });

  it("serializes errors via toToolResult when the thrown error implements it", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "structured_err",
      fn: () => {
        const err = new Error("oops") as Error & { toToolResult?: () => unknown };
        err.name = "StructuredError";
        err.toToolResult = () => ({ error: "StructuredError: oops", extra: "pinned-out-of-band" });
        throw err;
      },
    });
    const out = await reg.dispatch("structured_err", "{}");
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe("StructuredError: oops");
    expect(parsed.extra).toBe("pinned-out-of-band");
  });

  it("falls back to the default error shape when toToolResult throws", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "broken_serializer",
      fn: () => {
        const err = new Error("base-message") as Error & { toToolResult?: () => unknown };
        err.name = "Broken";
        err.toToolResult = () => {
          throw new Error("serialization failed");
        };
        throw err;
      },
    });
    const out = await reg.dispatch("broken_serializer", "{}");
    expect(JSON.parse(out).error).toBe("Broken: base-message");
  });
});

describe("PlanProposedError", () => {
  it("carries the plan on the instance and in toToolResult()", () => {
    const err = new PlanProposedError("# Plan\n- step 1\n- step 2");
    expect(err.name).toBe("PlanProposedError");
    expect(err.plan).toBe("# Plan\n- step 1\n- step 2");
    const payload = err.toToolResult();
    expect(payload.plan).toBe("# Plan\n- step 1\n- step 2");
    expect(payload.error).toMatch(/^PlanProposedError:/);
    // Message tells the model to STOP so it doesn't keep calling tools.
    expect(payload.error).toMatch(/STOP/);
  });
});

describe("registerPlanTool + submit_plan", () => {
  it("registers submit_plan as readOnly so it passes the plan-mode gate", () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    expect(reg.has("submit_plan")).toBe(true);
    expect(reg.get("submit_plan")?.readOnly).toBe(true);
  });

  it("throws PlanProposedError when called with a plan (plan mode ON)", async () => {
    const reg = new ToolRegistry();
    const submitted: string[] = [];
    registerPlanTool(reg, { onPlanSubmitted: (p) => submitted.push(p) });
    reg.setPlanMode(true);
    const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "# Plan\n- A" }));
    const parsed = JSON.parse(out);
    expect(parsed.plan).toBe("# Plan\n- A");
    expect(parsed.error).toMatch(/PlanProposedError/);
    expect(submitted).toEqual(["# Plan\n- A"]);
  });

  it("also fires the picker when plan mode is OFF — autonomous proposals", async () => {
    const reg = new ToolRegistry();
    const submitted: string[] = [];
    registerPlanTool(reg, { onPlanSubmitted: (p) => submitted.push(p) });
    // Plan mode intentionally NOT enabled.
    const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "big refactor plan" }));
    const parsed = JSON.parse(out);
    expect(parsed.plan).toBe("big refactor plan");
    expect(parsed.error).toMatch(/PlanProposedError/);
    expect(submitted).toEqual(["big refactor plan"]);
  });

  it("rejects an empty plan with a helpful message", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    reg.setPlanMode(true);
    const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "   \n\n  " }));
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/empty plan/);
    // Empty-plan is a regular Error, not PlanProposedError — so there's
    // no `plan` field.
    expect(parsed.plan).toBeUndefined();
  });

  it("trims surrounding whitespace from the plan", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    reg.setPlanMode(true);
    const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "\n\n  trimmed  \n" }));
    expect(JSON.parse(out).plan).toBe("trimmed");
  });

  it("carries an optional summary through toToolResult", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    reg.setPlanMode(true);
    const out = await reg.dispatch(
      "submit_plan",
      JSON.stringify({ plan: "# Plan", summary: "Refactor auth into signed tokens" }),
    );
    expect(JSON.parse(out).summary).toBe("Refactor auth into signed tokens");
  });

  it("omits summary when blank / whitespace-only", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    reg.setPlanMode(true);
    const out = await reg.dispatch(
      "submit_plan",
      JSON.stringify({ plan: "# Plan", summary: "   " }),
    );
    expect(JSON.parse(out).summary).toBeUndefined();
  });

  it("accepts an optional steps array and surfaces it in the tool result", async () => {
    const reg = new ToolRegistry();
    const submitted: Array<{ plan: string; steps?: unknown }> = [];
    registerPlanTool(reg, {
      onPlanSubmitted: (plan, steps) => submitted.push({ plan, steps }),
    });
    reg.setPlanMode(true);
    const steps = [
      { id: "step-1", title: "Refactor auth", action: "Extract tokens into a module." },
      {
        id: "step-2",
        title: "Update tests",
        action: "Rewrite auth.test.ts to use the new module.",
      },
    ];
    const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "# Plan", steps }));
    const parsed = JSON.parse(out);
    expect(parsed.steps).toEqual(steps);
    expect(submitted[0]?.steps).toEqual(steps);
  });

  it("drops malformed step entries and omits steps entirely when none remain", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    reg.setPlanMode(true);
    const out = await reg.dispatch(
      "submit_plan",
      JSON.stringify({
        plan: "# Plan",
        steps: [
          { id: "", title: "missing id", action: "a" },
          { id: "x", title: "", action: "a" },
          { id: "y", title: "t", action: "" },
          "not-an-object",
          null,
        ],
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.steps).toBeUndefined();
  });

  it("accepts and preserves valid risk levels on steps", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    reg.setPlanMode(true);
    const out = await reg.dispatch(
      "submit_plan",
      JSON.stringify({
        plan: "# Plan",
        steps: [
          { id: "step-1", title: "safe", action: "local edit", risk: "low" },
          { id: "step-2", title: "medium", action: "multi-file edit", risk: "med" },
          { id: "step-3", title: "risky", action: "prod migration", risk: "high" },
        ],
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.steps).toEqual([
      { id: "step-1", title: "safe", action: "local edit", risk: "low" },
      { id: "step-2", title: "medium", action: "multi-file edit", risk: "med" },
      { id: "step-3", title: "risky", action: "prod migration", risk: "high" },
    ]);
  });

  it("drops malformed risk values rather than letting them through", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    reg.setPlanMode(true);
    const out = await reg.dispatch(
      "submit_plan",
      JSON.stringify({
        plan: "# Plan",
        steps: [
          { id: "step-1", title: "a", action: "b", risk: "critical" },
          { id: "step-2", title: "c", action: "d", risk: 3 },
          { id: "step-3", title: "e", action: "f" },
        ],
      }),
    );
    const parsed = JSON.parse(out);
    // "critical" and 3 are rejected → risk field omitted; step-3 had
    // no risk to begin with. All three steps survive (the step itself
    // was well-formed; only the bad risk got dropped).
    expect(parsed.steps).toEqual([
      { id: "step-1", title: "a", action: "b" },
      { id: "step-2", title: "c", action: "d" },
      { id: "step-3", title: "e", action: "f" },
    ]);
  });

  it("keeps only the well-formed steps when the array is mixed", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    reg.setPlanMode(true);
    const out = await reg.dispatch(
      "submit_plan",
      JSON.stringify({
        plan: "# Plan",
        steps: [
          { id: "step-1", title: "good", action: "do thing" },
          { id: "", title: "bad", action: "x" },
          { id: "step-2", title: "also good", action: "do other thing" },
        ],
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.steps).toEqual([
      { id: "step-1", title: "good", action: "do thing" },
      { id: "step-2", title: "also good", action: "do other thing" },
    ]);
  });
});

describe("registerPlanTool + mark_step_complete", () => {
  it("registers mark_step_complete as readOnly (safe during plan mode)", () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    expect(reg.has("mark_step_complete")).toBe(true);
    expect(reg.get("mark_step_complete")?.readOnly).toBe(true);
  });

  it("throws PlanCheckpointError with the step_completed payload and fires onStepCompleted", async () => {
    const reg = new ToolRegistry();
    const seen: unknown[] = [];
    registerPlanTool(reg, { onStepCompleted: (u) => seen.push(u) });
    const out = await reg.dispatch(
      "mark_step_complete",
      JSON.stringify({
        stepId: "step-1",
        title: "Refactor auth",
        result: "Moved tokens into src/auth/tokens.ts.",
        notes: "Had to rename one export.",
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.kind).toBe("step_completed");
    expect(parsed.stepId).toBe("step-1");
    expect(parsed.title).toBe("Refactor auth");
    expect(parsed.result).toBe("Moved tokens into src/auth/tokens.ts.");
    expect(parsed.notes).toBe("Had to rename one export.");
    expect(parsed.error).toMatch(/^PlanCheckpointError:/);
    // STOP instruction — same pattern as PlanProposedError so the
    // model doesn't race past the picker with more tool calls.
    expect(parsed.error).toMatch(/STOP/);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { stepId: string }).stepId).toBe("step-1");
  });

  it("omits optional fields when empty", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    const out = await reg.dispatch(
      "mark_step_complete",
      JSON.stringify({ stepId: "step-1", result: "done" }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.title).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
    expect(parsed.result).toBe("done");
    expect(parsed.error).toMatch(/^PlanCheckpointError:/);
  });

  it("rejects an empty stepId", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    const out = await reg.dispatch(
      "mark_step_complete",
      JSON.stringify({ stepId: "  ", result: "done" }),
    );
    expect(JSON.parse(out).error).toMatch(/stepId is required/);
  });

  it("rejects an empty result with a pointer at what to write", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    const out = await reg.dispatch(
      "mark_step_complete",
      JSON.stringify({ stepId: "step-1", result: "   " }),
    );
    expect(JSON.parse(out).error).toMatch(/result is required/);
  });
});

describe("PlanCheckpointError", () => {
  it("carries the step payload on the instance and in toToolResult()", () => {
    const err = new PlanCheckpointError({
      stepId: "step-2",
      title: "Update tests",
      result: "Rewrote three suites.",
      notes: "One test still flaky.",
    });
    expect(err.name).toBe("PlanCheckpointError");
    expect(err.stepId).toBe("step-2");
    expect(err.title).toBe("Update tests");
    expect(err.result).toBe("Rewrote three suites.");
    expect(err.notes).toBe("One test still flaky.");
    const payload = err.toToolResult();
    expect(payload.kind).toBe("step_completed");
    expect(payload.stepId).toBe("step-2");
    expect(payload.error).toMatch(/^PlanCheckpointError:/);
    expect(payload.error).toMatch(/STOP/);
  });

  it("omits title/notes from toToolResult when they weren't supplied", () => {
    const err = new PlanCheckpointError({ stepId: "step-1", result: "done" });
    const payload = err.toToolResult();
    expect(payload.title).toBeUndefined();
    expect(payload.notes).toBeUndefined();
    expect(payload.result).toBe("done");
  });
});

describe("PlanRevisionProposedError", () => {
  it("carries reason / remainingSteps / summary on the instance and in toToolResult()", () => {
    const err = new PlanRevisionProposedError(
      "User asked to skip cookie migration.",
      [
        { id: "step-3", title: "Skip migration", action: "Document the skip", risk: "low" },
        { id: "step-4", title: "Update tests", action: "Adjust suite", risk: "med" },
      ],
      "Refactor without prod migration",
    );
    expect(err.name).toBe("PlanRevisionProposedError");
    expect(err.remainingSteps).toHaveLength(2);
    const payload = err.toToolResult();
    expect(payload.reason).toBe("User asked to skip cookie migration.");
    expect(payload.summary).toBe("Refactor without prod migration");
    expect(payload.remainingSteps).toHaveLength(2);
    expect(payload.error).toMatch(/^PlanRevisionProposedError:/);
    expect(payload.error).toMatch(/STOP/);
  });

  it("omits summary from toToolResult when not provided", () => {
    const err = new PlanRevisionProposedError("a reason", [{ id: "x", title: "y", action: "z" }]);
    expect(err.toToolResult().summary).toBeUndefined();
  });
});

describe("registerPlanTool + revise_plan", () => {
  it("registers revise_plan as readOnly (it only emits a proposal, no side effects)", () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    expect(reg.has("revise_plan")).toBe(true);
    expect(reg.get("revise_plan")?.readOnly).toBe(true);
  });

  it("throws PlanRevisionProposedError with the structured payload", async () => {
    const reg = new ToolRegistry();
    const seen: Array<{ reason: string; steps: number }> = [];
    registerPlanTool(reg, {
      onPlanRevisionProposed: (reason, steps) => seen.push({ reason, steps: steps.length }),
    });
    const out = await reg.dispatch(
      "revise_plan",
      JSON.stringify({
        reason: "User asked to skip step 3.",
        remainingSteps: [
          { id: "step-3", title: "skip", action: "do nothing", risk: "low" },
          { id: "step-4", title: "tests", action: "update", risk: "med" },
        ],
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.reason).toBe("User asked to skip step 3.");
    expect(parsed.remainingSteps).toHaveLength(2);
    expect(parsed.error).toMatch(/^PlanRevisionProposedError:/);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.steps).toBe(2);
  });

  it("rejects empty reason", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    const out = await reg.dispatch(
      "revise_plan",
      JSON.stringify({
        reason: "  ",
        remainingSteps: [{ id: "x", title: "y", action: "z" }],
      }),
    );
    expect(JSON.parse(out).error).toMatch(/reason is required/);
  });

  it("rejects empty remainingSteps array", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    const out = await reg.dispatch(
      "revise_plan",
      JSON.stringify({ reason: "skip everything", remainingSteps: [] }),
    );
    expect(JSON.parse(out).error).toMatch(/non-empty array/);
  });

  it("rejects when sanitization drops all steps", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    const out = await reg.dispatch(
      "revise_plan",
      JSON.stringify({
        reason: "ok",
        remainingSteps: [
          { id: "", title: "no id", action: "x" },
          { id: "x", title: "", action: "x" },
          { id: "y", title: "z", action: "" },
          "not-an-object",
        ],
      }),
    );
    expect(JSON.parse(out).error).toMatch(/non-empty array/);
  });

  it("preserves valid risk levels through revision", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    const out = await reg.dispatch(
      "revise_plan",
      JSON.stringify({
        reason: "tighten",
        remainingSteps: [
          { id: "a", title: "t", action: "a", risk: "high" },
          { id: "b", title: "t", action: "a", risk: "low" },
        ],
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.remainingSteps[0].risk).toBe("high");
    expect(parsed.remainingSteps[1].risk).toBe("low");
  });

  it("includes an optional summary when provided", async () => {
    const reg = new ToolRegistry();
    registerPlanTool(reg);
    const out = await reg.dispatch(
      "revise_plan",
      JSON.stringify({
        reason: "ok",
        remainingSteps: [{ id: "x", title: "y", action: "z" }],
        summary: "Refactor without migration",
      }),
    );
    expect(JSON.parse(out).summary).toBe("Refactor without migration");
  });
});
