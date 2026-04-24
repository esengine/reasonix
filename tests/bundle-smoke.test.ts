/**
 * Post-build smoke test for the bundled `dist/`.
 *
 * Unit tests load modules from `src/`, which means path-resolution
 * bugs that only appear AFTER tsup bundles everything into a different
 * directory layout never surface in the regular test suite. v0.5.4
 * shipped to npm with exactly such a bug — `src/tokenizer.ts` at
 * `dist/cli/index.js` tried to read the tokenizer data file relative
 * to the bundled entry, ended up at `dist/data/...` instead of the
 * package-root `data/...`, and every `reasonix run` crashed on first
 * turn with ENOENT.
 *
 * These tests spawn the bundled output and verify the two bundle
 * layouts (`dist/index.js` library + `dist/cli/index.js` CLI) can
 * both locate the tokenizer data file. They're skipped when the
 * build hasn't run yet (CI always runs `npm run build` first).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const LIB_BUNDLE = resolve("dist/index.js");
const CLI_BUNDLE = resolve("dist/cli/index.js");

describe("bundled dist — tokenizer path resolution", () => {
  const libExists = existsSync(LIB_BUNDLE);
  const cliExists = existsSync(CLI_BUNDLE);

  (libExists ? it : it.skip)(
    "dist/index.js resolves the tokenizer data file at package-root data/",
    () => {
      // truncateForModelByTokens internally calls countTokens when the
      // input exceeds the fast-path threshold, which forces the
      // tokenizer's lazy data-file load. If resolveDataPath() lands on
      // a non-existent path (the 0.5.4 regression) this crashes with
      // ENOENT and the spawned process exits non-zero.
      // ESM dynamic imports on Windows require `file://` URLs, not bare
      // absolute paths (which Node's ESM loader rejects as an unknown
      // protocol). pathToFileURL handles the cross-platform form.
      const libUrl = pathToFileURL(LIB_BUNDLE).href;
      const result = spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { truncateForModelByTokens } from "${libUrl}";
           const s = "hello world ".repeat(500);
           const out = truncateForModelByTokens(s, 100);
           console.log(JSON.stringify({ ok: true, len: out.length }));`,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/deepseek-tokenizer\.json\.gz/);
      expect(result.stderr).not.toMatch(/ENOENT/);
      expect(result.stdout).toMatch(/"ok":true/);
    },
  );

  (cliExists ? it : it.skip)("dist/cli/index.js loads tokenizer before the first API fetch", () => {
    // Spawn the CLI pointed at a bogus local address that fails fetch
    // fast. In step(), preflight's estimateRequestTokens runs BEFORE
    // client.chat — so if the bundled layout can't find the
    // tokenizer data, we see ENOENT in stderr even though the fetch
    // never happens. If tokenizer loads fine, we see a connection
    // error instead (and that's OK — we're not testing the network
    // path, only that the tokenizer path resolution works from
    // dist/cli/).
    const result = spawnSync("node", [CLI_BUNDLE, "run", "--no-config", "hi"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "sk-smoke-test-bogus",
        // Fail-fast fetch target: the :1 port is almost never open,
        // so we get connection-refused within ~1ms instead of the
        // client's 120s timeout waiting on api.deepseek.com.
        DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
      },
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    // The crucial assertion: bundle must not crash on the tokenizer
    // path. Connection errors to 127.0.0.1:1 are expected and fine.
    expect(combined).not.toMatch(/deepseek-tokenizer\.json\.gz/);
    // Also not a missing-module style ENOENT (network errors are
    // ECONNREFUSED or fetch failure, never ENOENT).
    expect(combined).not.toMatch(/ENOENT.*tokenizer/i);
  });
});
