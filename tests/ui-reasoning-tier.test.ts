import { describe, expect, it } from "vitest";
import { modelBadgeFor } from "../src/cli/ui/primitives/Pill.js";

describe("modelBadgeFor", () => {
  it("maps deepseek-v4-flash to flash class", () => {
    expect(modelBadgeFor("deepseek-v4-flash")).toEqual({ label: "v4-flash", kind: "flash" });
  });

  it("maps the legacy deepseek-chat alias to flash class", () => {
    expect(modelBadgeFor("deepseek-chat")).toEqual({ label: "v4-flash", kind: "flash" });
  });

  it("maps deepseek-v4-pro to pro class", () => {
    expect(modelBadgeFor("deepseek-v4-pro")).toEqual({ label: "v4-pro", kind: "pro" });
  });

  it("maps deepseek-r1 and deepseek-reasoner to r1 class", () => {
    expect(modelBadgeFor("deepseek-r1")).toEqual({ label: "r1", kind: "r1" });
    expect(modelBadgeFor("deepseek-reasoner")).toEqual({ label: "r1", kind: "r1" });
  });

  it("falls back to unknown class for anything else, stripping the deepseek- prefix", () => {
    expect(modelBadgeFor("deepseek-v5-experimental")).toEqual({
      label: "v5-experimental",
      kind: "unknown",
    });
    expect(modelBadgeFor(undefined)).toEqual({ label: "?", kind: "unknown" });
  });
});
