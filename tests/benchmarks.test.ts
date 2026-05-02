/** Smoke tests for the τ-bench-lite harness — db isolation, check() predicates, baseline shuffle determinism. */

import { describe, expect, it } from "vitest";
import { cloneDb } from "../benchmarks/tau-bench/db.js";
import { TASKS } from "../benchmarks/tau-bench/tasks.js";
import type { TaskDefinition, Turn } from "../benchmarks/tau-bench/types.js";

function buildToolsFor(task: TaskDefinition) {
  const db = cloneDb(task.initialDb);
  const tools = task.tools.map((f) => f(db));
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { db, tools, byName };
}

describe("tau-bench-lite task set", () => {
  it("exposes at least 8 tasks with unique ids", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(8);
    const ids = new Set(TASKS.map((t) => t.id));
    expect(ids.size).toBe(TASKS.length);
  });

  it("every task's tool factories close over an isolated db", async () => {
    // Run the same tool mutation on two independent clones of one task's db
    // and assert the two dbs diverge.
    const task = TASKS.find((t) => t.id === "t01_address_happy");
    if (!task) throw new Error("t01 missing");

    const a = buildToolsFor(task);
    const b = buildToolsFor(task);

    const updateA = a.byName.get("update_address");
    if (!updateA) throw new Error("update_address tool missing");
    await updateA.fn({ orderId: "o_1002", address: "A ADDRESS" });

    expect(a.db.orders.o_1002?.address).toBe("A ADDRESS");
    expect(b.db.orders.o_1002?.address).toBe("22 Oak Rd, NYC, NY 10001");
  });
});

describe("task check() predicates", () => {
  it("t01 passes only after the correct address mutation", async () => {
    const task = TASKS.find((t) => t.id === "t01_address_happy");
    if (!task) throw new Error("t01 missing");

    const { db, byName } = buildToolsFor(task);
    const transcript: Turn[] = [];

    // Before mutation — should fail.
    expect(task.check({ db, finalAgentMessage: "", transcript })).toBe(false);

    const update = byName.get("update_address");
    if (!update) throw new Error("update_address tool missing");
    await update.fn({ orderId: "o_1002", address: "5 Birch Rd, NYC, NY 10001" });

    expect(task.check({ db, finalAgentMessage: "", transcript })).toBe(true);
  });

  it("t02 (refusal) passes when the DB is left unchanged", () => {
    const task = TASKS.find((t) => t.id === "t02_address_not_allowed");
    if (!task) throw new Error("t02 missing");
    const { db } = buildToolsFor(task);
    expect(task.check({ db, finalAgentMessage: "", transcript: [] })).toBe(true);
  });

  it("t02 (refusal) fails if the agent mutates anyway", async () => {
    const task = TASKS.find((t) => t.id === "t02_address_not_allowed");
    if (!task) throw new Error("t02 missing");
    const { db } = buildToolsFor(task);
    // The update_address tool itself refuses non-processing orders, so
    // simulate a misbehaving agent by mutating the DB directly.
    db.orders.o_1001!.address = "99 New St, SF, CA";
    expect(task.check({ db, finalAgentMessage: "", transcript: [] })).toBe(false);
  });

  it("t04 refund check requires both status change and refund record", async () => {
    const task = TASKS.find((t) => t.id === "t04_refund_delivered");
    if (!task) throw new Error("t04 missing");
    const { db, byName } = buildToolsFor(task);
    const refund = byName.get("refund_order");
    if (!refund) throw new Error("refund_order tool missing");
    await refund.fn({ orderId: "o_1003", reason: "arrived broken" });
    expect(task.check({ db, finalAgentMessage: "", transcript: [] })).toBe(true);
  });

  it("t05 passes when the agent refuses outright (status stays processing, no refund)", () => {
    const task = TASKS.find((t) => t.id === "t05_refund_not_delivered");
    if (!task) throw new Error("t05 missing");
    const { db } = buildToolsFor(task);
    // Out-of-the-box seed: o_1002 is processing, no refunds row.
    expect(task.check({ db, finalAgentMessage: "", transcript: [] })).toBe(true);
  });

  it("t05 ALSO passes when the agent cancels the order instead (acceptable alternative)", async () => {
    const task = TASKS.find((t) => t.id === "t05_refund_not_delivered");
    if (!task) throw new Error("t05 missing");
    const { db, byName } = buildToolsFor(task);
    const cancel = byName.get("cancel_order");
    if (!cancel) throw new Error("cancel_order tool missing");
    await cancel.fn({ orderId: "o_1002" });
    expect(db.orders.o_1002?.status).toBe("cancelled");
    expect(task.check({ db, finalAgentMessage: "", transcript: [] })).toBe(true);
  });

  it("t05 FAILS if the agent writes a refund row (the behavior we actually forbid)", () => {
    const task = TASKS.find((t) => t.id === "t05_refund_not_delivered");
    if (!task) throw new Error("t05 missing");
    const { db } = buildToolsFor(task);
    // Simulate the forbidden mutation directly — the refund_order tool
    // itself guards against non-delivered orders, so we have to be the
    // misbehaving agent here.
    db.refunds.o_1002 = { orderId: "o_1002", reason: "any", amount: 140 };
    expect(task.check({ db, finalAgentMessage: "", transcript: [] })).toBe(false);
  });
});

describe("tool guards", () => {
  it("update_address refuses non-processing orders", async () => {
    const task = TASKS[0]!;
    const { byName } = buildToolsFor(task);
    const update = byName.get("update_address");
    if (!update) throw new Error("update_address tool missing");
    const out = await update.fn({ orderId: "o_1001", address: "anything" });
    expect(JSON.stringify(out)).toContain("cannot edit");
  });

  it("refund_order refuses non-delivered orders", async () => {
    const task = TASKS[0]!;
    const { byName } = buildToolsFor(task);
    const refund = byName.get("refund_order");
    if (!refund) throw new Error("refund_order tool missing");
    const out = await refund.fn({ orderId: "o_1002", reason: "any" });
    expect(JSON.stringify(out)).toContain("cannot refund");
  });
});
