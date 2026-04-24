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

/**
 * How `reasonix code` handles model-issued edits:
 *   - "review" — queue the edit into pendingEdits; user /apply or `y` commits.
 *   - "auto"   — apply immediately, snapshot for /undo, show a short undo
 *                banner so the user can roll back with one keystroke.
 * Persisted so `/mode auto` survives a relaunch. Missing → "review".
 */
export type EditMode = "review" | "auto";

/**
 * reasoning_effort cap for the model. "max" is the agent-class default;
 * "high" is cheaper / faster. Persisted so `/effort high` survives a
 * relaunch — earlier versions silently reverted to "max" on every new
 * session, which burned budget unexpectedly.
 */
export type ReasoningEffort = "high" | "max";

export interface ReasonixConfig {
  apiKey?: string;
  baseUrl?: string;
  /**
   * Default preset for `reasonix chat` / `reasonix run` when no flags override.
   * Maps to model + harvest + branch combos (see presets.ts). Missing → "fast".
   */
  preset?: PresetName;
  /**
   * Edit-gate mode for `reasonix code`. See EditMode doc. Absent → "review".
   */
  editMode?: EditMode;
  /**
   * Set to `true` the first time we've shown the "Shift+Tab cycles
   * review/AUTO" onboarding tip in `reasonix code`. Once seen, we stop
   * posting the tip — the bottom status bar carries the knowledge
   * forward without further nagging.
   */
  editModeHintShown?: boolean;
  /**
   * Last reasoning_effort chosen via `/effort`. Loaded on launch so
   * "high" stays "high" — default is "max" when unset.
   */
  reasoningEffort?: ReasoningEffort;
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
  /**
   * Per-project state keyed by absolute directory path. Written by the
   * "always allow" choice on a shell confirmation prompt; merged into
   * `registerShellTools({ extraAllowed })` when `reasonix code` runs
   * against that directory again.
   */
  projects?: {
    [absoluteRootDir: string]: {
      shellAllowed?: string[];
    };
  };
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

/**
 * Read the persisted "always allow" shell-command prefixes for a
 * given project root. Returns an empty array when nothing's stored.
 */
export function loadProjectShellAllowed(
  rootDir: string,
  path: string = defaultConfigPath(),
): string[] {
  const cfg = readConfig(path);
  return cfg.projects?.[rootDir]?.shellAllowed ?? [];
}

/**
 * Append a prefix to the project's shell-allowed list, dedup and
 * persist. No-op if the prefix is empty/whitespace or already stored.
 */
export function addProjectShellAllowed(
  rootDir: string,
  prefix: string,
  path: string = defaultConfigPath(),
): void {
  const trimmed = prefix.trim();
  if (!trimmed) return;
  const cfg = readConfig(path);
  if (!cfg.projects) cfg.projects = {};
  if (!cfg.projects[rootDir]) cfg.projects[rootDir] = {};
  const existing = cfg.projects[rootDir].shellAllowed ?? [];
  if (existing.includes(trimmed)) return;
  cfg.projects[rootDir].shellAllowed = [...existing, trimmed];
  writeConfig(cfg, path);
}

/**
 * Read the persisted edit-mode. Unknown values fall back to "review" so
 * a user who hand-edits the file into an invalid state still gets the
 * safe default. `reasonix code` calls this at launch and the App lets
 * `/mode` / Shift+Tab flip it.
 */
export function loadEditMode(path: string = defaultConfigPath()): EditMode {
  const v = readConfig(path).editMode;
  return v === "auto" ? "auto" : "review";
}

/** Persist the edit mode so `/mode auto` survives a relaunch. */
export function saveEditMode(mode: EditMode, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.editMode = mode;
  writeConfig(cfg, path);
}

/** True when the onboarding tip for the review/AUTO gate has been shown. */
export function editModeHintShown(path: string = defaultConfigPath()): boolean {
  return readConfig(path).editModeHintShown === true;
}

/**
 * Read the persisted reasoning_effort. Unknown / missing values fall
 * back to "max" so the agent-class default is never silently overridden
 * by a hand-edited bad value in config.json.
 */
export function loadReasoningEffort(path: string = defaultConfigPath()): ReasoningEffort {
  const v = readConfig(path).reasoningEffort;
  return v === "high" ? "high" : "max";
}

/** Persist the reasoning_effort cap so `/effort high` survives a relaunch. */
export function saveReasoningEffort(
  effort: ReasoningEffort,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  cfg.reasoningEffort = effort;
  writeConfig(cfg, path);
}

/** Mark the onboarding tip as shown so subsequent launches skip it. */
export function markEditModeHintShown(path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  if (cfg.editModeHintShown === true) return;
  cfg.editModeHintShown = true;
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
