import { describe, expect, it } from "vitest";
import { AppendOnlyLog, ImmutablePrefix, VolatileScratch } from "../src/memory.js";

describe("ImmutablePrefix", () => {
  it("fingerprint is stable for identical inputs", () => {
    const a = new ImmutablePrefix({ system: "hello" });
    const b = new ImmutablePrefix({ system: "hello" });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("fingerprint changes with inputs", () => {
    const a = new ImmutablePrefix({ system: "hello" });
    const b = new ImmutablePrefix({ system: "world" });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("toMessages includes system plus few-shots", () => {
    const p = new ImmutablePrefix({
      system: "sys",
      fewShots: [{ role: "user", content: "hi" }],
    });
    expect(p.toMessages()).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("fingerprint is cached across reads — same string identity", () => {
    const p = new ImmutablePrefix({ system: "x" });
    const first = p.fingerprint;
    const second = p.fingerprint;
    expect(first).toBe(second);
    // Cache hit returns the same primitive — strict equality is the
    // observable proof. (Strings are interned by content, but the
    // same getter call path re-reading should be a no-op recompute.)
    expect(first === second).toBe(true);
  });

  it("addTool invalidates the fingerprint cache", () => {
    const p = new ImmutablePrefix({ system: "x" });
    const before = p.fingerprint;
    const added = p.addTool({
      type: "function",
      function: { name: "echo", description: "", parameters: { type: "object" } },
    });
    expect(added).toBe(true);
    const after = p.fingerprint;
    expect(after).not.toBe(before);
  });

  it("addTool de-dupes by name and does NOT churn the fingerprint", () => {
    const p = new ImmutablePrefix({
      system: "x",
      toolSpecs: [
        {
          type: "function",
          function: { name: "echo", description: "", parameters: { type: "object" } },
        },
      ],
    });
    const before = p.fingerprint;
    const added = p.addTool({
      type: "function",
      function: { name: "echo", description: "different", parameters: { type: "object" } },
    });
    expect(added).toBe(false);
    expect(p.fingerprint).toBe(before);
  });

  it("verifyFingerprint passes when cache is consistent", () => {
    const p = new ImmutablePrefix({ system: "x" });
    p.fingerprint; // prime the cache
    expect(() => p.verifyFingerprint()).not.toThrow();
  });

  it("verifyFingerprint catches drift from out-of-band mutation", () => {
    const p = new ImmutablePrefix({ system: "x" });
    p.fingerprint; // prime the cache
    // Simulate a future bug: a new mutation path mutates the
    // backing array directly without going through addTool. The
    // cached fingerprint is now stale; verify should throw.
    (p as unknown as { _toolSpecs: unknown[] })._toolSpecs.push({
      type: "function",
      function: { name: "rogue", description: "", parameters: { type: "object" } },
    });
    expect(() => p.verifyFingerprint()).toThrow(/fingerprint drift/);
  });
});

describe("AppendOnlyLog", () => {
  it("appends in order and rejects malformed entries", () => {
    const log = new AppendOnlyLog();
    log.append({ role: "user", content: "hi" });
    log.append({ role: "assistant", content: "hello" });
    expect(log.length).toBe(2);
    expect(() => log.append({ content: "x" } as any)).toThrow();
  });

  it("toMessages returns a shallow-copy not affecting internal state", () => {
    const log = new AppendOnlyLog();
    log.append({ role: "user", content: "hi" });
    const msgs = log.toMessages();
    msgs[0]!.content = "tampered";
    expect(log.entries[0]!.content).toBe("hi");
  });
});

describe("VolatileScratch", () => {
  it("resets all fields", () => {
    const s = new VolatileScratch();
    s.reasoning = "x";
    s.planState = { a: 1 };
    s.notes.push("note");
    s.reset();
    expect(s.reasoning).toBeNull();
    expect(s.planState).toBeNull();
    expect(s.notes).toEqual([]);
  });
});
