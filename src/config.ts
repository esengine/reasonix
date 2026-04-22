/**
 * User-level config storage for the Reasonix CLI.
 *
 * Lookup order for the API key:
 *   1. `DEEPSEEK_API_KEY` env var (highest priority — for CI / power users)
 *   2. `~/.reasonix/config.json` (set by the first-run setup flow)
 *
 * The library itself never touches the config file — it only reads
 * `DEEPSEEK_API_KEY` from the environment. The CLI is responsible for
 * pulling from the config file and exposing it via env var to the loop.
 *
 * Beyond the API key, the config also remembers the user's *defaults*
 * from `reasonix setup`: preset, MCP servers, session. This is what
 * makes `reasonix chat` with no flags "just work" after first-run.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One of the preset bundles (model + harvest + branch combo). */
export type PresetName = "fast" | "smart" | "max";

export interface ReasonixConfig {
  apiKey?: string;
  baseUrl?: string;
  /**
   * Default preset for `reasonix chat` / `reasonix run` when no flags override.
   * Maps to model + harvest + branch combos (see presets.ts). Missing → "fast".
   */
  preset?: PresetName;
  /**
   * Default MCP server specs to bridge on every `reasonix chat`, in the
   * same `"name=cmd args..."` format that `--mcp` takes. Stored as strings
   * so `reasonix setup` stays symmetrical with the flag — one parser, one
   * format in the config file, grep-friendly.
   */
  mcp?: string[];
  /**
   * Default session name (null/missing → "default", which is what the
   * CLI has been doing anyway). `reasonix setup` lets users pick a name
   * or opt into ephemeral.
   */
  session?: string | null;
  /** Marks that `reasonix setup` has completed at least once. */
  setupCompleted?: boolean;
  /**
   * Whether `web_search` + `web_fetch` tools are registered. Default:
   * enabled (no key required — backed by DuckDuckGo's public HTML
   * endpoint). Set to `false` to keep the session offline.
   */
  search?: boolean;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".reasonix", "config.json");
}

export function readConfig(path: string = defaultConfigPath()): ReasonixConfig {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ReasonixConfig;
  } catch {
    /* missing or malformed → empty config */
  }
  return {};
}

export function writeConfig(cfg: ReasonixConfig, path: string = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
  // Restrict permissions on Unix; chmod is a no-op on Windows but won't throw.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore on platforms without chmod */
  }
}

/** Resolve the API key from env var first, then the config file. */
export function loadApiKey(path: string = defaultConfigPath()): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  return readConfig(path).apiKey;
}

/**
 * Resolve whether web-search tools should be registered. Default: on.
 * Env `REASONIX_SEARCH=off` or config `search: false` turns it off.
 * Any other value falls through to enabled.
 */
export function searchEnabled(path: string = defaultConfigPath()): boolean {
  const env = process.env.REASONIX_SEARCH;
  if (env === "off" || env === "false" || env === "0") return false;
  const cfg = readConfig(path).search;
  if (cfg === false) return false;
  return true;
}

export function saveApiKey(key: string, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.apiKey = key.trim();
  writeConfig(cfg, path);
}

export function isPlausibleKey(key: string): boolean {
  const trimmed = key.trim();
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(trimmed);
}

/** Mask a key for display: `sk-abcd...wxyz`. */
export function redactKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
