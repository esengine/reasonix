import { describe, expect, it } from "vitest";
import {
  DEFAULT_INDEX_EXCLUDES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_RESPECT_GITIGNORE,
  compileFilters,
  defaultIndexConfig,
  resolveIndexConfig,
} from "../src/index/config.js";

describe("resolveIndexConfig", () => {
  it("returns full defaults when user config is null", () => {
    const r = resolveIndexConfig(null);
    expect(r.excludeDirs).toEqual([...DEFAULT_INDEX_EXCLUDES.dirs]);
    expect(r.excludeFiles).toEqual([...DEFAULT_INDEX_EXCLUDES.files]);
    expect(r.excludeExts).toEqual([...DEFAULT_INDEX_EXCLUDES.exts]);
    expect(r.excludePatterns).toEqual([]);
    expect(r.respectGitignore).toBe(DEFAULT_RESPECT_GITIGNORE);
    expect(r.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it("user-provided field FULLY replaces the default for that field", () => {
    const r = resolveIndexConfig({ excludeDirs: ["only-this"] });
    expect(r.excludeDirs).toEqual(["only-this"]);
    expect(r.excludeFiles).toEqual([...DEFAULT_INDEX_EXCLUDES.files]);
  });

  it("absent fields fall back to defaults", () => {
    const r = resolveIndexConfig({ excludePatterns: ["**/*.gen.ts"] });
    expect(r.excludePatterns).toEqual(["**/*.gen.ts"]);
    expect(r.excludeDirs).toEqual([...DEFAULT_INDEX_EXCLUDES.dirs]);
  });

  it("normalises extensions to lowercase", () => {
    const r = resolveIndexConfig({ excludeExts: [".PNG", ".Mp4"] });
    expect(r.excludeExts).toEqual([".png", ".mp4"]);
  });

  it("ignores non-positive maxFileBytes and falls back to default", () => {
    expect(resolveIndexConfig({ maxFileBytes: 0 }).maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(resolveIndexConfig({ maxFileBytes: -5 }).maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it("respectGitignore false sticks (not coerced to default)", () => {
    expect(resolveIndexConfig({ respectGitignore: false }).respectGitignore).toBe(false);
  });
});

describe("compileFilters", () => {
  it("patternMatch returns false when no patterns are configured", () => {
    const f = compileFilters(defaultIndexConfig());
    expect(f.patternMatch("foo/bar.ts")).toBe(false);
  });

  it("patternMatch honours picomatch glob syntax", () => {
    const f = compileFilters(resolveIndexConfig({ excludePatterns: ["**/*.gen.ts", "vendor/**"] }));
    expect(f.patternMatch("src/foo.gen.ts")).toBe(true);
    expect(f.patternMatch("vendor/lib/x.ts")).toBe(true);
    expect(f.patternMatch("src/foo.ts")).toBe(false);
  });

  it("turns extension list into a set with lowercase lookup", () => {
    const f = compileFilters(resolveIndexConfig({ excludeExts: [".XYZ"] }));
    expect(f.extSet.has(".xyz")).toBe(true);
  });
});
