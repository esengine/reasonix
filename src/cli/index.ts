import { Command } from "commander";
import { readConfig } from "../config.js";
import { VERSION } from "../index.js";
import { applyMemoryStack } from "../user-memory.js";
import { chatCommand } from "./commands/chat.js";
import { codeCommand } from "./commands/code.js";
import { diffCommand } from "./commands/diff.js";
import { mcpInspectCommand } from "./commands/mcp-inspect.js";
import { mcpListCommand } from "./commands/mcp.js";
import { replayCommand } from "./commands/replay.js";
import { runCommand } from "./commands/run.js";
import { sessionsCommand } from "./commands/sessions.js";
import { setupCommand } from "./commands/setup.js";
import { statsCommand } from "./commands/stats.js";
import { updateCommand } from "./commands/update.js";
import { versionCommand } from "./commands/version.js";
import { resolveDefaults } from "./resolve.js";

const DEFAULT_SYSTEM = `You are Reasonix, a helpful DeepSeek-powered assistant. Be concise and accurate. Use tools when available.

# Cite or shut up — non-negotiable

Every factual claim about a codebase must be backed by evidence. Reasonix VALIDATES your citations — broken paths render in **red strikethrough with ❌** in front of the user.

**Positive claims** — append a markdown link:
- ✅ \`The MCP client supports listResources [listResources](src/mcp/client.ts:142).\`
- ❌ \`The MCP client supports listResources.\` ← unverifiable, do not write.

**Negative claims** ("X is missing", "Y isn't implemented", "lacks Z") are the #1 hallucination shape. STOP before writing them. If you have a search tool, call it first; if the search returns nothing, cite the search itself as evidence (\`No matches for "foo" in src/\`). If you have no tool, qualify hard: "I haven't verified — this is a guess."

Asserting absence without checking is how evaluative answers go wrong. Treat the urge to write "missing" as a red flag in your own reasoning.`;

const program = new Command();
program
  .name("reasonix")
  .description("DeepSeek-native agent framework — built for cache hits and cheap tokens.")
  .version(VERSION);

// `reasonix` with no subcommand → launch the friendliest flow.
// First run (no config yet) → interactive setup wizard.
// Otherwise → chat with saved defaults. This is the "one command to
// rule them all" entry for non-power-users: they don't need to learn
// `chat` / `setup` / `--mcp` — just type `reasonix`.
program.action(async () => {
  const cfg = readConfig();
  if (!cfg.setupCompleted) {
    await setupCommand({});
    return;
  }
  const defaults = resolveDefaults({});
  await chatCommand({
    model: defaults.model,
    system: applyMemoryStack(DEFAULT_SYSTEM, process.cwd()),
    harvest: defaults.harvest,
    branch: defaults.branch,
    session: defaults.session,
    mcp: defaults.mcp,
  });
});

program
  .command("setup")
  .description("Interactive wizard — API key, preset, MCP servers. Re-run any time to reconfigure.")
  .action(async () => {
    await setupCommand({});
  });

program
  .command("code [dir]")
  .description(
    "Code-editing chat — filesystem tools rooted at <dir> (default: cwd), coding system prompt, deepseek-reasoner. Model proposes SEARCH/REPLACE blocks; Reasonix applies them to disk.",
  )
  .option("-m, --model <id>", "Override default reasoner model")
  .option("--no-session", "Disable session persistence for this run")
  .option("-r, --resume", "Skip the session picker — always continue prior messages")
  .option("-n, --new", "Skip the session picker — always wipe prior messages and start fresh")
  .option("--transcript <path>", "Write a JSONL transcript to this path")
  .option(
    "--harvest",
    "Extract typed plan state from R1 reasoning (Pillar 2). Adds ~10-15% cost per turn. Off by default in code mode.",
  )
  .action(async (dir: string | undefined, opts) => {
    await codeCommand({
      dir,
      model: opts.model,
      noSession: opts.session === false,
      transcript: opts.transcript,
      forceResume: !!opts.resume,
      forceNew: !!opts.new,
      harvest: !!opts.harvest,
    });
  });

program
  .command("chat")
  .description("Interactive Ink TUI with live cache/cost panel.")
  .option("-m, --model <id>", "DeepSeek model id (overrides preset)")
  .option("-s, --system <prompt>", "System prompt (pinned in the immutable prefix)", DEFAULT_SYSTEM)
  .option("--transcript <path>", "Write a JSONL transcript to this path")
  .option(
    "--preset <name>",
    "Bundle of model + harvest + branch. One of: fast, smart, max. Overrides config.preset.",
  )
  .option(
    "--harvest",
    "Extract typed plan state from R1 reasoning (Pillar 2). Overrides preset's harvest setting.",
  )
  .option(
    "--branch <n>",
    "Self-consistency: run N parallel samples per turn and pick the most confident (disables streaming; enables harvest)",
    (v) => Number.parseInt(v, 10),
  )
  .option("--session <name>", "Use a named session (default: from config, usually 'default').")
  .option("--no-session", "Disable session persistence for this run (ephemeral chat)")
  .option("-r, --resume", "Skip the session picker — always continue prior messages")
  .option("-n, --new", "Skip the session picker — always wipe prior messages and start fresh")
  .option(
    "--mcp <spec>",
    'MCP server spec; repeatable. "name=cmd args...", "cmd args...", or a URL (http/https → SSE transport). Overrides config.mcp when provided.',
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .option(
    "--mcp-prefix <str>",
    "Global prefix applied to every MCP tool (only honored when no per-spec name is set; avoids collisions with a single anonymous server)",
  )
  .option("--no-config", "Ignore `~/.reasonix/config.json` — useful for CI or reproducing issues")
  .action(async (opts) => {
    const defaults = resolveDefaults({
      model: opts.model,
      harvest: opts.harvest,
      branch: opts.branch,
      mcp: opts.mcp as string[],
      session: opts.session,
      preset: opts.preset,
      noConfig: opts.config === false,
    });
    await chatCommand({
      model: defaults.model,
      system: applyMemoryStack(opts.system, process.cwd()),
      transcript: opts.transcript,
      harvest: defaults.harvest,
      branch: defaults.branch,
      session: defaults.session,
      mcp: defaults.mcp,
      mcpPrefix: opts.mcpPrefix,
      forceResume: !!opts.resume,
      forceNew: !!opts.new,
    });
  });

program
  .command("run <task>")
  .description("Run a single task non-interactively, streaming output.")
  .option("-m, --model <id>", "DeepSeek model id (overrides preset)")
  .option("-s, --system <prompt>", "System prompt", DEFAULT_SYSTEM)
  .option("--preset <name>", "Bundle of model + harvest + branch: fast | smart | max")
  .option("--harvest", "Extract typed plan state from R1 reasoning (Pillar 2)")
  .option(
    "--branch <n>",
    "Self-consistency: run N parallel samples per turn and pick the most confident",
    (v) => Number.parseInt(v, 10),
  )
  .option("--transcript <path>", "Write a JSONL transcript to this path for replay/diff")
  .option(
    "--mcp <spec>",
    'MCP server spec; repeatable. "name=cmd args...", "cmd args...", or a URL (http/https → SSE).',
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .option(
    "--mcp-prefix <str>",
    "Global prefix (only honored when no per-spec name is set; for a single anonymous server)",
  )
  .option("--no-config", "Ignore `~/.reasonix/config.json` — useful for CI or reproducing issues")
  .action(async (task: string, opts) => {
    const defaults = resolveDefaults({
      model: opts.model,
      harvest: opts.harvest,
      branch: opts.branch,
      mcp: opts.mcp as string[],
      preset: opts.preset,
      noConfig: opts.config === false,
    });
    await runCommand({
      task,
      model: defaults.model,
      system: applyMemoryStack(opts.system, process.cwd()),
      harvest: defaults.harvest,
      branch: defaults.branch,
      transcript: opts.transcript,
      mcp: defaults.mcp,
      mcpPrefix: opts.mcpPrefix,
    });
  });

program
  .command("stats [transcript]")
  .description(
    "Show usage dashboard (today / week / month / all-time · turns · cache hit · cost · savings vs Claude). " +
      "Pass a transcript path to fall back to the per-file summary (assistant turns + tool calls).",
  )
  .action((transcript: string | undefined) => {
    statsCommand({ transcript });
  });

program
  .command("sessions [name]")
  .description("List saved chat sessions, or inspect one by name.")
  .option("-v, --verbose", "Include system prompts + tool-call metadata when inspecting")
  .action((name: string | undefined, opts) => {
    sessionsCommand({ name, verbose: !!opts.verbose });
  });

program
  .command("replay <transcript>")
  .description(
    "Interactive Ink TUI to scrub through a transcript + rebuild its session summary (cost, cache, prefix stability). No API calls.",
  )
  .option("--print", "Dump to stdout instead of mounting the TUI (auto when piped)")
  .option("--head <n>", "stdout mode only — show first N records", (v) => Number.parseInt(v, 10))
  .option("--tail <n>", "stdout mode only — show last N records", (v) => Number.parseInt(v, 10))
  .action(async (transcript: string, opts) => {
    await replayCommand({
      path: transcript,
      print: !!opts.print,
      head: Number.isFinite(opts.head) ? opts.head : undefined,
      tail: Number.isFinite(opts.tail) ? opts.tail : undefined,
    });
  });

program
  .command("diff <a> <b>")
  .description(
    "Compare two transcripts in a split-pane Ink TUI (default) or stdout table. Use n/N to jump across divergences.",
  )
  .option("--md <path>", "Write a markdown report (blog-ready) to this path")
  .option("--print", "Force stdout table instead of the TUI (auto when piped)")
  .option("--tui", "Force the TUI even when piped (rare)")
  .option("--label-a <label>", "Display label for transcript A (default: filename)")
  .option("--label-b <label>", "Display label for transcript B (default: filename)")
  .action(async (a: string, b: string, opts) => {
    await diffCommand({
      a,
      b,
      mdPath: opts.md,
      labelA: opts.labelA,
      labelB: opts.labelB,
      print: !!opts.print,
      tui: !!opts.tui,
    });
  });

const mcp = program
  .command("mcp")
  .description("Model Context Protocol helpers — discover servers, test your setup.");

mcp
  .command("list")
  .description("Show a curated catalog of popular MCP servers with ready-to-use --mcp commands.")
  .option("--json", "Emit the catalog as JSON instead of the human-readable table")
  .action((opts) => {
    mcpListCommand({ json: !!opts.json });
  });

mcp
  .command("inspect <spec>")
  .description(
    'Connect to one MCP server and print its server info + tools/resources/prompts. <spec> takes the same forms as --mcp ("name=cmd args", "cmd args", or an SSE URL).',
  )
  .option("--json", "Emit the full inspection report as JSON instead of the human-readable summary")
  .action(async (spec: string, opts) => {
    try {
      await mcpInspectCommand({ spec, json: !!opts.json });
    } catch (err) {
      process.stderr.write(`mcp inspect failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program.command("version").description("Print Reasonix version.").action(versionCommand);

program
  .command("update")
  .description(
    "Check the npm registry for a newer Reasonix and install it. Detects npx vs global install; for npx users, prints a cache-refresh hint instead of running `npm i -g`.",
  )
  .option("--dry-run", "Print the plan without executing the install")
  .action(async (opts: { dryRun?: boolean }) => {
    await updateCommand({ dryRun: !!opts.dryRun });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
