import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const targets = [
  ["node_modules/highlight.js/styles/github-dark.min.css", "dashboard/dist/vendor-hljs.css"],
  ["node_modules/uplot/dist/uPlot.min.css", "dashboard/dist/vendor-uplot.css"],
];

for (const [src, dst] of targets) {
  mkdirSync(dirname(resolve(dst)), { recursive: true });
  copyFileSync(resolve(src), resolve(dst));
  console.log(`copied ${src} → ${dst}`);
}
