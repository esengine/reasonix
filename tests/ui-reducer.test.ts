import { describe, expect, it } from "vitest";
import type { ReasoningCard, StreamingCard, UserCard } from "../src/cli/ui/state/cards.js";
import type { AgentEvent } from "../src/cli/ui/state/events.js";
import { parseEvent } from "../src/cli/ui/state/events.js";
import { reduce } from "../src/cli/ui/state/reducer.js";
import { type AgentState, type SessionInfo, initialState } from "../src/cli/ui/state/state.js";

const session: SessionInfo = {
  id: "test-session",
  branch: "main",
  workspace: "/tmp/repo",
  model: "deepseek-chat",
};

function run(events: AgentEvent[], from: AgentState = initialState(session)): AgentState {
  return events.reduce(reduce, from);
}

describe("ui reducer", () => {
  it("appends a user card on user.submit", () => {
    const s = run([{ type: "user.submit", text: "hello world" }]);
    expect(s.cards).toHaveLength(1);
    const card = s.cards[0] as UserCard;
    expect(card.kind).toBe("user");
    expect(card.text).toBe("hello world");
  });

  it("streams reasoning chunks into a single card", () => {
    const s = run([
      { type: "reasoning.start", id: "r1" },
      { type: "reasoning.chunk", id: "r1", text: "Two paths: " },
      { type: "reasoning.chunk", id: "r1", text: "A or B." },
      { type: "reasoning.end", id: "r1", paragraphs: 1, tokens: 12 },
    ]);
    expect(s.cards).toHaveLength(1);
    const card = s.cards[0] as ReasoningCard;
    expect(card.text).toBe("Two paths: A or B.");
    expect(card.streaming).toBe(false);
    expect(card.paragraphs).toBe(1);
    expect(card.tokens).toBe(12);
  });

  it("snapshots the producing model on reasoning.start so mid-turn escalation doesn't relabel it", () => {
    const s = run([{ type: "reasoning.start", id: "r1" }]);
    const card = s.cards[0] as ReasoningCard;
    expect(card.model).toBe("deepseek-chat");
  });

  it("streams response chunks into a single streaming card", () => {
    const s = run([
      { type: "streaming.start", id: "s1" },
      { type: "streaming.chunk", id: "s1", text: "The change " },
      { type: "streaming.chunk", id: "s1", text: "maps to..." },
    ]);
    expect(s.cards).toHaveLength(1);
    const card = s.cards[0] as StreamingCard;
    expect(card.text).toBe("The change maps to...");
    expect(card.done).toBe(false);
  });

  it("marks streaming card done on streaming.end", () => {
    const s = run([
      { type: "streaming.start", id: "s1" },
      { type: "streaming.chunk", id: "s1", text: "ok" },
      { type: "streaming.end", id: "s1" },
    ]);
    expect((s.cards[0] as StreamingCard).done).toBe(true);
  });

  it("ignores chunks for unknown ids", () => {
    const s = run([{ type: "streaming.chunk", id: "missing", text: "lost" }]);
    expect(s.cards).toHaveLength(0);
  });

  it("changes mode and accumulates session cost", () => {
    const s = run([
      { type: "mode.change", mode: "ask" },
      {
        type: "turn.end",
        usage: { prompt: 1000, reason: 100, output: 50, cacheHit: 0.9, cost: 0.0014 },
      },
      {
        type: "turn.end",
        usage: { prompt: 1000, reason: 100, output: 50, cacheHit: 0.92, cost: 0.0016 },
      },
    ]);
    expect(s.status.mode).toBe("ask");
    expect(s.status.cost).toBeCloseTo(0.0016);
    expect(s.status.sessionCost).toBeCloseTo(0.003);
    expect(s.status.cacheHit).toBeCloseTo(0.92);
  });

  it("focus.move walks cards forward and back, clamped at edges", () => {
    let s = run([
      { type: "user.submit", text: "a" },
      { type: "user.submit", text: "b" },
      { type: "user.submit", text: "c" },
    ]);
    s = reduce(s, { type: "focus.move", direction: "first" });
    expect(s.focusedCardId).toBe(s.cards[0]?.id);
    s = reduce(s, { type: "focus.move", direction: "next" });
    expect(s.focusedCardId).toBe(s.cards[1]?.id);
    s = reduce(s, { type: "focus.move", direction: "next" });
    expect(s.focusedCardId).toBe(s.cards[2]?.id);
    s = reduce(s, { type: "focus.move", direction: "next" });
    expect(s.focusedCardId).toBe(s.cards[2]?.id);
    s = reduce(s, { type: "focus.move", direction: "prev" });
    expect(s.focusedCardId).toBe(s.cards[1]?.id);
  });

  it("composer input clears the abort hint", () => {
    let s = run([{ type: "turn.abort" }]);
    expect(s.composer.abortedHint).toBe(true);
    s = reduce(s, { type: "composer.input", value: "n" });
    expect(s.composer.abortedHint).toBe(false);
  });
});

describe("event schema", () => {
  it("parses well-formed events", () => {
    const ev = parseEvent({ type: "user.submit", text: "hi" });
    expect(ev?.type).toBe("user.submit");
  });

  it("rejects malformed events", () => {
    expect(parseEvent({ type: "user.submit" })).toBeNull();
    expect(parseEvent({ type: "unknown" })).toBeNull();
    expect(parseEvent({ type: "streaming.chunk", id: "", text: "x" })).toBeNull();
  });

  it("validates discriminated union variants", () => {
    expect(parseEvent({ type: "mode.change", mode: "auto" })?.type).toBe("mode.change");
    expect(parseEvent({ type: "mode.change", mode: "invalid" })).toBeNull();
  });
});
