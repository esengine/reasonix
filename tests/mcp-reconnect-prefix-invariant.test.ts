/** Pins down the cache-prefix claims in RFC #110 (`/mcp reconnect <name>`). */

import { describe, expect, it } from "vitest";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import type { ToolSpec } from "../src/types.js";

function tool(name: string, description = "", params: object = { type: "object" }): ToolSpec {
  return {
    type: "function",
    function: { name, description, parameters: params },
  };
}

describe("RFC #110 — cache-prefix invariant under MCP reconnect", () => {
  it("re-bridging an IDENTICAL tool list yields byte-identical fingerprint (the safe case)", () => {
    const before = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("read"), tool("write"), tool("search")],
    });
    const after = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("read"), tool("write"), tool("search")],
    });
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it("re-bridging with one ADDED tool changes the fingerprint (cache miss next turn)", () => {
    const before = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("read"), tool("write")],
    });
    const after = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("read"), tool("write"), tool("delete")],
    });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("re-bridging with one REMOVED tool changes the fingerprint", () => {
    const before = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("read"), tool("write"), tool("search")],
    });
    const after = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("read"), tool("write")],
    });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("a description-only change on an existing tool changes the fingerprint", () => {
    const before = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("read", "reads a file")],
    });
    const after = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("read", "reads a file (utf-8)")],
    });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("a parameter-schema change on an existing tool changes the fingerprint", () => {
    const before = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("read", "", { type: "object", properties: { path: { type: "string" } } })],
    });
    const after = new ImmutablePrefix({
      system: "s",
      toolSpecs: [
        tool("read", "", {
          type: "object",
          properties: { path: { type: "string" }, encoding: { type: "string" } },
        }),
      ],
    });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("REORDERING the same tools changes the fingerprint (array order is part of the prefix)", () => {
    const a = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("read"), tool("write"), tool("search")],
    });
    const b = new ImmutablePrefix({
      system: "s",
      toolSpecs: [tool("write"), tool("read"), tool("search")],
    });
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });
});
