/** Tool-call ready progress — incrementing `toolCallReadyCount` lets the UI render "N ready · building call M". */

import { describe, expect, it } from "vitest";
import { looksLikeCompleteJson } from "../src/loop.js";

describe("looksLikeCompleteJson", () => {
  it("empty / whitespace → false", () => {
    expect(looksLikeCompleteJson("")).toBe(false);
    expect(looksLikeCompleteJson("   ")).toBe(false);
  });

  it("partial JSON → false (the common streaming case)", () => {
    expect(looksLikeCompleteJson("{")).toBe(false);
    expect(looksLikeCompleteJson('{"path"')).toBe(false);
    expect(looksLikeCompleteJson('{"path": "foo.md", "content": "hel')).toBe(false);
  });

  it("complete JSON object → true", () => {
    expect(looksLikeCompleteJson("{}")).toBe(true);
    expect(looksLikeCompleteJson('{"path": "foo.md", "content": "hello"}')).toBe(true);
  });

  it("complete JSON array → true", () => {
    expect(looksLikeCompleteJson("[]")).toBe(true);
    expect(looksLikeCompleteJson('[{"a": 1}]')).toBe(true);
  });

  it("primitive JSON values → true", () => {
    expect(looksLikeCompleteJson("true")).toBe(true);
    expect(looksLikeCompleteJson("42")).toBe(true);
    expect(looksLikeCompleteJson('"text"')).toBe(true);
  });

  it("valid JSON with trailing whitespace → true", () => {
    expect(looksLikeCompleteJson('{"a":1}\n')).toBe(true);
  });
});
