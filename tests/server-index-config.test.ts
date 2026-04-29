import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { DEFAULT_INDEX_EXCLUDES } from "../src/index/config.js";
import { handleIndexConfig } from "../src/server/api/index-config.js";
import type { DashboardContext } from "../src/server/context.js";

function makeCtx(configPath: string): DashboardContext {
  return {
    configPath,
    usageLogPath: configPath.replace(/config\.json$/, "usage.jsonl"),
    mode: "standalone",
  };
}

describe("/api/index-config", () => {
  let dir: string;
  let cfg: string;
  let ctx: DashboardContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reasonix-cfg-"));
    cfg = join(dir, "config.json");
    ctx = makeCtx(cfg);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("GET returns defaults when no user config is set", async () => {
    const r = await handleIndexConfig("GET", [], "", ctx);
    expect(r.status).toBe(200);
    const body = r.body as {
      user: Record<string, unknown>;
      resolved: { excludeDirs: string[]; respectGitignore: boolean };
      defaults: { excludeDirs: string[] };
    };
    expect(body.user).toEqual({});
    expect(body.resolved.excludeDirs).toEqual([...DEFAULT_INDEX_EXCLUDES.dirs]);
    expect(body.resolved.respectGitignore).toBe(true);
    expect(body.defaults.excludeDirs).toEqual([...DEFAULT_INDEX_EXCLUDES.dirs]);
  });

  it("POST persists fields to config.json and round-trips through GET", async () => {
    const post = await handleIndexConfig(
      "POST",
      [],
      JSON.stringify({
        excludePatterns: ["**/*.gen.ts"],
        respectGitignore: false,
        maxFileBytes: 1024,
      }),
      ctx,
    );
    expect(post.status).toBe(200);
    const postBody = post.body as { changed: string[] };
    expect(postBody.changed.sort()).toEqual([
      "excludePatterns",
      "maxFileBytes",
      "respectGitignore",
    ]);

    const onDisk = readConfig(cfg);
    expect(onDisk.index?.excludePatterns).toEqual(["**/*.gen.ts"]);
    expect(onDisk.index?.respectGitignore).toBe(false);
    expect(onDisk.index?.maxFileBytes).toBe(1024);

    const get = await handleIndexConfig("GET", [], "", ctx);
    const body = get.body as {
      user: { excludePatterns: string[] };
      resolved: { excludePatterns: string[]; respectGitignore: boolean };
    };
    expect(body.user.excludePatterns).toEqual(["**/*.gen.ts"]);
    expect(body.resolved.respectGitignore).toBe(false);
  });

  it("POST rejects bad shapes with 400", async () => {
    const r = await handleIndexConfig(
      "POST",
      [],
      JSON.stringify({ excludeDirs: "not-an-array" }),
      ctx,
    );
    expect(r.status).toBe(400);
  });

  it("POST rejects non-positive maxFileBytes", async () => {
    const r = await handleIndexConfig("POST", [], JSON.stringify({ maxFileBytes: 0 }), ctx);
    expect(r.status).toBe(400);
  });

  it("non-GET/POST methods return 405", async () => {
    const r = await handleIndexConfig("DELETE", [], "", ctx);
    expect(r.status).toBe(405);
  });

  it("subsequent POST merges with existing config (does not wipe other fields)", async () => {
    await handleIndexConfig("POST", [], JSON.stringify({ excludePatterns: ["a"] }), ctx);
    await handleIndexConfig("POST", [], JSON.stringify({ maxFileBytes: 999 }), ctx);
    const onDisk = readConfig(cfg);
    expect(onDisk.index?.excludePatterns).toEqual(["a"]);
    expect(onDisk.index?.maxFileBytes).toBe(999);
  });

  describe("preview", () => {
    let project: string;

    beforeEach(async () => {
      project = await mkdtemp(join(tmpdir(), "reasonix-preview-"));
      await fs.writeFile(join(project, "main.ts"), "ok\n");
      await fs.writeFile(join(project, "drop.gen.ts"), "noise\n");
      await fs.mkdir(join(project, "node_modules"), { recursive: true });
      await fs.writeFile(join(project, "node_modules", "x.ts"), "x\n");
      ctx = { ...makeCtx(cfg), getCurrentCwd: () => project };
    });

    afterEach(async () => {
      await rm(project, { recursive: true, force: true });
    });

    it("returns 400 when no project root is attached", async () => {
      const noRootCtx = makeCtx(cfg);
      const r = await handleIndexConfig("POST", ["preview"], JSON.stringify({}), noRootCtx);
      expect(r.status).toBe(400);
    });

    it("dry-walks the project root and returns sample paths + skip buckets", async () => {
      const r = await handleIndexConfig(
        "POST",
        ["preview"],
        JSON.stringify({ excludePatterns: ["**/*.gen.ts"] }),
        ctx,
      );
      expect(r.status).toBe(200);
      const body = r.body as {
        filesIncluded: number;
        sampleIncluded: string[];
        skipBuckets: Record<string, number>;
        skipSamples: Record<string, string[]>;
      };
      expect(body.sampleIncluded).toContain("main.ts");
      expect(body.sampleIncluded).not.toContain("drop.gen.ts");
      expect(body.skipBuckets.pattern).toBeGreaterThanOrEqual(1);
      expect(body.skipBuckets.defaultDir).toBeGreaterThanOrEqual(1);
      expect(body.skipSamples.pattern).toContain("drop.gen.ts");
    });
  });
});
