/**
 * Version module.
 *
 * Two jobs:
 *
 *   1. Expose `VERSION` sourced from the real `package.json` so the
 *      constant never drifts from what npm publishes. Works in dev
 *      (`tsx src/...`) AND after `tsup` bundles to `dist/` — both
 *      layouts sit two levels below the manifest, so a short
 *      walk-up finds it.
 *
 *   2. Offer an opt-in `getLatestVersion()` that hits the npm
 *      registry with a bounded timeout and a 24-hour on-disk
 *      cache at `~/.reasonix/version-cache.json`. Returns `null`
 *      on any failure — offline / restricted-network launches
 *      should stay silent rather than nag the user.
 *
 * The CLI wires `getLatestVersion` asynchronously at App mount
 * (never in a hot path) and renders the outcome in the stats
 * panel when there's a newer published version.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** npm registry endpoint for the `latest` dist-tag of this package. */
const REGISTRY_URL = "https://registry.npmjs.org/reasonix/latest";

/** TTL for the on-disk cache entry. 24h keeps noise low; users who
 * want a fresh check can run `reasonix update` which passes
 * `force: true`. */
export const LATEST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Network timeout. Short — we never block the UI waiting on this. */
export const LATEST_FETCH_TIMEOUT_MS = 2_000;

/**
 * Walk up from the current source file looking for the `reasonix`
 * package.json. Works for:
 *   - dev: `src/version.ts` → `F:/Reasonix/package.json` (2 levels up)
 *   - built: `dist/index.js` → `F:/Reasonix/package.json` (2 levels up)
 *   - global install: `.../node_modules/reasonix/dist/index.js` → `.../reasonix/package.json`
 *
 * The `name === "reasonix"` guard is a cheap safety net against
 * picking up the nearest *other* package.json if we're ever loaded
 * as a dependency and the layout is unusual.
 */
function readPackageVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const p = join(dir, "package.json");
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf8"));
        if (pkg?.name === "reasonix" && typeof pkg.version === "string") {
          return pkg.version;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through to fallback */
  }
  return "0.0.0-dev";
}

export const VERSION: string = readPackageVersion();

interface VersionCacheEntry {
  version: string;
  /** Epoch millis the entry was written. Drives TTL comparisons. */
  checkedAt: number;
}

function cachePath(homeDirOverride?: string): string {
  return join(homeDirOverride ?? homedir(), ".reasonix", "version-cache.json");
}

function readCache(homeDirOverride?: string): VersionCacheEntry | null {
  try {
    const raw = readFileSync(cachePath(homeDirOverride), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === "string" && typeof parsed.checkedAt === "number") {
      return parsed;
    }
  } catch {
    /* missing or malformed → no cached entry */
  }
  return null;
}

function writeCache(entry: VersionCacheEntry, homeDirOverride?: string): void {
  try {
    const p = cachePath(homeDirOverride);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(entry), "utf8");
  } catch {
    /* cache is best-effort — a failed write just means we'll re-fetch
     * next launch. No reason to surface this to the user. */
  }
}

export interface GetLatestVersionOptions {
  /** Ignore the cached entry and always fetch fresh. Used by `reasonix update`. */
  force?: boolean;
  /** Registry URL override (tests). */
  registryUrl?: string;
  /** Home-directory override (tests). */
  homeDir?: string;
  /** Fetch implementation override (tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** TTL override (tests). */
  ttlMs?: number;
  /** Network timeout override (tests). */
  timeoutMs?: number;
}

/**
 * Resolve the latest published `reasonix` version from the npm registry.
 *
 * Returns `null` on any network / parse failure. Callers treat `null`
 * as "don't know, don't nag the user." The cache entry is only
 * written on a successful fetch — a bad registry response won't
 * poison the cache.
 */
export async function getLatestVersion(opts: GetLatestVersionOptions = {}): Promise<string | null> {
  const ttl = opts.ttlMs ?? LATEST_CACHE_TTL_MS;
  if (!opts.force) {
    const cached = readCache(opts.homeDir);
    if (cached && Date.now() - cached.checkedAt < ttl) return cached.version;
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) return null;
  const url = opts.registryUrl ?? REGISTRY_URL;
  const timeout = opts.timeoutMs ?? LATEST_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string") return null;
    writeCache({ version: body.version, checkedAt: Date.now() }, opts.homeDir);
    return body.version;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Semver compare. Returns a negative number when `a < b`, positive
 * when `a > b`, zero when equal.
 *
 * Minimal pre-release handling: when the CORE (`x.y.z`) parts match,
 * any version WITH a suffix (`-rc.1`, `-alpha.4`) compares LOWER
 * than the bare version. That matches npm's dist-tag semantics —
 * `reasonix@latest` resolves to a real release, not a pre-release.
 *
 * We're deliberately not pulling in `semver` (~50KB). The three
 * cases we care about are: current > latest (future build, no
 * prompt), current < latest (prompt), current === latest (no prompt).
 */
export function compareVersions(a: string, b: string): number {
  const [aCore = "0", aPre = ""] = a.split("-", 2);
  const [bCore = "0", bPre = ""] = b.split("-", 2);
  const aParts = aCore.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const bParts = bCore.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
}

/**
 * Heuristic: did this process launch via `npx` / `pnpm dlx` instead
 * of a global install? The update command takes different advice in
 * each case — a global install can `npm i -g reasonix@latest`, while
 * npx just needs its cache to roll over on next launch.
 *
 * Signals checked, in order:
 *   - `process.argv[1]` contains `_npx` (npm's ephemeral dir name)
 *   - `process.argv[1]` contains `.pnpm` + `dlx`
 *   - `npm_config_user_agent` contains `npx/`
 *
 * Any one hit → npx. False negatives are safe (worst case we suggest
 * `npm i -g` to an npx user, which is a valid way to upgrade too).
 */
export function isNpxInstall(): boolean {
  const bin = process.argv[1] ?? "";
  if (/[/\\]_npx[/\\]/.test(bin)) return true;
  if (/[/\\]\.pnpm[/\\]/.test(bin) && /dlx/i.test(bin)) return true;
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.includes("npx/")) return true;
  return false;
}
