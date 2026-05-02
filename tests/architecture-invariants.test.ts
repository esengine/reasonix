/** Pillar invariants — promoted from spike-fork-prefix-rebuild Exp 1 to permanent regression. */

import { describe, expect, it } from "vitest";
import { type EventizeContext, Eventizer } from "../src/core/eventize.js";
import type { Event } from "../src/core/events.js";
import { replay } from "../src/core/reducers.js";
import type { LoopEvent } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";

const ctx: EventizeContext = {
  model: "deepseek-v4-flash",
  reasoningEffort: "max",
  prefixHash: "test",
};

function synth(loopEvents: LoopEvent[]): Event[] {
  const eventizer = new Eventizer();
  const events: Event[] = [];
  events.push(eventizer.emitSessionOpened(0, "inv", 0));
  events.push(eventizer.emitUserMessage(1, "kick off"));
  for (const lev of loopEvents) {
    for (const out of eventizer.consume(lev, ctx)) events.push(out);
  }
  return events;
}

function assistantTurn(turn: number, content: string): LoopEvent {
  return { turn, role: "assistant_final", content } as LoopEvent;
}

function toolPair(turn: number, name: string, args: string, result: string): LoopEvent[] {
  return [
    { turn, role: "tool_start", toolName: name, toolArgs: args } as LoopEvent,
    { turn, role: "tool", content: result, toolName: name } as LoopEvent,
  ];
}

function buildSession(turns: number, toolsPerTurn: (t: number) => number): LoopEvent[] {
  const out: LoopEvent[] = [];
  for (let t = 1; t <= turns; t++) {
    out.push(assistantTurn(t, `assistant turn ${t}`));
    const n = toolsPerTurn(t);
    for (let i = 0; i < n; i++) {
      out.push(...toolPair(t, "read_file", `{"path":"f${t}-${i}.ts"}`, `body ${t}-${i}`));
    }
  }
  return out;
}

describe("Pillar 1 — ImmutablePrefix.fingerprint determinism", () => {
  it("same {system, tools, fewShots} inputs yield byte-identical fingerprint", () => {
    const a = new ImmutablePrefix({
      system: "you are a coder",
      toolSpecs: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
      fewShots: [],
    });
    const b = new ImmutablePrefix({
      system: "you are a coder",
      toolSpecs: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
      fewShots: [],
    });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("addTool invalidates fingerprint exactly once", () => {
    const p = new ImmutablePrefix({ system: "x", toolSpecs: [] });
    const before = p.fingerprint;
    const ok = p.addTool({
      type: "function",
      function: { name: "new", parameters: { type: "object" } },
    });
    expect(ok).toBe(true);
    expect(p.fingerprint).not.toBe(before);
  });
});

describe("Pillar 1 — reducer projection determinism", () => {
  const shapes: Array<[string, LoopEvent[]]> = [
    ["quick-fix", buildSession(5, (t) => (t % 2 === 0 ? 1 : 0))],
    ["local-refactor", buildSession(20, (t) => 3 + (t % 3))],
    ["long-tail-debug", buildSession(80, (t) => 1 + (t % 2))],
  ];

  for (const [name, loopEvents] of shapes) {
    it(`${name}: identical LoopEvent input → byte-identical message projection`, () => {
      const a = synth(loopEvents);
      const b = synth(loopEvents);
      const aJson = JSON.stringify(replay(a).conversation.messages);
      const bJson = JSON.stringify(replay(b).conversation.messages);
      expect(aJson).toBe(bJson);
    });
  }
});

describe("Pillar 1 — message-level append-only across turn boundaries", () => {
  it("replay(events[0..n]).messages is a strict prefix of replay(events[0..m]) for n < m", () => {
    const events = synth(buildSession(20, (t) => 3 + (t % 3)));
    const turnBoundaries: number[] = [];
    let lastTurn = -1;
    events.forEach((ev, idx) => {
      if (ev.turn !== lastTurn) {
        turnBoundaries.push(idx);
        lastTurn = ev.turn;
      }
    });

    let prev: ReturnType<typeof replay>["conversation"]["messages"] | null = null;
    for (const cut of turnBoundaries) {
      const cur = replay(events.slice(0, cut)).conversation.messages;
      if (prev !== null) {
        expect(cur.length).toBeGreaterThanOrEqual(prev.length);
        for (let i = 0; i < prev.length; i++) {
          expect(JSON.stringify(cur[i])).toBe(JSON.stringify(prev[i]));
        }
      }
      prev = cur;
    }
  });
});
