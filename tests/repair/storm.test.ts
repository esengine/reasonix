import { describe, expect, it } from "vitest";
import { StormBreaker } from "../../src/repair/storm.js";
import type { ToolCall } from "../../src/types.js";

function call(name: string, args: string): ToolCall {
  return { function: { name, arguments: args } };
}

describe("StormBreaker", () => {
  it("passes through below threshold", () => {
    const sb = new StormBreaker(6, 3);
    expect(sb.inspect(call("x", "{}")).suppress).toBe(false);
    expect(sb.inspect(call("x", "{}")).suppress).toBe(false);
  });

  it("suppresses on threshold reached", () => {
    const sb = new StormBreaker(6, 3);
    sb.inspect(call("x", "{}"));
    sb.inspect(call("x", "{}"));
    const verdict = sb.inspect(call("x", "{}"));
    expect(verdict.suppress).toBe(true);
    expect(verdict.reason).toMatch(/repeat-loop guard/);
  });

  it("distinguishes different args as different calls", () => {
    const sb = new StormBreaker(6, 3);
    sb.inspect(call("x", '{"a":1}'));
    sb.inspect(call("x", '{"a":2}'));
    sb.inspect(call("x", '{"a":3}'));
    // different args each time — not a storm
    const verdict = sb.inspect(call("x", '{"a":4}'));
    expect(verdict.suppress).toBe(false);
  });

  it("forgets old calls beyond window", () => {
    const sb = new StormBreaker(3, 3);
    sb.inspect(call("x", "{}"));
    sb.inspect(call("x", "{}"));
    sb.inspect(call("y", "{}"));
    sb.inspect(call("z", "{}"));
    sb.inspect(call("w", "{}"));
    // only the most recent 3 are in the window now, none of which is "x",
    // so a single new "x" should not suppress.
    expect(sb.inspect(call("x", "{}")).suppress).toBe(false);
  });

  it("an intervening mutating call resets the window for re-reads of the same path", () => {
    // Caller supplies the predicate — production wires it from the
    // ToolRegistry's readOnly flag; tests fake it with a name set.
    const mutators = new Set(["edit_file", "write_file"]);
    const sb = new StormBreaker(6, 3, (c) => mutators.has(c.function?.name ?? ""));
    const args = '{"path":"src/env.ts"}';
    expect(sb.inspect(call("read_file", args)).suppress).toBe(false);
    expect(sb.inspect(call("edit_file", '{"path":"src/env.ts","..."}')).suppress).toBe(false);
    expect(sb.inspect(call("read_file", args)).suppress).toBe(false);
    expect(sb.inspect(call("edit_file", '{"path":"src/env.ts","..."}')).suppress).toBe(false);
    // 3rd read_file with identical args — would trip the breaker pre-fix,
    // but each edit_file legitimately changed the file in between.
    expect(sb.inspect(call("read_file", args)).suppress).toBe(false);
  });

  it("predicate-flagged write_file resets the window", () => {
    const mutators = new Set(["write_file"]);
    const sb = new StormBreaker(6, 3, (c) => mutators.has(c.function?.name ?? ""));
    expect(sb.inspect(call("read_file", "{}")).suppress).toBe(false);
    expect(sb.inspect(call("read_file", "{}")).suppress).toBe(false);
    expect(sb.inspect(call("write_file", "{}")).suppress).toBe(false);
    // Buffer cleared by write_file — a fresh pair of reads is now safe.
    expect(sb.inspect(call("read_file", "{}")).suppress).toBe(false);
    expect(sb.inspect(call("read_file", "{}")).suppress).toBe(false);
  });

  it("with no predicate, every tool counts (back-compat)", () => {
    // No isMutating wired → original semantics. Three identical calls
    // to any tool name still suppresses the third.
    const sb = new StormBreaker(6, 3);
    sb.inspect(call("edit_file", "{}"));
    sb.inspect(call("edit_file", "{}"));
    expect(sb.inspect(call("edit_file", "{}")).suppress).toBe(true);
  });
});
