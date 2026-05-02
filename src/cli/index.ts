import { Command } from "commander";
import { readConfig } from "../config.js";
import { VERSION } from "../index.js";
import { listSessions } from "../memory/session.js";
import { applyMemoryStack } from "../memory/user.js";
import { ESCALATION_CONTRACT } from "../prompt-fragments.js";
import { chatCommand } from "./commands/chat.js";
import { codeCommand } from "./commands/code.js";
import { commitCommand } from "./commands/commit.js";
import { diffCommand } from "./commands/diff.js";
import { doctorCommand } from "./commands/doctor.js";
import { eventsCommand } from "./commands/events.js";
import { indexCommand } from "./commands/index.js";
import { mcpInspectCommand } from "./commands/mcp-inspect.js";
import { mcpListCommand } from "./commands/mcp.js";
import { replayCommand } from "./commands/replay.js";
import { runCommand } from "./commands/run.js";
import { sessionsCommand } from "./commands/sessions.js";
import { setupCommand } from "./commands/setup.js";
import { statsCommand } from "./commands/stats.js";
import { updateCommand } from "./commands/update.js";
import { versionCommand } from "./commands/version.js";
import { resolveContinueFlag, resolveDefaults } from "./resolve.js";

const DEFAULT_SYSTEM = `You are Reasonix, a helpful DeepSeek-powered assistant. Be concise and accurate. Use tools when available.

# Cite or shut up — non-negotiable

Every factual claim about a codebase must be backed by evidence. Reasonix VALIDATES your citations — broken paths render in **red strikethrough with ❌** in front of the user.

**Positive claims** — append a markdown link:
- ✅ \`The MCP client supports listResources [listResources](src/mcp/client.ts:142).\`
- ❌ \`The MCP client supports listResources.\` ← unverifiable, do not write.

**Negative claims** ("X is missing", "Y isn't implemented", "lacks Z") are the #1 hallucination shape. STOP before writing them. If you have a search tool, call it first; if the search returns nothing, cite the search itself as evidence (\`No matches for "foo" in src/\`). If you have no tool, qualify hard: "I haven't verified — this is a guess."

Asserting absence without checking is how evaluative answers go wrong. Treat the urge to write "missing" as a red flag in your own reasoning.

# Don't invent what changes — search instead

Your training data has a cutoff. When an answer's correctness depends on something that changes over time (the user is asking what's happening, not what's true) and a search tool is available, search first. Inventing currently-correct values from training memory is the most common way these answers go wrong, and the user usually can't tell until much later.

The signal isn't a topic list — it's: "if I'm wrong about this, is it because reality moved on?". If yes, ground the answer in fresh evidence; if no (definitions, mechanisms, well-established APIs), answer from memory.

${ESCALATION_CONTRACT}`;

/** Lenient: malformed → undefined (no cap) so a bad flag doesn't abort launch. */
function parseBudgetFlag(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw <= 0) {
    process.stderr.write(
      `▲ ignoring --budget=${raw} (must be a positive number) — running with no cap\n`,
    );
    return undefined;
  }
  return raw;
}

const program = new Command();
program
  .name("reasonix")
  .description("DeepSeek-native agent framework — built for cache hits and cheap tokens.")
  .version(VERSION)
  .option(
    "-c, --continue",
    "Resume the most recently used chat session without showing the picker.",
  );

// `reasonix` with no subcommand → launch the friendliest flow.
// First run (no config yet) → interactive setup wizard.
// Otherwise → chat with saved defaults. This is the "one command to
// rule them all" entry for non-power-users: they don't need to learn
// `chat` / `setup` / `--mcp` — just type `reasonix`.
program.action(async (opts: { continue?: boolean }) => {
  const cfg = readConfig();
  if (!cfg.setupCompleted) {
    await setupCommand({});
    return;
  }
  const defaults = resolveDefaults({});
  const continueOpts = resolveContinueFlag(
    opts.continue,
    defaults.session,
    () => listSessions()[0],
    (msg) => process.stderr.write(`${msg}\n`),
  );
  await chatCommand({
    model: defaults.model,
    system: applyMemoryStack(DEFAULT_SYSTEM, process.cwd()),
    harvest: defaults.harvest,
    branch: defaults.branch,
    session: continueOpts.session,
    mcp: defaults.mcp,
    forceResume: continueOpts.forceResume,
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
    "Code-editing chat — filesystem tools rooted at <dir> (default: cwd), coding system prompt, v4-flash baseline. Model proposes SEARCH/REPLACE blocks; Reasonix applies them to disk. Use /preset pro or /pro to lock v4-pro on hard tasks.",
  )
  .option("-m, --model <id>", "Override default model (v4-flash)")
  .option("--no-session", "Disable session persistence for this run")
  .option("-r, --resume", "Skip the session picker — always continue prior messages")
  .option("-n, --new", "Skip the session picker — always wipe prior messages and start fresh")
  .option("--transcript <path>", "Write a JSONL transcript to this path")
  .option(
    "--harvest",
    "Opt-in Pillar-2 plan-state extraction. Adds one flash call per turn; off by default (no preset enables it).",
  )
  .option(
    "--budget <usd>",
    "Soft USD cap on session spend. Off by default. Warns at 80%, refuses next turn at 100%. Mid-session: /budget <usd> or /budget off.",
    (v) => Number.parseFloat(v),
  )
  .option(
    "--no-dashboard",
    "Suppress the auto-launched embedded web dashboard. Default behavior boots it on TUI mount and shows the URL in the status bar (clickable in OSC-8-aware terminals).",
  )
  .option(
    "--system-append <prompt>",
    "Append instructions to the code system prompt. Does NOT replace the default prompt — adds after it.",
  )
  .option(
    "--system-append-file <path>",
    "Append file contents to the code system prompt. Does NOT replace the default prompt. UTF-8, relative to cwd or absolute.",
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
      budgetUsd: parseBudgetFlag(opts.budget),
      noDashboard: opts.dashboard === false,
      systemAppend: opts.systemAppend,
      systemAppendFile: opts.systemAppendFile,
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
    "Model bundle. One of: auto (flash → pro on hard turns, default), flash (always flash), pro (always pro). Overrides config.preset.",
  )
  .option(
    "--harvest",
    "Opt-in Pillar-2 plan-state extraction. Off by default — no preset enables it.",
  )
  .option(
    "--branch <n>",
    "Self-consistency: run N parallel samples per turn (N× cost). Manual only — never auto-enabled.",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--budget <usd>",
    "Soft USD cap on session spend. Off by default. Warns at 80%, refuses next turn at 100%. Mid-session: /budget <usd> or /budget off.",
    (v) => Number.parseFloat(v),
  )
  .option("--session <name>", "Use a named session (default: from config, usually 'default').")
  .option("--no-session", "Disable session persistence for this run (ephemeral chat)")
  .option("-r, --resume", "Skip the session picker — always continue prior messages")
  .option(
    "-c, --continue",
    "Resume the most-recently-used session (any name) without showing the picker.",
  )
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
  .option(
    "--no-dashboard",
    "Suppress the auto-launched embedded web dashboard. Default behavior boots it on TUI mount and shows the URL in the status bar (clickable in OSC-8-aware terminals).",
  )
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
    // `-c` is "newest-touched session" + auto-resume; `-r` is "this
    // session's prior messages, even if you also passed --session".
    // When both are set we prefer the explicit `--session` + `-r`
    // (more specific input wins). `-c` only kicks in if `-r` wasn't.
    const continueOpts = opts.resume
      ? { session: defaults.session, forceResume: true }
      : resolveContinueFlag(
          opts.continue,
          defaults.session,
          () => listSessions()[0],
          (msg) => process.stderr.write(`${msg}\n`),
        );
    await chatCommand({
      model: defaults.model,
      system: applyMemoryStack(opts.system, process.cwd()),
      transcript: opts.transcript,
      harvest: defaults.harvest,
      branch: defaults.branch,
      budgetUsd: parseBudgetFlag(opts.budget),
      session: continueOpts.session,
      mcp: defaults.mcp,
      mcpPrefix: opts.mcpPrefix,
      forceResume: continueOpts.forceResume,
      forceNew: !!opts.new,
      noDashboard: opts.dashboard === false,
    });
  });

program
  .command("run <task>")
  .description("Run a single task non-interactively, streaming output.")
  .option("-m, --model <id>", "DeepSeek model id (overrides preset)")
  .option("-s, --system <prompt>", "System prompt", DEFAULT_SYSTEM)
  .option("--preset <name>", "Model bundle: auto | flash | pro (default: auto)")
  .option("--harvest", "Extract typed plan state from R1 reasoning (Pillar 2)")
  .option(
    "--branch <n>",
    "Self-consistency: run N parallel samples per turn and pick the most confident",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--budget <usd>",
    "Soft USD cap on session spend. Off by default. Refuses to start a new turn once cumulative cost ≥ cap.",
    (v) => Number.parseFloat(v),
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
      budgetUsd: parseBudgetFlag(opts.budget),
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
  .command("doctor")
  .description(
    "One-command health check — API key, config, /user/balance reachability, tokenizer, sessions, hooks, Ollama (if used), project markers. Exit 1 on any fail; 0 on warn / clean.",
  )
  .action(async () => {
    await doctorCommand();
  });

program
  .command("commit")
  .description(
    "Draft a commit message from the staged diff (or working tree, if nothing staged), matching your repo's recent commit style. Review interactively before it lands.",
  )
  .option("-m, --model <id>", "Override the default model (deepseek-v4-flash)")
  .option(
    "-y, --yes",
    "Skip the [a]ccept / [r]egenerate prompt and commit the first draft. Useful in scripts.",
  )
  .action(async (opts) => {
    await commitCommand({ model: opts.model, yes: !!opts.yes });
  });

program
  .command("sessions [name]")
  .description("List saved chat sessions, or inspect one by name.")
  .option("-v, --verbose", "Include system prompts + tool-call metadata when inspecting")
  .action((name: string | undefined, opts) => {
    sessionsCommand({ name, verbose: !!opts.verbose });
  });

program
  .command("events <name>")
  .description(
    "Pretty-print the kernel event-log sidecar (~/.reasonix/sessions/<name>.events.jsonl) — every typed Event the session produced.",
  )
  .option("--type <type>", "Show only events of this type (e.g., tool.intent)")
  .option("--since <id>", "Show only events with id >= N", (v) => Number.parseInt(v, 10))
  .option("--tail <n>", "Show only the last N events", (v) => Number.parseInt(v, 10))
  .option("--json", "Emit raw JSONL passthrough instead of formatted lines (for jq pipelines)")
  .option(
    "--projection",
    "Replace the listing with the final reduced ProjectionSet (conversation, budget, plan, …)",
  )
  .action((name: string, opts) => {
    eventsCommand({
      name,
      type: opts.type,
      since: Number.isFinite(opts.since) ? opts.since : undefined,
      tail: Number.isFinite(opts.tail) ? opts.tail : undefined,
      json: !!opts.json,
      projection: !!opts.projection,
    });
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

program
  .command("index")
  .description(
    "Build (or incrementally refresh) a local semantic search index for the project so `reasonix code` can answer 'where do we…' questions by meaning, not just by token. Uses Ollama as the embedding backend; missing daemon / model is offered to the user with a confirm prompt.",
  )
  .option("--rebuild", "Wipe and rebuild from scratch")
  .option("--model <name>", "Embedding model (default: nomic-embed-text)")
  .option("--dir <path>", "Project root to index (default: cwd)")
  .option("--ollama-url <url>", "Override Ollama base URL (default: http://localhost:11434)")
  .option(
    "-y, --yes",
    "Skip preflight prompts — auto-start the daemon and pull the model if missing (use in scripts)",
  )
  .action(
    async (opts: {
      rebuild?: boolean;
      model?: string;
      dir?: string;
      ollamaUrl?: string;
      yes?: boolean;
    }) => {
      await indexCommand(opts);
    },
  );

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
