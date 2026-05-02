import { describe, expect, it } from "vitest";
import { formatMcpLifecycleEvent } from "../src/cli/ui/mcp-lifecycle.js";

describe("formatMcpLifecycleEvent", () => {
  it("renders the handshake state", () => {
    expect(formatMcpLifecycleEvent({ state: "handshake", name: "notion" })).toBe(
      "⌘ MCP · notion          ↻ handshake…   initialise → tools/list → resources/list",
    );
  });

  it("renders the connected state with full counts", () => {
    expect(
      formatMcpLifecycleEvent({
        state: "connected",
        name: "notion",
        tools: 12,
        resources: 8,
        prompts: 0,
        ms: 142,
      }),
    ).toBe("⌘ MCP · notion          ✓ connected    12 tools · 8 resources · 142ms");
  });

  it("omits resource/prompt counts when zero", () => {
    expect(formatMcpLifecycleEvent({ state: "connected", name: "fs", tools: 5, ms: 88 })).toBe(
      "⌘ MCP · fs              ✓ connected    5 tools · 88ms",
    );
  });

  it("renders the failed state", () => {
    expect(
      formatMcpLifecycleEvent({
        state: "failed",
        name: "fs-local",
        reason: "ENOENT: server binary missing",
      }),
    ).toBe("⌘ MCP · fs-local        ✖ failed       ENOENT: server binary missing");
  });

  it("keeps a minimum 1-space gap when the name overflows the alignment column", () => {
    const out = formatMcpLifecycleEvent({
      state: "connected",
      name: "very-long-server-name-overflow",
      tools: 3,
      ms: 50,
    });
    expect(out.startsWith("⌘ MCP · very-long-server-name-overflow ✓")).toBe(true);
  });

  it("each rendered line is a single newline-free string", () => {
    const samples = [
      formatMcpLifecycleEvent({ state: "handshake", name: "x" }),
      formatMcpLifecycleEvent({ state: "connected", name: "x", tools: 1, ms: 1 }),
      formatMcpLifecycleEvent({ state: "failed", name: "x", reason: "boom" }),
    ];
    for (const s of samples) expect(s).not.toContain("\n");
  });
});
