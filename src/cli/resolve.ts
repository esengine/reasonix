/**
 * Merge config defaults with CLI flags into the concrete options that
 * `chatCommand` / `runCommand` need.
 *
 * Precedence (highest wins):
 *   1. Explicit per-setting CLI flag (`--model`, `--harvest`, `--branch`, `--mcp`)
 *   2. Explicit `--preset <name>` CLI flag
 *   3. `config.preset` from `~/.reasonix/config.json` (set by `reasonix setup`)
 *   4. Hardcoded "smart" preset defaults (flash + effort=max)
 *
 * Keeping this logic in one place — rather than duplicating across
 * `chat` and `run` — means the precedence rule only lives in one unit
 * test and the shape of the merge is identical for both commands.
 */

import { type PresetName, type ReasonixConfig, readConfig } from "../config.js";
import { PRESETS } from "./ui/presets.js";

export interface ResolvedDefaults {
  model: string;
  reasoningEffort: "high" | "max";
  harvest: boolean;
  branch: number | undefined;
  mcp: string[];
  session: string | undefined;
}

export interface RawCliFlags {
  model?: string;
  harvest?: boolean;
  /** From `commander`; already parseInt'd. */
  branch?: number;
  mcp?: string[];
  /** Commander's `--no-session` surfaces as `false`; `--session X` as a string. */
  session?: string | false;
  /** `--preset <name>`. */
  preset?: string;
  /** When true, ignore config entirely (power-user escape hatch). */
  noConfig?: boolean;
}

export function resolveDefaults(flags: RawCliFlags): ResolvedDefaults {
  const cfg: ReasonixConfig = flags.noConfig ? {} : readConfig();
  const preset = pickPreset(flags.preset, cfg.preset);
  const presetSettings = PRESETS[preset];

  const model = flags.model ?? presetSettings.model;
  const reasoningEffort = presetSettings.reasoningEffort;
  const harvest = flags.harvest === true ? true : presetSettings.harvest;
  const branchFromFlag = normalizeBranch(flags.branch);
  const branch = branchFromFlag ?? (presetSettings.branch > 1 ? presetSettings.branch : undefined);

  // `--mcp` accumulator is [] when absent. Treat empty from flags as
  // "user didn't pass" → fall through to config. Users who explicitly
  // want zero MCP servers can pass `--no-config` or edit the file.
  const mcp = flags.mcp && flags.mcp.length > 0 ? flags.mcp : (cfg.mcp ?? []);

  const session = resolveSession(flags.session, cfg.session);

  return { model, reasoningEffort, harvest, branch, mcp, session };
}

function pickPreset(
  flagPreset: string | undefined,
  configPreset: PresetName | undefined,
): PresetName {
  if (flagPreset && isPresetName(flagPreset)) return flagPreset;
  if (configPreset) return configPreset;
  return "smart";
}

function isPresetName(s: string): s is PresetName {
  return s === "fast" || s === "smart" || s === "max";
}

function normalizeBranch(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw <= 1) return undefined;
  return Math.min(raw, 8);
}

function resolveSession(
  flag: string | false | undefined,
  configSession: string | null | undefined,
): string | undefined {
  if (flag === false) return undefined; // --no-session
  if (typeof flag === "string" && flag.length > 0) return flag;
  if (configSession === null) return undefined; // config opted out
  if (typeof configSession === "string" && configSession.length > 0) return configSession;
  return "default";
}

/**
 * Resolve the `-c/--continue` flag into a concrete `(session, forceResume)`
 * pair. When the flag is set we ask `getLatestSession` for the most-recently-
 * touched saved session and skip the picker; if nothing is on disk we
 * fall back silently to `fallbackSession` after emitting a single warning
 * line via `warn`.
 *
 * Pure & testable: callers inject the fs lookup. `cli/index.ts` plugs in
 * `() => listSessions()[0]`; tests pass a deterministic stub.
 */
export function resolveContinueFlag(
  flag: boolean | undefined,
  fallbackSession: string | undefined,
  getLatestSession: () => { name: string } | undefined,
  warn: (msg: string) => void = () => {},
): { session: string | undefined; forceResume: boolean } {
  if (!flag) return { session: fallbackSession, forceResume: false };
  const latest = getLatestSession();
  if (!latest) {
    warn("▸ -c/--continue: no saved sessions yet — starting a fresh one.");
    return { session: fallbackSession, forceResume: false };
  }
  return { session: latest.name, forceResume: true };
}
