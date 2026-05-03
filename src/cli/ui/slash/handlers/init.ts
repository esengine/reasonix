import { existsSync } from "node:fs";
import * as pathMod from "node:path";
import { t } from "../../../../i18n/index.js";
import type { SlashHandler } from "../dispatch.js";

const INIT_PROMPT = [
  "# Task: Initialize REASONIX.md",
  "",
  "I want you to generate a REASONIX.md at the project root that captures",
  "the working knowledge a future Reasonix session needs to be productive",
  "here. This file is auto-pinned into your system prompt every launch,",
  "so its size and accuracy matter.",
  "",
  "## Hard constraints (do NOT relax these)",
  "",
  "- **Length cap: ≤ 80 lines / 3KB total.** Be concise. If you can't fit a",
  "  section, drop it.",
  "- **Only document things you can verify by reading files.** Do NOT",
  "  speculate about architectural intent, future roadmap, or design",
  "  rationale. If it isn't obvious from the code, leave it out.",
  "- **No placeholder text.** No 'TODO: describe X', no 'Add more here'.",
  "  Either state a fact or omit the section.",
  "",
  "## Procedure",
  "",
  "1. Read the top of any existing README* file.",
  "2. Read the manifest (package.json / Cargo.toml / pyproject.toml /",
  "   go.mod / etc.) — pick whichever exists.",
  "3. `directory_tree` 1-2 levels deep on the project root, skipping",
  "   common build/dependency dirs (node_modules, dist, target, .git,",
  "   venv, __pycache__).",
  "4. Identify: primary language + framework, top-level layout, test",
  "   runner, lint/format setup, build/run/test scripts, any non-obvious",
  "   convention with visible evidence (commit message format, import",
  "   order, naming pattern).",
  "5. Write REASONIX.md with the sections below, skipping any you can't",
  "   fill from evidence.",
  "",
  "## Sections to use (skip ones with no evidence)",
  "",
  "- **Stack** — language + framework + 3-5 key deps. One line each.",
  "- **Layout** — top-level dirs and what lives in each. One line each.",
  "- **Commands** — verbatim from `scripts` block (or equivalent):",
  "  build / test / lint / typecheck / dev / format. Whatever exists.",
  "- **Conventions** — only things visible in the code. Examples:",
  "  '*.test.ts colocated with source', 'named exports only',",
  "  'commits use Conventional Commits prefix'. If you can't find any",
  "  CONVENTION evidence, omit the whole section.",
  "- **Watch out for** — gotchas a new contributor would benefit from",
  "  knowing BEFORE editing. Examples: 'edit_file SEARCH must match",
  "  byte-for-byte', 'this dir is generated, don't edit by hand'.",
  "  Omit if you find nothing concrete.",
  "",
  "## Output",
  "",
  "Write the result to `REASONIX.md` in the project root using the",
  "filesystem tools (edit_file with empty SEARCH if creating new,",
  "write_file if overwriting). After writing, STOP — do not summarize",
  "what you did, do not propose follow-up tasks. The user will review",
  "the pending edit via /apply.",
  "",
  "Start now.",
].join("\n");

const init: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeRoot) {
    return { info: t("handlers.init.codeOnly") };
  }
  const force = (args[0] ?? "").toLowerCase() === "force";
  const target = pathMod.join(ctx.codeRoot, "REASONIX.md");
  if (existsSync(target) && !force) {
    return {
      info: [
        t("handlers.init.exists", { path: target }),
        "",
        t("handlers.init.existsForce"),
        "",
        t("handlers.init.existsEdit"),
        t("handlers.init.existsPinned"),
      ].join("\n"),
    };
  }
  return {
    info: t("handlers.init.info"),
    resubmit: INIT_PROMPT,
  };
};

export const handlers: Record<string, SlashHandler> = {
  init,
};
