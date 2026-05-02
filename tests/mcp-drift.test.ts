import { describe, expect, it } from "vitest";
import { classifyToolListDrift } from "../src/mcp/drift.js";
import type { ToolSpec } from "../src/types.js";

function tool(name: string, description = "", params: object = { type: "object" }): ToolSpec {
  return {
    type: "function",
    function: { name, description, parameters: params },
  };
}

const A = tool("read");
const B = tool("write");
const C = tool("search");
const D = tool("delete");

describe("classifyToolListDrift", () => {
  it("identity: same length, same names, same content → identity", () => {
    const r = classifyToolListDrift([A, B, C], [A, B, C]);
    expect(r.kind).toBe("identity");
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.edited).toEqual([]);
  });

  it("append: every before-tool unchanged, new tool appended", () => {
    const r = classifyToolListDrift([A, B, C], [A, B, C, D]);
    expect(r.kind).toBe("append");
    expect(r.added).toEqual(["delete"]);
    expect(r.removed).toEqual([]);
    expect(r.edited).toEqual([]);
  });

  it("append: multiple tools appended at the end", () => {
    const E = tool("touch");
    const r = classifyToolListDrift([A, B], [A, B, C, D, E]);
    expect(r.kind).toBe("append");
    expect(r.added).toEqual(["search", "delete", "touch"]);
  });

  it("edit: same names + same order, content of one tool changed", () => {
    const aEdited = tool("read", "now reads UTF-8 only");
    const r = classifyToolListDrift([A, B, C], [aEdited, B, C]);
    expect(r.kind).toBe("edit");
    expect(r.edited).toEqual(["read"]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("edit: schema change on the same tool", () => {
    const aSchema = tool("read", "", {
      type: "object",
      properties: { path: { type: "string" }, encoding: { type: "string" } },
    });
    const r = classifyToolListDrift([A], [aSchema]);
    expect(r.kind).toBe("edit");
    expect(r.edited).toEqual(["read"]);
  });

  it("remove: a tool present in before is missing from after", () => {
    const r = classifyToolListDrift([A, B, C], [A, C]);
    expect(r.kind).toBe("remove");
    expect(r.removed).toEqual(["write"]);
    expect(r.added).toEqual([]);
  });

  it("remove dominates: even if other tools were added, removal makes it `remove`", () => {
    // before: A, B, C  → after: A, C, D  (B removed, D added)
    const r = classifyToolListDrift([A, B, C], [A, C, D]);
    expect(r.kind).toBe("remove");
    expect(r.removed).toEqual(["write"]);
    expect(r.added).toEqual(["delete"]);
  });

  it("reorder: same name set in a different order", () => {
    const r = classifyToolListDrift([A, B, C], [B, A, C]);
    expect(r.kind).toBe("reorder");
  });

  it("reorder: addition NOT at the end (cache-equivalent to a reorder)", () => {
    const r = classifyToolListDrift([A, B, C], [A, D, B, C]);
    expect(r.kind).toBe("reorder");
  });

  it("identity with empty lists", () => {
    expect(classifyToolListDrift([], []).kind).toBe("identity");
  });

  it("append onto an empty list", () => {
    const r = classifyToolListDrift([], [A, B]);
    expect(r.kind).toBe("append");
    expect(r.added).toEqual(["read", "write"]);
  });

  it("remove down to an empty list", () => {
    const r = classifyToolListDrift([A, B], []);
    expect(r.kind).toBe("remove");
    expect(r.removed).toEqual(["read", "write"]);
  });
});
