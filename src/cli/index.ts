import { Command } from "commander";
import { VERSION } from "../index.js";
import { chatCommand } from "./commands/chat.js";
import { runCommand } from "./commands/run.js";
import { statsCommand } from "./commands/stats.js";
import { versionCommand } from "./commands/version.js";

const DEFAULT_SYSTEM =
  "You are Reasonix, a helpful DeepSeek-powered assistant. Be concise and accurate. Use tools when available.";

const program = new Command();
program
  .name("reasonix")
  .description("DeepSeek-native agent framework — built for cache hits and cheap tokens.")
  .version(VERSION);

program
  .command("chat")
  .description("Interactive Ink TUI with live cache/cost panel.")
  .option("-m, --model <id>", "DeepSeek model id", "deepseek-chat")
  .option("-s, --system <prompt>", "System prompt (pinned in the immutable prefix)", DEFAULT_SYSTEM)
  .option("--transcript <path>", "Write a JSONL transcript to this path")
  .option(
    "--harvest",
    "Extract typed plan state from R1 reasoning (Pillar 2, adds a cheap V3 call per turn)",
  )
  .option(
    "--branch <n>",
    "Self-consistency: run N parallel samples per turn and pick the most confident (disables streaming; enables harvest)",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--session <name>",
    "Use a named session (default: 'default'). Resume the same session next time.",
  )
  .option("--no-session", "Disable session persistence for this run (ephemeral chat)")
  .action(async (opts) => {
    // Default behavior: every chat is auto-saved to a session named 'default'
    // and auto-resumed next launch. Pass --no-session to opt out, or
    // --session <name> to use a different session.
    let session: string | undefined;
    if (opts.session === false) {
      session = undefined; // --no-session
    } else if (typeof opts.session === "string" && opts.session.length > 0) {
      session = opts.session;
    } else {
      session = "default";
    }
    await chatCommand({
      model: opts.model,
      system: opts.system,
      transcript: opts.transcript,
      harvest: !!opts.harvest,
      branch: Number.isFinite(opts.branch) && opts.branch > 1 ? opts.branch : undefined,
      session,
    });
  });

program
  .command("run <task>")
  .description("Run a single task non-interactively, streaming output.")
  .option("-m, --model <id>", "DeepSeek model id", "deepseek-chat")
  .option("-s, --system <prompt>", "System prompt", DEFAULT_SYSTEM)
  .action(async (task: string, opts) => {
    await runCommand({ task, model: opts.model, system: opts.system });
  });

program
  .command("stats <transcript>")
  .description("Summarize a JSONL transcript produced by `reasonix chat --transcript`.")
  .action((transcript: string) => {
    statsCommand({ transcript });
  });

program.command("version").description("Print Reasonix version.").action(versionCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
