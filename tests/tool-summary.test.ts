/** summarizeToolResult — pure function; per-tool-name + structured-payload branches. */

import { describe, expect, it } from "vitest";
import { formatDuration, summarizeToolResult } from "../src/cli/ui/tool-summary.js";

describe("summarizeToolResult — error envelopes", () => {
  it("flags ERROR:-prefixed text as a real error and strips the prefix", () => {
    const out = summarizeToolResult("anything", "ERROR: file not found");
    expect(out.isError).toBe(true);
    expect(out.summary).toBe("file not found");
  });

  it("treats structured {error:...} JSON as an error and shows tag + detail", () => {
    const out = summarizeToolResult("read_file", JSON.stringify({ error: "ENOENT: no such file" }));
    expect(out.isError).toBe(true);
    expect(out.summary).toMatch(/^ENOENT/);
  });

  it("recognizes Plan / Choice control-flow signals as NON-errors", () => {
    const cases = [
      "PlanProposedError",
      "PlanCheckpointError",
      "PlanRevisionProposedError",
      "ChoiceRequestedError",
      "NeedsConfirmationError",
    ];
    for (const tag of cases) {
      const out = summarizeToolResult(
        "any_tool",
        JSON.stringify({ error: `${tag}: STOP — picker shown to user.` }),
      );
      expect(out.isError, tag).toBe(false);
      expect(out.summary, tag).toMatch(new RegExp(tag));
    }
  });

  it("falls back to the bare error tag when no detail follows the colon", () => {
    const out = summarizeToolResult("x", JSON.stringify({ error: "SomeError" }));
    expect(out.isError).toBe(true);
    expect(out.summary).toBe("SomeError");
  });

  it("handles step_completed payload as a non-error tick", () => {
    const out = summarizeToolResult(
      "mark_step_complete",
      JSON.stringify({ kind: "step_completed", stepId: "step-2", result: "wired middleware" }),
    );
    expect(out.isError).toBe(false);
    expect(out.summary).toMatch(/✓ step-2/);
  });
});

describe("summarizeToolResult — known tools", () => {
  it("read_file: shows first line + line count + size", () => {
    const content = "import { foo } from 'bar';\nexport function baz() {}\n";
    const out = summarizeToolResult("read_file", content);
    expect(out.isError).toBe(false);
    expect(out.summary).toMatch(/import.*foo/);
    expect(out.summary).toMatch(/3 lines/);
    expect(out.summary).toMatch(/B/);
  });

  it("list_directory: shows entry count", () => {
    const out = summarizeToolResult("list_directory", "src/\ntests/\nREADME.md\n");
    expect(out.summary).toBe("3 entries");
  });

  it("list_directory with one entry uses singular", () => {
    const out = summarizeToolResult("list_directory", "only-thing\n");
    expect(out.summary).toBe("1 entry");
  });

  it("search_content: shows match count + first match", () => {
    const out = summarizeToolResult(
      "search_content",
      "src/foo.ts:12: const x = 1\nsrc/bar.ts:34: const x = 2",
    );
    expect(out.summary).toMatch(/2 matches/);
    expect(out.summary).toMatch(/src\/foo\.ts/);
  });

  it("search_content: explicit no-match path", () => {
    const out = summarizeToolResult("search_content", "");
    expect(out.summary).toBe("no matches");
  });

  it("run_command: surfaces exit code and first line", () => {
    const out = summarizeToolResult("run_command", "exit 0\nhello world");
    expect(out.isError).toBe(false);
    expect(out.summary).toMatch(/exit 0/);
  });

  it("run_command: non-zero exit flags the row as an error", () => {
    const out = summarizeToolResult("run_command", "exit 1\nError: something went wrong");
    expect(out.isError).toBe(true);
    expect(out.summary).toMatch(/exit 1/);
  });

  it("write_file: shows wrote line count + size", () => {
    const out = summarizeToolResult("write_file", "alpha\nbeta\ngamma\n");
    expect(out.isError).toBe(false);
    expect(out.summary).toMatch(/wrote/);
    expect(out.summary).toMatch(/4 lines/);
  });

  it("MCP-bridged tools pick up the same summary via suffix match", () => {
    // `filesystem_read_file` should hit the read_file branch.
    const out = summarizeToolResult(
      "filesystem_read_file",
      "import { foo } from 'bar';\nexport function baz() {}\n",
    );
    expect(out.summary).toMatch(/lines/);
    expect(out.summary).toMatch(/import.*foo/);
  });

  it("suffix match doesn't false-trigger on non-underscore prefixes", () => {
    // `myread_file` (no underscore separator) should NOT match read_file.
    const out = summarizeToolResult("myread_file", "anything");
    expect(out.summary).not.toMatch(/lines/);
  });
});

describe("formatDuration", () => {
  it("renders sub-100ms in milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(47)).toBe("47ms");
    expect(formatDuration(99)).toBe("99ms");
  });

  it("renders sub-second times in 1-decimal seconds", () => {
    expect(formatDuration(100)).toBe("0.1s");
    expect(formatDuration(450)).toBe("0.5s");
    expect(formatDuration(999)).toBe("1.0s");
  });

  it("renders sub-10s times with one decimal", () => {
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(8500)).toBe("8.5s");
  });

  it("renders 10s–60s as integer seconds", () => {
    expect(formatDuration(10_000)).toBe("10s");
    expect(formatDuration(45_900)).toBe("46s");
  });

  it("renders minutes-and-seconds for long runs", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(90_000)).toBe("1m30s");
    expect(formatDuration(125_500)).toBe("2m6s");
  });

  it("returns empty string for invalid input", () => {
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("summarizeToolResult — generic fallback", () => {
  it("returns first line only for short content", () => {
    const out = summarizeToolResult("custom_tool", "hello");
    expect(out.summary).toBe("hello");
    expect(out.isError).toBe(false);
  });

  it("appends a size hint for long content", () => {
    const long = `first line\n${"x".repeat(2000)}`;
    const out = summarizeToolResult("custom_tool", long);
    expect(out.summary).toMatch(/first line/);
    expect(out.summary).toMatch(/KB/);
  });

  it("handles empty string as (empty)", () => {
    const out = summarizeToolResult("anything", "");
    expect(out.summary).toBe("(empty)");
  });

  it("clips overly long single lines with an ellipsis and stays under the budget", () => {
    const out = summarizeToolResult("anything", "a".repeat(500));
    expect(out.summary).toMatch(/…/);
    expect(out.summary.length).toBeLessThanOrEqual(80);
  });
});
