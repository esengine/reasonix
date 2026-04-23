/**
 * `reasonix code [dir]` — opinionated wrapper around `reasonix chat` for
 * code-editing workflows.
 *
 * What it does differently from plain chat:
 *   - Registers native filesystem tools rooted at the given directory
 *     (CWD by default). No subprocess, no `npx install` step, R1-
 *     friendly schemas. Replaced the old `@modelcontextprotocol/server-filesystem`
 *     subprocess in 0.4.9 because its `edit_file` argv shape was the
 *     biggest driver of R1 DSML hallucinations.
 *   - Uses a coding-focused system prompt (src/code/prompt.ts) that
 *     teaches the model to propose edits as SEARCH/REPLACE blocks.
 *   - Defaults to the `smart` preset (reasoner + harvest) because
 *     coding tasks pay back R1 thinking.
 *   - Scopes its session to the directory so projects don't share
 *     conversation history.
 *   - Hooks `codeMode` into the TUI so assistant replies get parsed
 *     for SEARCH/REPLACE blocks and applied on disk after each turn.
 */

import { basename, resolve } from "node:path";
import { loadProjectShellAllowed } from "../../config.js";
import { sanitizeName } from "../../session.js";
import { ToolRegistry } from "../../tools.js";
import { registerFilesystemTools } from "../../tools/filesystem.js";
import { registerMemoryTools } from "../../tools/memory.js";
import { registerPlanTool } from "../../tools/plan.js";
import { registerShellTools } from "../../tools/shell.js";
import { chatCommand } from "./chat.js";

export interface CodeOptions {
  /** Directory to root the filesystem tools at. Defaults to process.cwd(). */
  dir?: string;
  /** Override the default `smart` model. */
  model?: string;
  /** Disable session persistence. */
  noSession?: boolean;
  /** Transcript file for replay/diff. */
  transcript?: string;
  /** Skip the session picker — always resume prior messages. */
  forceResume?: boolean;
  /** Skip the session picker — always wipe prior messages and start fresh. */
  forceNew?: boolean;
  /**
   * Opt into Pillar 2 harvesting (extracts a typed plan state from R1
   * reasoning via an extra V3 call). Default OFF in code mode — the
   * displayed subgoals/hypotheses/rejectedPaths have no programmatic
   * consumer, only `uncertainties.length` feeds branching, and the
   * extra V3 call adds ~10-15% per-turn cost. Users who want the
   * reasoning surfaced explicitly can pass `--harvest`.
   */
  harvest?: boolean;
}

export async function codeCommand(opts: CodeOptions = {}): Promise<void> {
  const { codeSystemPrompt } = await import("../../code/prompt.js");
  const rootDir = resolve(opts.dir ?? process.cwd());
  // Per-directory session so switching projects doesn't mix histories.
  // `code-<sanitized-basename>` fits the session name rules without
  // truncating most project names.
  const session = opts.noSession ? undefined : `code-${sanitizeName(basename(rootDir))}`;

  // Native filesystem tools. No subprocess, ~50-200 ms faster per call
  // than the MCP server was, and `edit_file` takes a flat SEARCH/REPLACE
  // shape instead of the `string="false"` JSON-in-string array that
  // triggered R1's DSML hallucinations all through 0.4.x.
  const tools = new ToolRegistry();
  registerFilesystemTools(tools, { rootDir });
  registerShellTools(tools, {
    rootDir,
    // Per-project "always allow" list persisted from prior ShellConfirm
    // choices; merged on top of the built-in allowlist in shell.ts.
    // GETTER form — re-read every dispatch so a prefix the user adds
    // via ShellConfirm mid-session takes effect on the next shell call
    // instead of waiting for `/new` or a relaunch.
    extraAllowed: () => loadProjectShellAllowed(rootDir),
  });
  // `submit_plan` is always in the spec list so the prefix cache stays
  // stable across plan-mode toggles (Pillar 1). The tool itself is a
  // no-op outside plan mode and throws `PlanProposedError` when the
  // user has `/plan`-enabled the session.
  registerPlanTool(tools);
  // `remember` / `forget` / `recall_memory` — cross-session user memory.
  // Project scope hashes off rootDir so switching projects gets a fresh
  // per-project memory store; the global scope is shared across runs.
  registerMemoryTools(tools, { projectRoot: rootDir });
  // `run_skill` is intentionally NOT registered here — App.tsx wires it
  // up with the subagent runner attached, so `runAs: subagent` skills
  // can spawn isolated child loops. Doing it here would mean the App's
  // re-registration would shadow the no-runner version, which works
  // (last write wins) but obscures the wiring.

  process.stderr.write(
    `▸ reasonix code: rooted at ${rootDir}, session "${session ?? "(ephemeral)"}" · ${tools.size} native tool(s)\n`,
  );

  await chatCommand({
    model: opts.model ?? "deepseek-reasoner",
    harvest: opts.harvest ?? false,
    system: codeSystemPrompt(rootDir),
    transcript: opts.transcript,
    session,
    seedTools: tools,
    codeMode: { rootDir },
    forceResume: opts.forceResume,
    forceNew: opts.forceNew,
  });
}
