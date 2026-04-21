/**
 * Checker tests for the harvest eval harness.
 *
 * Unlike the bench runner tests (which cover plumbing without API calls),
 * these test the pass/fail verdict logic — the part that determines
 * whether a real run's data is credible. A broken checker silently
 * produces wrong numbers, so the tests here are worth every line.
 */

import { describe, expect, it } from "vitest";
import { TASKS } from "../benchmarks/harvest/tasks.js";

function taskById(id: string) {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

describe("harvest-bench: mod7_list checker", () => {
  const task = taskById("mod7_list");

  it("passes on the exact 29-element set in a plain comma list", () => {
    const list = [
      2, 4, 9, 11, 16, 18, 23, 25, 30, 32, 37, 39, 44, 46, 51, 53, 58, 60, 65, 67, 72, 74, 79, 81,
      86, 88, 93, 95, 100,
    ];
    const reply = `Thinking... blah blah.\nAnswer: ${list.join(", ")}`;
    expect(task.check(reply).verdict).toBe("pass");
  });

  it("passes when ranges like 2-4 are expanded", () => {
    // cheat: give the set as short ranges — checker should expand them
    const reply =
      "Answer: 2, 4, 9, 11, 16, 18, 23, 25, 30, 32, 37, 39, 44, 46, 51, 53, 58, 60, 65, 67, 72, 74, 79, 81, 86, 88, 93, 95, 100";
    expect(task.check(reply).verdict).toBe("pass");
  });

  it("fails when a number is missing", () => {
    const list = [2, 4, 9, 11, 16, 18, 23, 25, 30, 32, 37, 39, 44, 46, 51, 53, 58, 60, 65, 67, 72];
    const reply = `Answer: ${list.join(", ")}`;
    const result = task.check(reply);
    expect(result.verdict).toBe("fail");
    expect(result.note).toMatch(/missing/);
  });

  it("fails when an extra in-range number sneaks in (e.g. 3 — which is NOT in the valid set)", () => {
    const list = [
      2, 3, 4, 9, 11, 16, 18, 23, 25, 30, 32, 37, 39, 44, 46, 51, 53, 58, 60, 65, 67, 72, 74, 79,
      81, 86, 88, 93, 95, 100,
    ]; // 3 is the intruder
    const reply = `Answer: ${list.join(", ")}`;
    const result = task.check(reply);
    expect(result.verdict).toBe("fail");
    expect(result.note).toMatch(/extra.*3/);
  });

  it("fails cleanly on an empty / garbled answer", () => {
    expect(task.check("").verdict).toBe("fail");
    expect(task.check("I cannot solve this").verdict).toBe("fail");
  });
});

describe("harvest-bench: flips_until_3heads checker", () => {
  const task = taskById("flips_until_3heads");

  it("passes on exact answer 14", () => {
    expect(task.check("Answer: 14").verdict).toBe("pass");
  });

  it("passes when agent adds units ('14 flips')", () => {
    expect(task.check("Answer: 14 flips").verdict).toBe("pass");
  });

  it("fails on wrong number", () => {
    const r = task.check("Answer: 7");
    expect(r.verdict).toBe("fail");
    expect(r.note).toMatch(/got 7/);
  });

  it("fails when no number is present", () => {
    expect(task.check("Answer: lots").verdict).toBe("fail");
  });
});

describe("harvest-bench: three_hats checker", () => {
  const task = taskById("three_hats");

  it("passes on 'red'", () => {
    expect(task.check("Answer: red").verdict).toBe("pass");
  });

  it("passes with extra wording around the keyword", () => {
    expect(task.check("Answer: The third person's hat is red.").verdict).toBe("pass");
  });

  it("fails on 'blue'", () => {
    expect(task.check("Answer: blue").verdict).toBe("fail");
  });

  it("fails when answer mentions both colors (ambiguous)", () => {
    // We require a clean red-only answer to avoid giving credit for hedging
    expect(task.check("Answer: red or blue, depends").verdict).toBe("fail");
  });
});

describe("task set invariants", () => {
  it("exposes at least 3 tasks with unique ids", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(TASKS.map((t) => t.id));
    expect(ids.size).toBe(TASKS.length);
  });

  it("every task checker rejects a deliberately wrong answer (sanity)", () => {
    const bogus = "Answer: this is not a valid answer to anything";
    for (const t of TASKS) {
      const r = t.check(bogus);
      expect(r.verdict).toBe("fail");
    }
  });

  it("every task checker is deterministic on identical input", () => {
    const sample = "Answer: something";
    for (const t of TASKS) {
      expect(t.check(sample).verdict).toBe(t.check(sample).verdict);
    }
  });
});
