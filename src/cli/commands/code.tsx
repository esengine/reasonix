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

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadEditMode, loadProjectShellAllowed } from "../../config.js";
import { bootstrapSemanticSearchInCodeMode } from "../../index/semantic/tool.js";
import { sanitizeName } from "../../memory/session.js";
import { ToolRegistry } from "../../tools.js";
import { registerChoiceTool } from "../../tools/choice.js";
import { registerFilesystemTools } from "../../tools/filesystem.js";
import { JobRegistry } from "../../tools/jobs.js";
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
  /**
   * Soft USD spend cap. Off by default. Same semantics as `chat`:
   * warns at 80%, refuses next turn at 100%. Mid-session adjustable
   * via `/budget <usd>` slash command.
   */
  budgetUsd?: number;
  /** Suppress the auto-launched embedded web dashboard. */
  noDashboard?: boolean;
  /** Inline string appended to the code system prompt after the generated base prompt. */
  systemAppend?: string;
  /** Path to a UTF-8 text file whose contents are appended to the code system prompt. */
  systemAppendFile?: string;
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
  // Background-process registry shared between the shell tools and the
  // TUI's /jobs + /kill slashes + exit cleanup. One per `reasonix code`
  // run — orphan prevention on SIGINT / process exit kills everything
  // it owns, so dev servers don't outlive the Reasonix process.
  const jobs = new JobRegistry();
  // Bundled re-registration so `/cwd <path>` can swap every rootDir-
  // dependent tool atomically. ToolRegistry.register is keyed by name
  // and overwrites in-place, so re-calling these against the existing
  // registry replaces the closures cleanly without disturbing tool
  // specs (names/descriptions/params don't reference rootDir, so the
  // prefix cache survives).
  const registerRootedTools = (root: string): void => {
    registerFilesystemTools(tools, { rootDir: root });
    registerShellTools(tools, {
      rootDir: root,
      // Per-project "always allow" list persisted from prior ShellConfirm
      // choices; merged on top of the built-in allowlist in shell.ts.
      // GETTER form — re-read every dispatch so a prefix the user adds
      // via ShellConfirm mid-session takes effect on the next shell call
      // instead of waiting for `/new` or a relaunch.
      extraAllowed: () => loadProjectShellAllowed(root),
      // `yolo` edit-mode disables shell confirmations entirely. Re-read
      // from config on each dispatch so /mode yolo (or Shift+Tab cycling
      // through to it) flips the gate live without forcing a relaunch.
      allowAll: () => loadEditMode() === "yolo",
      jobs,
    });
    // `remember` / `forget` / `recall_memory` — cross-session user memory.
    // Project scope hashes off rootDir so switching projects gets a fresh
    // per-project memory store; the global scope is shared across runs.
    registerMemoryTools(tools, { projectRoot: root });
  };
  registerRootedTools(rootDir);
  // `submit_plan` is always in the spec list so the prefix cache stays
  // stable across plan-mode toggles (Pillar 1). The tool itself is a
  // no-op outside plan mode and throws `PlanProposedError` when the
  // user has `/plan`-enabled the session.
  registerPlanTool(tools);
  // `ask_choice` — branching primitive. Independent of plan mode: the
  // model uses it to put a 2–4 way choice in front of the user
  // (strategy, style, library pick) without trying to squeeze the
  // menu into a submit_plan body. Keeping it always-registered
  // preserves the prefix cache across plan-mode toggles.
  registerChoiceTool(tools);
  // `run_skill` is intentionally NOT registered here — App.tsx wires it
  // up with the subagent runner attached, so `runAs: subagent` skills
  // can spawn isolated child loops. Doing it here would mean the App's
  // re-registration would shadow the no-runner version, which works
  // (last write wins) but obscures the wiring.

  // Bootstrap semantic_search. Silent: registers the tool when an
  // on-disk index already exists, skips entirely otherwise. Setup
  // happens via the explicit `reasonix index` command — never
  // by surprise on launch.
  const semantic = await bootstrapSemanticSearchInCodeMode(tools, rootDir);

  process.stderr.write(
    `▸ reasonix code: rooted at ${rootDir}, session "${session ?? "(ephemeral)"}" · ${tools.size} native tool(s)${
      semantic.enabled ? " · semantic_search on" : ""
    }\n`,
  );

  // Belt-and-suspenders cleanup: even though spawn(detached:false)
  // should tie child processes to the parent's lifetime, Windows cmd.exe
  // wrappers occasionally leak. We DON'T install SIGINT/SIGTERM
  // handlers here — that overrode Node's default "exit on Ctrl+C" with
  // a silent no-op, which made Ctrl+C feel broken in the TUI. App.tsx
  // owns the SIGINT path now (it shows the quit-armed banner and calls
  // exit() on confirmation); this 'exit' hook just guarantees the job
  // registry is drained on the way out, regardless of which exit path
  // fired.
  process.once("exit", () => {
    void jobs.shutdown();
  });

  let systemAppendFileContents: string | undefined;
  if (opts.systemAppend !== undefined && opts.systemAppend.trim().length === 0) {
    process.stderr.write("▲ --system-append is empty — no prompt text will be appended\n");
  }
  if (opts.systemAppendFile) {
    const filePath = resolve(opts.systemAppendFile);
    try {
      systemAppendFileContents = readFileSync(filePath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      process.stderr.write(
        `Error: cannot read --system-append-file "${filePath}": ${e.code ? `[${e.code}] ` : ""}${e.message}\n`,
      );
      process.exit(1);
    }
  }

  await chatCommand({
    model: opts.model ?? "deepseek-v4-flash",
    harvest: opts.harvest ?? false,
    budgetUsd: opts.budgetUsd,
    system: codeSystemPrompt(rootDir, {
      hasSemanticSearch: semantic.enabled,
      systemAppend: opts.systemAppend,
      systemAppendFile: systemAppendFileContents,
    }),
    transcript: opts.transcript,
    session,
    seedTools: tools,
    codeMode: { rootDir, jobs, reregisterTools: registerRootedTools },
    forceResume: opts.forceResume,
    forceNew: opts.forceNew,
    noDashboard: opts.noDashboard,
  });
}
