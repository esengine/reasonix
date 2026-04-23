/**
 * Tests for the version module — semver compare, npx detection, and
 * the cached latest-version fetcher. Network is fully mocked: every
 * `fetch` call goes through an injected stub so tests work offline
 * and across CI providers without flake risk.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LATEST_CACHE_TTL_MS,
  VERSION,
  compareVersions,
  getLatestVersion,
  isNpxInstall,
} from "../src/version.js";

describe("VERSION", () => {
  it("matches the published package.json version", () => {
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});

describe("compareVersions", () => {
  it("compares major/minor/patch numerically", () => {
    expect(compareVersions("0.4.22", "0.4.22")).toBe(0);
    expect(compareVersions("0.4.21", "0.4.22")).toBeLessThan(0);
    expect(compareVersions("0.4.22", "0.4.21")).toBeGreaterThan(0);
    expect(compareVersions("0.5.0", "0.4.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("treats pre-release suffix as lower than bare version", () => {
    expect(compareVersions("0.4.22-rc.1", "0.4.22")).toBeLessThan(0);
    expect(compareVersions("0.4.22", "0.4.22-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.4.22-alpha.1", "0.4.22-alpha.1")).toBe(0);
    expect(compareVersions("0.4.22-alpha.1", "0.4.22-alpha.2")).toBeLessThan(0);
  });

  it("tolerates mismatched part counts", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.2.1")).toBeLessThan(0);
  });
});

describe("isNpxInstall", () => {
  const originalArgv1 = process.argv[1];
  const originalUa = process.env.npm_config_user_agent;

  afterEach(() => {
    process.argv[1] = originalArgv1;
    if (originalUa === undefined) {
      // biome-ignore lint/performance/noDelete: restore missing env var exactly
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = originalUa;
    }
  });

  it("detects _npx path fragment", () => {
    process.argv[1] = "/Users/x/.npm/_npx/abc123/node_modules/.bin/reasonix";
    // biome-ignore lint/performance/noDelete: cover the no-env case
    delete process.env.npm_config_user_agent;
    expect(isNpxInstall()).toBe(true);
  });

  it("detects npx via user-agent string", () => {
    process.argv[1] = "/usr/local/bin/reasonix";
    process.env.npm_config_user_agent = "npx/10.2.4 npm/10.2.4 node/v20.10.0";
    expect(isNpxInstall()).toBe(true);
  });

  it("returns false for plain global install", () => {
    process.argv[1] = "/usr/local/lib/node_modules/reasonix/dist/cli/index.js";
    // biome-ignore lint/performance/noDelete: cover the no-env case
    delete process.env.npm_config_user_agent;
    expect(isNpxInstall()).toBe(false);
  });
});

describe("getLatestVersion", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-version-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function makeFetch(
    body: unknown,
    { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
  ): typeof fetch {
    return (async () =>
      ({
        ok,
        status,
        json: async () => body,
      }) as unknown as Response) as typeof fetch;
  }

  it("fetches from the registry and caches the result", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: true, json: async () => ({ version: "0.9.9" }) } as unknown as Response;
    }) as typeof fetch;

    const v1 = await getLatestVersion({ homeDir: home, fetchImpl });
    expect(v1).toBe("0.9.9");
    expect(calls).toBe(1);

    // Within TTL, no second network call.
    const v2 = await getLatestVersion({ homeDir: home, fetchImpl });
    expect(v2).toBe("0.9.9");
    expect(calls).toBe(1);

    // Cache file exists and parses.
    const cacheFile = join(home, ".reasonix", "version-cache.json");
    expect(existsSync(cacheFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(parsed.version).toBe("0.9.9");
    expect(typeof parsed.checkedAt).toBe("number");
  });

  it("force:true bypasses the cache", async () => {
    writeFileSync(join(home, ".reasonix-cache-preseed.json"), ""); // just ensures the tmp dir is real
    // Preseed the cache directly.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".reasonix"), { recursive: true });
    writeFileSync(
      join(home, ".reasonix", "version-cache.json"),
      JSON.stringify({ version: "0.1.0", checkedAt: Date.now() }),
    );

    const fetchImpl = makeFetch({ version: "0.9.9" });
    const v = await getLatestVersion({ homeDir: home, fetchImpl, force: true });
    expect(v).toBe("0.9.9");
  });

  it("honors an expired cache entry as stale and refetches", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".reasonix"), { recursive: true });
    writeFileSync(
      join(home, ".reasonix", "version-cache.json"),
      JSON.stringify({
        version: "0.1.0",
        checkedAt: Date.now() - LATEST_CACHE_TTL_MS - 1000,
      }),
    );
    const fetchImpl = makeFetch({ version: "0.9.9" });
    const v = await getLatestVersion({ homeDir: home, fetchImpl });
    expect(v).toBe("0.9.9");
  });

  it("returns null when fetch throws (offline)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const v = await getLatestVersion({ homeDir: home, fetchImpl });
    expect(v).toBeNull();
  });

  it("returns null when the registry returns non-OK", async () => {
    const fetchImpl = makeFetch({}, { ok: false, status: 500 });
    const v = await getLatestVersion({ homeDir: home, fetchImpl });
    expect(v).toBeNull();
  });

  it("returns null when the body has no version string", async () => {
    const fetchImpl = makeFetch({ notVersion: true });
    const v = await getLatestVersion({ homeDir: home, fetchImpl });
    expect(v).toBeNull();
  });

  it("swallows cache write failures silently", async () => {
    // Point homeDir at a file (not a directory) — mkdirSync will
    // fail and writeCache should ignore the error. Returned version
    // is still the freshly fetched one.
    const fetchImpl = makeFetch({ version: "0.9.9" });
    const busted = join(home, "not-a-dir");
    writeFileSync(busted, "blocker");
    const v = await getLatestVersion({ homeDir: busted, fetchImpl });
    expect(v).toBe("0.9.9");
  });
});
