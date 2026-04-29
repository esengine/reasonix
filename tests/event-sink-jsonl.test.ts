import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlEventSink, openEventSink } from "../src/adapters/event-sink-jsonl.js";
import type { Event } from "../src/core/events.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reasonix-events-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ev = (id: number, type: "user.message" | "status", text: string): Event =>
  type === "user.message"
    ? { id, ts: "2026-04-29T12:00:00Z", turn: 1, type, text }
    : { id, ts: "2026-04-29T12:00:00Z", turn: 1, type, text };

describe("JsonlEventSink", () => {
  it("appends one JSON object per line, parseable round-trip", async () => {
    const path = join(dir, "test.events.jsonl");
    const sink = openEventSink(path);
    sink.append(ev(1, "user.message", "hi"));
    sink.append(ev(2, "status", "thinking"));
    await sink.close();

    const raw = readFileSync(path, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ id: 1, type: "user.message", text: "hi" });
    expect(parsed[1]).toMatchObject({ id: 2, type: "status", text: "thinking" });
  });

  it("appends to an existing file (re-open across runs)", async () => {
    const path = join(dir, "resume.events.jsonl");
    const a = openEventSink(path);
    a.append(ev(1, "status", "first"));
    await a.close();

    const b = openEventSink(path);
    b.append(ev(2, "status", "second"));
    await b.close();

    const lines = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]!).text).toBe("second");
  });

  it("creates parent directory if missing", async () => {
    const nested = join(dir, "deep", "nested", "out.events.jsonl");
    const sink = openEventSink(nested);
    sink.append(ev(1, "status", "ok"));
    await sink.close();
    expect(readFileSync(nested, "utf8")).toContain('"text":"ok"');
  });

  it("flush is a no-op on a freshly closed sink", async () => {
    const path = join(dir, "flush.events.jsonl");
    const sink = openEventSink(path);
    sink.append(ev(1, "status", "x"));
    await sink.flush();
    await sink.close();
    expect(readFileSync(path, "utf8")).toContain('"text":"x"');
  });

  it("instance type matches the EventSink port shape", async () => {
    const path = join(dir, "shape.events.jsonl");
    const sink = openEventSink(path);
    expect(sink).toBeInstanceOf(JsonlEventSink);
    expect(typeof sink.append).toBe("function");
    expect(typeof sink.flush).toBe("function");
    expect(typeof sink.close).toBe("function");
    sink.append(ev(1, "status", "shape"));
    await sink.close();
  });
});
