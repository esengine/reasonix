import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node20",
    outDir: "dist",
  },
  {
    entry: ["src/cli/index.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node20",
    outDir: "dist/cli",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { app: "dashboard/app.js" },
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    target: "es2022",
    platform: "browser",
    outDir: "dashboard/dist",
    external: [/^https:\/\//],
  },
]);
