import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveIndexConfig } from "../src/index/config.js";
import { type SkipReason, chunkDirectory, walkChunks } from "../src/index/semantic/chunker.js";

describe("walkChunks excludes", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reasonix-excludes-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("skips files matched by user excludePatterns and reports reason `pattern`", async () => {
    await fs.writeFile(join(root, "keep.ts"), "ok\n");
    await fs.writeFile(join(root, "drop.gen.ts"), "noise\n");
    const reasons: Record<string, SkipReason> = {};
    const chunks = await chunkDirectory(root, {
      config: resolveIndexConfig({ excludePatterns: ["**/*.gen.ts"] }),
      onSkip: (p, r) => {
        reasons[p] = r;
      },
    });
    const paths = chunks.map((c) => c.path);
    expect(paths).toContain("keep.ts");
    expect(paths).not.toContain("drop.gen.ts");
    expect(reasons["drop.gen.ts"]).toBe("pattern");
  });

  it("honours .gitignore at the project root by default", async () => {
    await fs.writeFile(join(root, ".gitignore"), "secret.txt\nbuild-out/\n");
    await fs.mkdir(join(root, "build-out"), { recursive: true });
    await fs.writeFile(join(root, "build-out", "x.ts"), "noise\n");
    await fs.writeFile(join(root, "secret.txt"), "shh\n");
    await fs.writeFile(join(root, "main.ts"), "ok\n");
    const reasons: Record<string, SkipReason> = {};
    const chunks = await chunkDirectory(root, {
      onSkip: (p, r) => {
        reasons[p] = r;
      },
    });
    const paths = chunks.map((c) => c.path);
    expect(paths).toContain("main.ts");
    expect(paths).not.toContain("secret.txt");
    expect(paths.some((p) => p.startsWith("build-out/"))).toBe(false);
    expect(reasons["secret.txt"]).toBe("gitignore");
  });

  it("does not read .gitignore when respectGitignore is false", async () => {
    await fs.writeFile(join(root, ".gitignore"), "secret.txt\n");
    await fs.writeFile(join(root, "secret.txt"), "shh\n");
    await fs.writeFile(join(root, "main.ts"), "ok\n");
    const chunks = await chunkDirectory(root, {
      config: resolveIndexConfig({ respectGitignore: false }),
    });
    const paths = chunks.map((c) => c.path);
    expect(paths).toContain("secret.txt");
    expect(paths).toContain("main.ts");
  });

  it("reports `defaultDir` when a built-in dir is skipped", async () => {
    await fs.mkdir(join(root, "node_modules", "foo"), { recursive: true });
    await fs.writeFile(join(root, "node_modules", "foo", "x.ts"), "x\n");
    await fs.writeFile(join(root, "main.ts"), "ok\n");
    const reasons: Record<string, SkipReason> = {};
    await chunkDirectory(root, {
      onSkip: (p, r) => {
        reasons[p] = r;
      },
    });
    expect(reasons.node_modules).toBe("defaultDir");
  });

  it("reports `tooLarge` when a file exceeds the configured limit", async () => {
    await fs.writeFile(join(root, "big.ts"), "x".repeat(2000));
    const reasons: Record<string, SkipReason> = {};
    await chunkDirectory(root, {
      config: resolveIndexConfig({ maxFileBytes: 1000 }),
      onSkip: (p, r) => {
        reasons[p] = r;
      },
    });
    expect(reasons["big.ts"]).toBe("tooLarge");
  });

  it("honours nested .gitignore — patterns are scoped to their own directory", async () => {
    await fs.mkdir(join(root, "pkg-a"), { recursive: true });
    await fs.mkdir(join(root, "pkg-b"), { recursive: true });
    await fs.writeFile(join(root, ".gitignore"), "global-skip.ts\n");
    await fs.writeFile(join(root, "pkg-a", ".gitignore"), "local-only.ts\n");
    await fs.writeFile(join(root, "global-skip.ts"), "x\n");
    await fs.writeFile(join(root, "pkg-a", "local-only.ts"), "x\n");
    await fs.writeFile(join(root, "pkg-a", "kept.ts"), "x\n");
    // Same name as pkg-a's local-only — pkg-b doesn't have its own .gitignore
    // so this file MUST be indexed (proves the nested rule didn't leak).
    await fs.writeFile(join(root, "pkg-b", "local-only.ts"), "x\n");
    const chunks = await chunkDirectory(root);
    const paths = chunks.map((c) => c.path).sort();
    expect(paths).toContain("pkg-a/kept.ts");
    expect(paths).toContain("pkg-b/local-only.ts");
    expect(paths).not.toContain("global-skip.ts");
    expect(paths).not.toContain("pkg-a/local-only.ts");
  });

  it("user-supplied excludeDirs FULLY replaces defaults so previously skipped dirs become indexed", async () => {
    await fs.mkdir(join(root, "node_modules"), { recursive: true });
    await fs.writeFile(join(root, "node_modules", "x.ts"), "now indexed\n");
    const chunks: string[] = [];
    for await (const c of walkChunks(root, {
      config: resolveIndexConfig({ excludeDirs: ["nothing-skipped"] }),
    })) {
      chunks.push(c.path);
    }
    expect(chunks.some((p) => p.startsWith("node_modules/"))).toBe(true);
  });
});
