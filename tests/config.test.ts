import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPlausibleKey,
  loadApiKey,
  readConfig,
  redactKey,
  saveApiKey,
  searchEnabled,
  writeConfig,
} from "../src/config.js";

describe("config", () => {
  let dir: string;
  let path: string;
  const originalEnv = process.env.DEEPSEEK_API_KEY;
  const originalSearch = process.env.REASONIX_SEARCH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-test-"));
    path = join(dir, "config.json");
    // biome-ignore lint/performance/noDelete: the string "undefined" leaks into process.env otherwise
    delete process.env.DEEPSEEK_API_KEY;
    // biome-ignore lint/performance/noDelete: same reason
    delete process.env.REASONIX_SEARCH;
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: same reason as beforeEach
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalEnv;
    }
    if (originalSearch === undefined) {
      // biome-ignore lint/performance/noDelete: same reason
      delete process.env.REASONIX_SEARCH;
    } else {
      process.env.REASONIX_SEARCH = originalSearch;
    }
  });

  it("readConfig returns {} when file is missing", () => {
    expect(readConfig(path)).toEqual({});
  });

  it("writeConfig + readConfig round-trip", () => {
    writeConfig({ apiKey: "sk-test123abcdefghijkl" }, path);
    expect(readConfig(path).apiKey).toBe("sk-test123abcdefghijkl");
  });

  it("saveApiKey trims whitespace", () => {
    saveApiKey("  sk-test123abcdefghijkl  ", path);
    expect(readConfig(path).apiKey).toBe("sk-test123abcdefghijkl");
  });

  it("loadApiKey prefers env var over config file", () => {
    saveApiKey("sk-fromfile1234567890ab", path);
    process.env.DEEPSEEK_API_KEY = "sk-fromenv1234567890abcd";
    expect(loadApiKey(path)).toBe("sk-fromenv1234567890abcd");
  });

  it("loadApiKey falls back to config file when env unset", () => {
    saveApiKey("sk-fromfile1234567890ab", path);
    expect(loadApiKey(path)).toBe("sk-fromfile1234567890ab");
  });

  it("loadApiKey returns undefined when nothing set", () => {
    expect(loadApiKey(path)).toBeUndefined();
  });

  it("isPlausibleKey accepts valid sk- keys", () => {
    expect(isPlausibleKey("sk-1234567890abcdef")).toBe(true);
    expect(isPlausibleKey("sk-abcDEF_123-456789012")).toBe(true);
  });

  it("isPlausibleKey rejects bad input", () => {
    expect(isPlausibleKey("")).toBe(false);
    expect(isPlausibleKey("hello")).toBe(false);
    expect(isPlausibleKey("sk-short")).toBe(false);
    expect(isPlausibleKey("token-1234567890abcdef")).toBe(false);
  });

  it("redactKey hides the middle", () => {
    expect(redactKey("sk-1234567890abcdefghij")).toBe("sk-123…ghij");
    expect(redactKey("short")).toBe("****");
    expect(redactKey("")).toBe("");
  });

  it("round-trips the full ReasonixConfig (preset, mcp, session, setupCompleted)", () => {
    writeConfig(
      {
        apiKey: "sk-test123abcdefghijkl",
        preset: "smart",
        mcp: [
          "filesystem=npx -y @modelcontextprotocol/server-filesystem /tmp/safe",
          "memory=npx -y @modelcontextprotocol/server-memory",
        ],
        session: "work",
        setupCompleted: true,
      },
      path,
    );
    const loaded = readConfig(path);
    expect(loaded.preset).toBe("smart");
    expect(loaded.mcp).toHaveLength(2);
    expect(loaded.session).toBe("work");
    expect(loaded.setupCompleted).toBe(true);
  });

  it("session: null in the config means the user opted out of persistence", () => {
    writeConfig({ apiKey: "sk-xxxxxxxxxxxxxxxxxxxx", session: null }, path);
    const loaded = readConfig(path);
    expect(loaded.session).toBeNull();
  });

  it("searchEnabled defaults to true with no config and no env", () => {
    expect(searchEnabled(path)).toBe(true);
  });

  it("searchEnabled honours `search: false` in the config file", () => {
    writeConfig({ apiKey: "sk-test123abcdefghijkl", search: false }, path);
    expect(searchEnabled(path)).toBe(false);
  });

  it("searchEnabled honours REASONIX_SEARCH=off/false/0", () => {
    process.env.REASONIX_SEARCH = "off";
    expect(searchEnabled(path)).toBe(false);
    process.env.REASONIX_SEARCH = "false";
    expect(searchEnabled(path)).toBe(false);
    process.env.REASONIX_SEARCH = "0";
    expect(searchEnabled(path)).toBe(false);
  });

  it("searchEnabled stays true for unrelated env values", () => {
    process.env.REASONIX_SEARCH = "on";
    expect(searchEnabled(path)).toBe(true);
  });

  it("env off beats config true", () => {
    writeConfig({ apiKey: "sk-test123abcdefghijkl", search: true }, path);
    process.env.REASONIX_SEARCH = "off";
    expect(searchEnabled(path)).toBe(false);
  });
});
