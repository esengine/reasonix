import { describe, expect, it } from "vitest";
import { PRESETS, canonicalPresetName, resolvePreset } from "../src/cli/ui/presets.js";

describe("resolvePreset", () => {
  it("resolves built-in presets by canonical name", () => {
    expect(resolvePreset("auto").model).toBe("deepseek-v4-flash");
    expect(resolvePreset("flash").autoEscalate).toBe(false);
    expect(resolvePreset("pro").reasoningEffort).toBe("max");
  });

  it("maps legacy aliases to current behavior", () => {
    expect(resolvePreset("fast")).toMatchObject({
      ...resolvePreset("flash"),
      reasoningEffort: "high",
    });
    expect(resolvePreset("smart")).toMatchObject(resolvePreset("auto"));
    expect(resolvePreset("max")).toMatchObject(resolvePreset("pro"));
  });

  it("falls back to auto when given undefined", () => {
    expect(resolvePreset(undefined)).toMatchObject(resolvePreset("auto"));
  });

  it("falls back to auto when given unknown values", () => {
    expect(resolvePreset("definitely-not-a-preset" as unknown as never)).toMatchObject(
      resolvePreset("auto"),
    );
  });
});

describe("canonicalPresetName", () => {
  it("returns canonical names for built-ins", () => {
    expect(canonicalPresetName("auto")).toBe("auto");
    expect(canonicalPresetName("flash")).toBe("flash");
    expect(canonicalPresetName("pro")).toBe("pro");
  });

  it("normalizes legacy names to auto", () => {
    expect(canonicalPresetName("fast")).toBe("auto");
    expect(canonicalPresetName("smart")).toBe("auto");
    expect(canonicalPresetName("max")).toBe("auto");
  });

  it("normalizes unknown values to auto", () => {
    expect(canonicalPresetName("old" as unknown as never)).toBe("auto");
  });
});

describe("preset invariants", () => {
  it("keeps branch and harvest fixed across all presets", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(preset.harvest).toBe(false);
      expect(preset.branch).toBe(1);
      expect(["auto", "flash", "pro"]).toContain(name);
    }
  });
});
