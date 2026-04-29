import { describe, expect, it } from "vitest";
import type { Event } from "../src/core/events.js";
import {
  apply,
  budget,
  capabilities,
  conversation,
  emptyBudget,
  emptyCapabilities,
  emptyConversation,
  emptyPlan,
  emptyProjections,
  emptySessionMeta,
  emptyStatus,
  emptyWorkspace,
  plan,
  replay,
  sessionMeta,
  status,
  workspace,
} from "../src/core/reducers.js";

const ts = "2026-04-29T12:00:00Z";
let nextId = 0;
const ev = <T extends Event>(e: Omit<T, "id"> & { id?: number }): T =>
  ({ ...e, id: e.id ?? ++nextId }) as T;

describe("conversation reducer", () => {
  it("appends user message", () => {
    const v = conversation(
      emptyConversation(),
      ev<Event>({ type: "user.message", ts, turn: 1, text: "hi" }),
    );
    expect(v.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("appends assistant final with tool_calls and reasoning", () => {
    const v = conversation(
      emptyConversation(),
      ev<Event>({
        type: "model.final",
        ts,
        turn: 1,
        content: "ok",
        reasoningContent: "thinking",
        toolCalls: [{ id: "c1", function: { name: "shell", arguments: "{}" } }],
        usage: {},
        costUsd: 0,
      }),
    );
    expect(v.messages[0]).toEqual({
      role: "assistant",
      content: "ok",
      reasoning_content: "thinking",
      tool_calls: [{ id: "c1", function: { name: "shell", arguments: "{}" } }],
    });
  });

  it("tool.intent → pending; tool.result → tool msg + pending cleared", () => {
    let v = emptyConversation();
    v = conversation(
      v,
      ev<Event>({ type: "tool.intent", ts, turn: 1, callId: "c1", name: "shell", args: "{}" }),
    );
    expect(v.pendingToolCalls).toEqual([{ callId: "c1", name: "shell" }]);
    v = conversation(
      v,
      ev<Event>({
        type: "tool.result",
        ts,
        turn: 1,
        callId: "c1",
        ok: true,
        output: "done",
        durationMs: 5,
      }),
    );
    expect(v.pendingToolCalls).toEqual([]);
    expect(v.messages).toEqual([{ role: "tool", content: "done", tool_call_id: "c1" }]);
  });

  it("tool.denied removes pending and writes denial message", () => {
    let v = emptyConversation();
    v = conversation(
      v,
      ev<Event>({ type: "tool.intent", ts, turn: 1, callId: "c1", name: "shell", args: "" }),
    );
    v = conversation(
      v,
      ev<Event>({ type: "tool.denied", ts, turn: 1, callId: "c1", reason: "permission" }),
    );
    expect(v.pendingToolCalls).toEqual([]);
    expect(v.messages).toEqual([
      { role: "tool", content: "denied: permission", tool_call_id: "c1" },
    ]);
  });

  it("session.compacted REPLACES messages and clears pending", () => {
    let v = emptyConversation();
    v = conversation(v, ev<Event>({ type: "user.message", ts, turn: 1, text: "old" }));
    v = conversation(
      v,
      ev<Event>({ type: "tool.intent", ts, turn: 1, callId: "c1", name: "shell", args: "" }),
    );
    v = conversation(
      v,
      ev<Event>({
        type: "session.compacted",
        ts,
        turn: 2,
        beforeMessages: 5,
        afterMessages: 1,
        reason: "user",
        replacementMessages: [{ role: "system", content: "summary" }],
      }),
    );
    expect(v.messages).toEqual([{ role: "system", content: "summary" }]);
    expect(v.pendingToolCalls).toEqual([]);
  });
});

describe("budget reducer", () => {
  it("accumulates cost and token usage from model.final", () => {
    let v = emptyBudget(10);
    v = budget(
      v,
      ev<Event>({
        type: "model.final",
        ts,
        turn: 1,
        content: "",
        toolCalls: [],
        usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 80 },
        costUsd: 0.002,
      }),
    );
    v = budget(
      v,
      ev<Event>({
        type: "model.final",
        ts,
        turn: 2,
        content: "",
        toolCalls: [],
        usage: { prompt_tokens: 200, prompt_cache_miss_tokens: 200 },
        costUsd: 0.005,
      }),
    );
    expect(v.spentUsd).toBeCloseTo(0.007);
    expect(v.promptTokens).toBe(300);
    expect(v.completionTokens).toBe(50);
    expect(v.cacheHitTokens).toBe(80);
    expect(v.cacheMissTokens).toBe(200);
    expect(v.capUsd).toBe(10);
  });

  it("warned and blocked latch", () => {
    let v = emptyBudget(1);
    v = budget(
      v,
      ev<Event>({ type: "policy.budget.warning", ts, turn: 1, spentUsd: 0.8, capUsd: 1 }),
    );
    v = budget(v, ev<Event>({ type: "user.message", ts, turn: 2, text: "ignored" }));
    expect(v.warned).toBe(true);
    v = budget(
      v,
      ev<Event>({ type: "policy.budget.blocked", ts, turn: 2, spentUsd: 1.05, capUsd: 1 }),
    );
    expect(v.blocked).toBe(true);
  });
});

describe("plan reducer", () => {
  it("submitted populates steps as not-completed", () => {
    const v = plan(
      emptyPlan(),
      ev<Event>({
        type: "plan.submitted",
        ts,
        turn: 3,
        steps: [
          { id: "a", title: "A", action: "do A", risk: "low" },
          { id: "b", title: "B", action: "do B" },
        ],
        body: "## plan",
      }),
    );
    expect(v.submittedTurn).toBe(3);
    expect(v.steps).toEqual([
      { id: "a", title: "A", action: "do A", risk: "low", completed: false },
      { id: "b", title: "B", action: "do B", risk: undefined, completed: false },
    ]);
  });

  it("step.completed marks only the target", () => {
    let v = plan(
      emptyPlan(),
      ev<Event>({
        type: "plan.submitted",
        ts,
        turn: 1,
        steps: [
          { id: "a", title: "A", action: "" },
          { id: "b", title: "B", action: "" },
        ],
        body: "",
      }),
    );
    v = plan(
      v,
      ev<Event>({
        type: "plan.step.completed",
        ts,
        turn: 2,
        stepId: "b",
        notes: "ok",
        completion: { kind: "step_completed", stepId: "b", result: "ok" },
      }),
    );
    expect(v.steps.find((s) => s.id === "a")?.completed).toBe(false);
    expect(v.steps.find((s) => s.id === "b")?.completed).toBe(true);
    expect(v.steps.find((s) => s.id === "b")?.notes).toBe("ok");
  });

  it("step.completed with unknown id is a no-op", () => {
    const before = plan(
      emptyPlan(),
      ev<Event>({
        type: "plan.submitted",
        ts,
        turn: 1,
        steps: [{ id: "a", title: "A", action: "" }],
        body: "",
      }),
    );
    const after = plan(
      before,
      ev<Event>({
        type: "plan.step.completed",
        ts,
        turn: 2,
        stepId: "ghost",
        completion: { kind: "step_completed", stepId: "ghost", result: "" },
      }),
    );
    expect(after).toBe(before);
  });
});

describe("workspace reducer", () => {
  it("file.touched upsert; same path replaces mode", () => {
    let v = workspace(
      emptyWorkspace(),
      ev<Event>({
        type: "effect.file.touched",
        ts,
        turn: 1,
        path: "a.ts",
        mode: "create",
        bytes: 10,
      }),
    );
    v = workspace(
      v,
      ev<Event>({
        type: "effect.file.touched",
        ts,
        turn: 2,
        path: "a.ts",
        mode: "edit",
        bytes: 12,
      }),
    );
    v = workspace(
      v,
      ev<Event>({
        type: "effect.file.touched",
        ts,
        turn: 2,
        path: "b.ts",
        mode: "create",
        bytes: 5,
      }),
    );
    expect(v.filesTouched.get("a.ts")).toBe("edit");
    expect(v.filesTouched.get("b.ts")).toBe("create");
  });

  it("checkpoint.created sets lastCheckpointId", () => {
    const v = workspace(
      emptyWorkspace(),
      ev<Event>({
        type: "checkpoint.created",
        ts,
        turn: 1,
        checkpointId: "cp-1",
        name: "wip",
        source: "manual",
        fileCount: 2,
        bytes: 100,
      }),
    );
    expect(v.lastCheckpointId).toBe("cp-1");
  });
});

describe("capabilities reducer", () => {
  it("register / re-register replaces; remove drops", () => {
    let v = capabilities(
      emptyCapabilities(),
      ev<Event>({ type: "capability.registered", ts, turn: 1, name: "shell", permission: "ask" }),
    );
    v = capabilities(
      v,
      ev<Event>({ type: "capability.registered", ts, turn: 1, name: "shell", permission: "allow" }),
    );
    v = capabilities(
      v,
      ev<Event>({ type: "capability.registered", ts, turn: 1, name: "fs", permission: "ask" }),
    );
    expect(v.tools).toEqual([
      { name: "shell", permission: "allow" },
      { name: "fs", permission: "ask" },
    ]);
    v = capabilities(v, ev<Event>({ type: "capability.removed", ts, turn: 2, name: "shell" }));
    expect(v.tools).toEqual([{ name: "fs", permission: "ask" }]);
  });
});

describe("status reducer", () => {
  it("status sets text; primary event clears it", () => {
    let v = status(emptyStatus(), ev<Event>({ type: "status", ts, turn: 1, text: "harvesting" }));
    expect(v.current).toBe("harvesting");
    v = status(v, ev<Event>({ type: "model.delta", ts, turn: 1, channel: "content", text: "x" }));
    expect(v.current).toBeNull();
  });

  it("non-primary event preserves status", () => {
    let v = status(emptyStatus(), ev<Event>({ type: "status", ts, turn: 1, text: "thinking" }));
    v = status(v, ev<Event>({ type: "user.message", ts, turn: 1, text: "later" }));
    expect(v.current).toBe("thinking");
  });
});

describe("sessionMeta reducer", () => {
  it("session.opened sets name + openedAt; turn tracks max", () => {
    let v = sessionMeta(
      emptySessionMeta(),
      ev<Event>({ type: "session.opened", ts, turn: 5, name: "wip", resumedFromTurn: 4 }),
    );
    expect(v.name).toBe("wip");
    expect(v.openedAt).toBe(ts);
    expect(v.currentTurn).toBe(5);
    v = sessionMeta(v, ev<Event>({ type: "user.message", ts, turn: 7, text: "q" }));
    expect(v.currentTurn).toBe(7);
    v = sessionMeta(v, ev<Event>({ type: "user.message", ts, turn: 6, text: "stale" }));
    expect(v.currentTurn).toBe(7);
  });

  it("error event records lastError", () => {
    const v = sessionMeta(
      emptySessionMeta(),
      ev<Event>({ type: "error", ts, turn: 1, message: "boom", recoverable: true }),
    );
    expect(v.lastError).toBe("boom");
  });
});

describe("replay determinism", () => {
  it("same events twice → same projections", () => {
    const events: Event[] = [
      ev<Event>({ type: "session.opened", ts, turn: 1, name: "s", resumedFromTurn: 0 }),
      ev<Event>({ type: "user.message", ts, turn: 1, text: "hi" }),
      ev<Event>({
        type: "model.final",
        ts,
        turn: 1,
        content: "",
        toolCalls: [{ id: "c1", function: { name: "shell", arguments: "{}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        costUsd: 0.001,
      }),
      ev<Event>({ type: "tool.intent", ts, turn: 1, callId: "c1", name: "shell", args: "{}" }),
      ev<Event>({ type: "tool.dispatched", ts, turn: 1, callId: "c1" }),
      ev<Event>({
        type: "tool.result",
        ts,
        turn: 1,
        callId: "c1",
        ok: true,
        output: "done",
        durationMs: 3,
      }),
    ];
    const a = replay(events, 5);
    const b = replay(events, 5);
    expect(a).toEqual(b);
    expect(a.conversation.messages).toHaveLength(3);
    expect(a.conversation.pendingToolCalls).toHaveLength(0);
    expect(a.budget.spentUsd).toBeCloseTo(0.001);
    expect(a.budget.capUsd).toBe(5);
    expect(a.session.currentTurn).toBe(1);
  });

  it("apply composes all reducers", () => {
    const e: Event = ev<Event>({
      type: "checkpoint.created",
      ts,
      turn: 1,
      checkpointId: "cp-x",
      name: "wip",
      source: "manual",
      fileCount: 0,
      bytes: 0,
    });
    const next = apply(emptyProjections(), e);
    expect(next.workspace.lastCheckpointId).toBe("cp-x");
    expect(next.session.currentTurn).toBe(1);
  });
});
