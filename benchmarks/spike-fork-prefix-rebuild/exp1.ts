// Exp 1 — see ./results.md for what this validates and why.

import { Eventizer, type EventizeContext } from "../../src/core/eventize.js";
import type { Event } from "../../src/core/events.js";
import { replay } from "../../src/core/reducers.js";
import type { LoopEvent } from "../../src/loop.js";

interface Shape {
  name: string;
  description: string;
  build: () => LoopEvent[];
}

const ctx: EventizeContext = { model: "deepseek-v4-flash", reasoningEffort: "max", prefixHash: "abc" };

function assistantTurn(turn: number, text: string): LoopEvent {
  return { turn, role: "assistant_final", content: text } as LoopEvent;
}

function toolCallPair(turn: number, name: string, args: string, result: string): LoopEvent[] {
  return [
    { turn, role: "tool_start", toolName: name, toolArgs: args } as LoopEvent,
    { turn, role: "tool", content: result, toolName: name } as LoopEvent,
  ];
}

function quickFix(): LoopEvent[] {
  const events: LoopEvent[] = [];
  for (let t = 1; t <= 5; t++) {
    events.push(assistantTurn(t, `step ${t}: thinking through the fix`));
    if (t === 2 || t === 4) {
      events.push(...toolCallPair(t, "read_file", `{"path":"src/x${t}.ts"}`, `// file ${t} contents`));
    }
  }
  return events;
}

function localRefactor(): LoopEvent[] {
  const events: LoopEvent[] = [];
  for (let t = 1; t <= 20; t++) {
    events.push(assistantTurn(t, `refactor step ${t}`));
    const toolCount = 3 + (t % 3);
    for (let i = 0; i < toolCount; i++) {
      events.push(
        ...toolCallPair(
          t,
          i % 2 === 0 ? "read_file" : "edit_file",
          `{"path":"src/mod${t}-${i}.ts"}`,
          `result for tool ${i} at turn ${t}`,
        ),
      );
    }
  }
  return events;
}

function longTailDebug(): LoopEvent[] {
  const events: LoopEvent[] = [];
  for (let t = 1; t <= 80; t++) {
    events.push(assistantTurn(t, `debug iteration ${t}`));
    const toolCount = 1 + (t % 2);
    for (let i = 0; i < toolCount; i++) {
      events.push(
        ...toolCallPair(t, "search_content", `{"q":"err${t}-${i}"}`, `match for q at turn ${t}`),
      );
    }
  }
  return events;
}

const shapes: Shape[] = [
  { name: "quick-fix", description: "5 turns, 0-1 tools/turn", build: quickFix },
  { name: "local-refactor", description: "20 turns, 3-5 tools/turn", build: localRefactor },
  { name: "long-tail-debug", description: "80 turns, 1-2 tools/turn", build: longTailDebug },
];

function synthesize(loopEvents: LoopEvent[]): { events: Event[]; turnBoundaries: number[] } {
  const eventizer = new Eventizer();
  const events: Event[] = [];
  const turnBoundaries: number[] = [];
  let lastTurn = -1;
  events.push(eventizer.emitSessionOpened(0, "exp1", 0));
  events.push(eventizer.emitUserMessage(1, "kick off"));
  for (const lev of loopEvents) {
    if (lev.turn !== lastTurn) {
      turnBoundaries.push(events.length);
      lastTurn = lev.turn;
    }
    for (const out of eventizer.consume(lev, ctx)) events.push(out);
  }
  return { events, turnBoundaries };
}

function projectionJson(events: Event[]): string {
  return JSON.stringify(replay(events).conversation.messages);
}

interface ShapeResult {
  shape: string;
  events: number;
  turnBoundaries: number;
  determinismMatch: boolean;
  determinismDivergedAt: number | null;
  sliceMatchAtBoundary: number;
  sliceDivergedAt: number | null;
}

function runShape(s: Shape): ShapeResult {
  const loopEvents = s.build();
  const a = synthesize(loopEvents);
  const b = synthesize(loopEvents);
  const aJson = projectionJson(a.events);
  const bJson = projectionJson(b.events);
  const determinismMatch = aJson === bJson;
  const determinismDivergedAt = determinismMatch
    ? null
    : firstDivergenceCharIndex(aJson, bJson);

  let sliceMatch = 0;
  let sliceDivergedAt: number | null = null;
  let prev: ReturnType<typeof replay>["conversation"]["messages"] | null = null;
  for (const cut of a.turnBoundaries) {
    const cur = replay(a.events.slice(0, cut)).conversation.messages;
    if (prev === null || isPrefixOf(prev, cur)) {
      sliceMatch++;
      prev = cur;
    } else if (sliceDivergedAt === null) {
      sliceDivergedAt = cut;
    }
  }

  return {
    shape: s.name,
    events: a.events.length,
    turnBoundaries: a.turnBoundaries.length,
    determinismMatch,
    determinismDivergedAt,
    sliceMatchAtBoundary: sliceMatch,
    sliceDivergedAt,
  };
}

function firstDivergenceCharIndex(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return i;
  return len;
}

function isPrefixOf(
  short: readonly unknown[],
  long: readonly unknown[],
): boolean {
  if (short.length > long.length) return false;
  for (let i = 0; i < short.length; i++) {
    if (JSON.stringify(short[i]) !== JSON.stringify(long[i])) return false;
  }
  return true;
}

function main(): void {
  console.log("# Exp 1 — synthetic round-trip byte equality\n");
  const results: ShapeResult[] = [];
  for (const s of shapes) {
    process.stdout.write(`shape: ${s.name} — ${s.description}\n`);
    const r = runShape(s);
    results.push(r);
    console.log(`  events generated:        ${r.events}`);
    console.log(`  turn boundaries:         ${r.turnBoundaries}`);
    console.log(
      `  cross-run determinism:   ${r.determinismMatch ? "PASS" : `FAIL (diverge @ char ${r.determinismDivergedAt})`}`,
    );
    console.log(
      `  slice/rebuild parity:    ${r.sliceMatchAtBoundary}/${r.turnBoundaries}` +
        (r.sliceDivergedAt !== null ? ` — first miss @ cut=${r.sliceDivergedAt}` : ""),
    );
    console.log("");
  }

  const allPass = results.every(
    (r) => r.determinismMatch && r.sliceMatchAtBoundary === r.turnBoundaries,
  );
  console.log(allPass ? "RESULT: PASS — Stage 1 unblocked." : "RESULT: FAIL — investigate before proceeding.");
  process.exit(allPass ? 0 : 1);
}

main();
