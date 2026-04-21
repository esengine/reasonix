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
  .action(async (opts) => {
    await chatCommand({
      model: opts.model,
      system: opts.system,
      transcript: opts.transcript,
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
