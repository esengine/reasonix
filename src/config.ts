/** Library reads only DEEPSEEK_API_KEY from env; the CLI bridges config.json → env var. */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageCode } from "./i18n/types.js";
import {
  type IndexUserConfig,
  type ResolvedIndexConfig,
  resolveIndexConfig,
} from "./index/config.js";

/** Legacy `fast|smart|max` kept for back-compat with existing config.json files. */
export type PresetName = "auto" | "flash" | "pro" | "fast" | "smart" | "max";

/** Single trust dial: review queues edits + gates shell; auto applies + gates shell; yolo skips both gates. */
export type EditMode = "review" | "auto" | "yolo";

export type ReasoningEffort = "high" | "max";

export interface ReasonixConfig {
  apiKey?: string;
  baseUrl?: string;
  lang?: LanguageCode;
  preset?: PresetName;
  editMode?: EditMode;
  editModeHintShown?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** Stored as `--mcp`-format strings so one parser handles both flag and config. */
  mcp?: string[];
  /** Names of servers in `mcp` to skip on bridge — see `/mcp disable <name>`. */
  mcpDisabled?: string[];
  session?: string | null;
  setupCompleted?: boolean;
  search?: boolean;
  /** Persisted sidebar visibility — undefined = auto (open on cols ≥ 120). */
  sidebarOpen?: boolean;
  projects?: {
    [absoluteRootDir: string]: {
      shellAllowed?: string[];
    };
  };
  index?: IndexUserConfig;
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

/** Resolve the language from config file. */
export function loadLanguage(path: string = defaultConfigPath()): LanguageCode | undefined {
  return readConfig(path).lang;
}

/** Persist the language so it survives a relaunch. */
export function saveLanguage(lang: LanguageCode, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.lang = lang;
  writeConfig(cfg, path);
}

/** Resolve the API key from env var first, then the config file. */
export function loadApiKey(path: string = defaultConfigPath()): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  return readConfig(path).apiKey;
}

export function loadSidebarOpen(path: string = defaultConfigPath()): boolean | undefined {
  return readConfig(path).sidebarOpen;
}

export function saveSidebarOpen(
  open: boolean | undefined,
  path: string = defaultConfigPath(),
): void {
  const cfg = readConfig(path);
  if (open === undefined) cfg.sidebarOpen = undefined;
  else cfg.sidebarOpen = open;
  writeConfig(cfg, path);
}

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

export function loadProjectShellAllowed(
  rootDir: string,
  path: string = defaultConfigPath(),
): string[] {
  const cfg = readConfig(path);
  return cfg.projects?.[rootDir]?.shellAllowed ?? [];
}

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

/** Match is exact after trim — NOT prefix-match: removing `git` MUST NOT drop `git push origin main`. */
export function removeProjectShellAllowed(
  rootDir: string,
  prefix: string,
  path: string = defaultConfigPath(),
): boolean {
  const trimmed = prefix.trim();
  if (!trimmed) return false;
  const cfg = readConfig(path);
  const existing = cfg.projects?.[rootDir]?.shellAllowed ?? [];
  if (!existing.includes(trimmed)) return false;
  const next = existing.filter((p) => p !== trimmed);
  if (!cfg.projects) cfg.projects = {};
  if (!cfg.projects[rootDir]) cfg.projects[rootDir] = {};
  cfg.projects[rootDir].shellAllowed = next;
  writeConfig(cfg, path);
  return true;
}

export function clearProjectShellAllowed(
  rootDir: string,
  path: string = defaultConfigPath(),
): number {
  const cfg = readConfig(path);
  const existing = cfg.projects?.[rootDir]?.shellAllowed ?? [];
  if (existing.length === 0) return 0;
  if (!cfg.projects) cfg.projects = {};
  if (!cfg.projects[rootDir]) cfg.projects[rootDir] = {};
  cfg.projects[rootDir].shellAllowed = [];
  writeConfig(cfg, path);
  return existing.length;
}

/** Unknown values fall back to "review" so hand-edited bad config gets the safe default. */
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

/** Unknown / missing fall back to "max" so hand-edited bad config can't silently override the default. */
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

export function loadIndexUserConfig(path: string = defaultConfigPath()): IndexUserConfig {
  return readConfig(path).index ?? {};
}

export function loadIndexConfig(path: string = defaultConfigPath()): ResolvedIndexConfig {
  return resolveIndexConfig(readConfig(path).index);
}

export function saveIndexConfig(user: IndexUserConfig, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.index = user;
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
