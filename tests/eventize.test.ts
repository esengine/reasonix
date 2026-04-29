import { describe, expect, it } from "vitest";
import { Eventizer } from "../src/core/eventize.js";
import type { LoopEvent } from "../src/loop.js";

const ctx = { model: "deepseek-v4-flash", prefixHash: "abc123", reasoningEffort: "max" } as const;

const lev = (partial: Partial<LoopEvent>): LoopEvent =>
  ({ turn: 1, role: "status", content: "", ...partial }) as LoopEvent;

describe("Eventizer.consume", () => {
  it("synthesizes model.turn.started on first event of a new turn", () => {
    const e = new Eventizer();
    const out = e.consume(lev({ turn: 1, role: "status", content: "thinking" }), ctx);
    expect(out[0]?.type).toBe("model.turn.started");
    expect(out[1]?.type).toBe("status");
  });

  it("does not re-emit turn.started for events within the same turn", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1, role: "status", content: "a" }), ctx);
    const out = e.consume(lev({ turn: 1, role: "status", content: "b" }), ctx);
    expect(out.find((ev) => ev.type === "model.turn.started")).toBeUndefined();
  });

  it("emits a fresh turn.started when the turn number advances", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const out = e.consume(lev({ turn: 2, role: "status", content: "go" }), ctx);
    expect(out[0]?.type).toBe("model.turn.started");
  });

  it("splits assistant_delta into content + reasoning channels", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx); // burn turn-start
    const out = e.consume(
      lev({
        turn: 1,
        role: "assistant_delta",
        content: "hello",
        reasoningDelta: "thinking…",
      }),
      ctx,
    );
    const channels = out
      .filter((ev) => ev.type === "model.delta")
      .map((ev) => (ev as { channel: string }).channel);
    expect(channels).toEqual(["content", "reasoning"]);
  });

  it("tool_start emits both tool.intent and tool.dispatched with matching callId", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const out = e.consume(
      lev({ turn: 1, role: "tool_start", toolName: "shell", toolArgs: '{"cmd":"ls"}' }),
      ctx,
    );
    const intent = out.find((ev) => ev.type === "tool.intent") as
      | { callId: string; name: string; args: string }
      | undefined;
    const dispatched = out.find((ev) => ev.type === "tool.dispatched") as
      | { callId: string }
      | undefined;
    expect(intent?.name).toBe("shell");
    expect(intent?.args).toBe('{"cmd":"ls"}');
    expect(dispatched?.callId).toBe(intent?.callId);
  });

  it("tool result correlates back to the matching dispatched callId", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const startOut = e.consume(
      lev({ turn: 1, role: "tool_start", toolName: "shell", toolArgs: "{}" }),
      ctx,
    );
    const startedCallId = (startOut.find((ev) => ev.type === "tool.intent") as { callId: string })
      .callId;
    const resultOut = e.consume(
      lev({ turn: 1, role: "tool", content: "ok\n", toolName: "shell" }),
      ctx,
    );
    const result = resultOut.find((ev) => ev.type === "tool.result") as
      | { callId: string; ok: boolean; output: string }
      | undefined;
    expect(result?.callId).toBe(startedCallId);
    expect(result?.ok).toBe(true);
    expect(result?.output).toBe("ok\n");
  });

  it("classifies error-shaped tool results as ok=false", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    e.consume(lev({ turn: 1, role: "tool_start", toolName: "shell", toolArgs: "{}" }), ctx);
    const out = e.consume(
      lev({ turn: 1, role: "tool", content: "ERROR: bad command", toolName: "shell" }),
      ctx,
    );
    const result = out.find((ev) => ev.type === "tool.result") as { ok: boolean } | undefined;
    expect(result?.ok).toBe(false);
  });

  it("done and tool_call_delta produce no kernel events (control / progress markers)", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const doneOut = e.consume(lev({ turn: 1, role: "done", content: "" }), ctx);
    const tcdOut = e.consume(
      lev({ turn: 1, role: "tool_call_delta", content: "", toolName: "shell" }),
      ctx,
    );
    expect(doneOut).toEqual([]);
    expect(tcdOut).toEqual([]);
  });

  it("warning containing escalation language maps to policy.escalated", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const out = e.consume(
      lev({ turn: 1, role: "warning", content: "⇧ auto-escalating to deepseek-v4-pro" }),
      ctx,
    );
    expect(out[0]?.type).toBe("policy.escalated");
  });

  it("event ids are monotonic across consume calls", () => {
    const e = new Eventizer();
    const a = e.consume(lev({ turn: 1, role: "status", content: "a" }), ctx);
    const b = e.consume(lev({ turn: 1, role: "status", content: "b" }), ctx);
    const ids = [...a, ...b].map((ev) => ev.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
    }
  });

  it("emitUserMessage / emitSlashInvoked produce well-formed events with monotonic ids", () => {
    const e = new Eventizer();
    e.consume(lev({ turn: 1 }), ctx);
    const u = e.emitUserMessage(2, "hi");
    const s = e.emitSlashInvoked(2, "context", "off");
    expect(u.type).toBe("user.message");
    expect(u.text).toBe("hi");
    expect(s.type).toBe("slash.invoked");
    expect(s.name).toBe("context");
    expect(s.args).toBe("off");
    expect(s.id).toBeGreaterThan(u.id);
  });
});
