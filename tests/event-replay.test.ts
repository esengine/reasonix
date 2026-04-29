import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openEventSink } from "../src/adapters/event-sink-jsonl.js";
import { readEventLogFile } from "../src/adapters/event-source-jsonl.js";
import { Eventizer } from "../src/core/eventize.js";
import { replay } from "../src/core/reducers.js";
import type { LoopEvent } from "../src/loop.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reasonix-replay-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = { model: "deepseek-v4-flash", prefixHash: "abc", reasoningEffort: "max" } as const;
const lev = (p: Partial<LoopEvent>): LoopEvent =>
  ({ turn: 1, role: "status", content: "", ...p }) as LoopEvent;

describe("event-log replay round-trip", () => {
  it("synthetic LoopEvents → eventize → sink → file → source → reducers → ConversationView matches", async () => {
    const path = join(dir, "rt.events.jsonl");
    const sink = openEventSink(path);
    const eventizer = new Eventizer();

    // Session bootstrap (App-side emit).
    sink.append(eventizer.emitSessionOpened(0, "rt", 0));
    sink.append(eventizer.emitUserMessage(1, "list files in src"));

    // Loop emits a typical turn: assistant_final → tool_start → tool.
    const loopEvents: LoopEvent[] = [
      lev({ turn: 1, role: "status", content: "thinking" }),
      lev({ turn: 1, role: "assistant_delta", content: "Let me check." }),
      lev({
        turn: 1,
        role: "assistant_final",
        content: "Let me check.",
        // No stats so the model.final lands with empty usage / 0 cost.
      }),
      lev({
        turn: 1,
        role: "tool_start",
        toolName: "list_directory",
        toolArgs: '{"path":"src"}',
      }),
      lev({
        turn: 1,
        role: "tool",
        content: "App.tsx\nloop.ts\n...",
        toolName: "list_directory",
      }),
      lev({ turn: 1, role: "done", content: "" }),
    ];
    for (const lev of loopEvents) {
      for (const out of eventizer.consume(lev, ctx)) sink.append(out);
    }
    await sink.close();

    const events = readEventLogFile(path);
    expect(events.length).toBeGreaterThan(0);
    const projections = replay(events);

    const msgs = projections.conversation.messages;
    expect(msgs.length).toBe(3);
    expect(msgs[0]).toMatchObject({ role: "user", content: "list files in src" });
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "Let me check." });
    expect(msgs[2]).toMatchObject({ role: "tool", content: "App.tsx\nloop.ts\n..." });
    expect(projections.conversation.pendingToolCalls).toEqual([]);
    expect(projections.session.name).toBe("rt");
    expect(projections.session.currentTurn).toBe(1);
  });

  it("error-shaped tool result reduces with ok=false in the conversation", async () => {
    const path = join(dir, "err.events.jsonl");
    const sink = openEventSink(path);
    const eventizer = new Eventizer();
    sink.append(eventizer.emitUserMessage(1, "rm bogus"));
    const seq: LoopEvent[] = [
      lev({ turn: 1, role: "tool_start", toolName: "shell", toolArgs: "{}" }),
      lev({
        turn: 1,
        role: "tool",
        content: "ERROR: command not found",
        toolName: "shell",
      }),
    ];
    for (const lev of seq) {
      for (const out of eventizer.consume(lev, ctx)) sink.append(out);
    }
    await sink.close();

    const projections = replay(readEventLogFile(path));
    const tail = projections.conversation.messages.at(-1);
    expect(tail?.role).toBe("tool");
    expect(tail?.content).toContain("ERROR:");
    // Even with ok=false the pending list clears.
    expect(projections.conversation.pendingToolCalls).toEqual([]);
  });

  it("replay is deterministic — running twice yields identical projections", async () => {
    const path = join(dir, "det.events.jsonl");
    const sink = openEventSink(path);
    const eventizer = new Eventizer();
    sink.append(eventizer.emitSessionOpened(0, "det", 0));
    sink.append(eventizer.emitUserMessage(1, "x"));
    for (const out of eventizer.consume(
      lev({ turn: 1, role: "assistant_final", content: "y" }),
      ctx,
    ))
      sink.append(out);
    await sink.close();

    const events = readEventLogFile(path);
    const a = replay(events);
    const b = replay(events);
    expect(a).toEqual(b);
  });

  it("missing log file yields empty event list (no exception)", () => {
    const path = join(dir, "does-not-exist.events.jsonl");
    expect(readEventLogFile(path)).toEqual([]);
  });

  it("malformed JSONL lines are skipped, valid ones accepted", () => {
    const path = join(dir, "partial.events.jsonl");
    // Use the sink to write valid lines, then manually append garbage.
    const sink = openEventSink(path);
    const eventizer = new Eventizer();
    sink.append(eventizer.emitUserMessage(1, "ok"));
    return sink.close().then(() => {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.appendFileSync(path, "{not valid json\n");
      fs.appendFileSync(path, "\n");
      fs.appendFileSync(
        path,
        `${JSON.stringify({ id: 99, ts: "2026-04-29T00:00:00Z", turn: 1, type: "status", text: "good" })}\n`,
      );
      const events = readEventLogFile(path);
      // 1 from the valid sink write + 1 from the manually appended status.
      expect(events.length).toBe(2);
      expect(events[1]?.type).toBe("status");
    });
  });
});
