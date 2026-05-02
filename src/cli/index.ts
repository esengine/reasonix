import { Command } from "commander";
import { readConfig } from "../config.js";
import { t } from "../i18n/index.js";
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
  .description(t("cli.description"))
  .version(VERSION)
  .option("-c, --continue", t("cli.continue"));

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
    system: applyMemoryStack(t("prompts.defaultSystem"), process.cwd()),
    harvest: defaults.harvest,
    branch: defaults.branch,
    session: continueOpts.session,
    mcp: defaults.mcp,
    forceResume: continueOpts.forceResume,
  });
});

program
  .command("setup")
  .description(t("cli.setup"))
  .action(async () => {
    await setupCommand({});
  });

program
  .command("code [dir]")
  .description(t("cli.code"))
  .option("-m, --model <id>", t("ui.modelOverride"))
  .option("--no-session", t("ui.noSession"))
  .option("-r, --resume", t("ui.resumeHint"))
  .option("-n, --new", t("ui.newHint"))
  .option("--transcript <path>", t("ui.transcriptHint"))
  .option("--harvest", t("ui.harvestHint"))
  .option("--budget <usd>", t("ui.budgetHint"), (v) => Number.parseFloat(v))
  .option("--no-dashboard", t("ui.noDashboard"))
  .option("--system-append <prompt>", t("ui.systemAppendHint"))
  .option("--system-append-file <path>", t("ui.systemAppendFileHint"))
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
  .description(t("cli.chat"))
  .option("-m, --model <id>", t("ui.modelIdHint"))
  .option("-s, --system <prompt>", t("ui.systemPromptHint"), t("prompts.defaultSystem"))
  .option("--transcript <path>", t("ui.transcriptHint"))
  .option("--preset <name>", t("ui.presetHint"))
  .option("--harvest", t("ui.harvestOptInHint"))
  .option("--branch <n>", t("ui.branchHint"), (v) => Number.parseInt(v, 10))
  .option("--budget <usd>", t("ui.budgetHint"), (v) => Number.parseFloat(v))
  .option("--session <name>", t("ui.sessionNameHint"))
  .option("--no-session", t("ui.ephemeralHint"))
  .option("-r, --resume", t("ui.resumeHint"))
  .option("-c, --continue", t("cli.continue"))
  .option("-n, --new", t("ui.newHint"))
  .option(
    "--mcp <spec>",
    t("ui.mcpSpecHint"),
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .option("--mcp-prefix <str>", t("ui.mcpPrefixHint"))
  .option("--no-config", t("ui.noConfigHint"))
  .option("--no-dashboard", t("ui.noDashboard"))
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
  .description(t("cli.run"))
  .option("-m, --model <id>", t("ui.modelIdHint"))
  .option("-s, --system <prompt>", t("ui.systemPromptHint"), t("prompts.defaultSystem"))
  .option("--preset <name>", t("ui.presetHintShort"))
  .option("--harvest", t("ui.harvestHintShort"))
  .option("--branch <n>", t("ui.branchHintShort"), (v) => Number.parseInt(v, 10))
  .option("--budget <usd>", t("ui.budgetHintShort"), (v) => Number.parseFloat(v))
  .option("--transcript <path>", t("ui.transcriptHintShort"))
  .option(
    "--mcp <spec>",
    t("ui.mcpSpecHintShort"),
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .option("--mcp-prefix <str>", t("ui.mcpPrefixHintShort"))
  .option("--no-config", t("ui.noConfigHint"))
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
  .description(t("cli.stats"))
  .action((transcript: string | undefined) => {
    statsCommand({ transcript });
  });

program
  .command("doctor")
  .description(t("cli.doctor"))
  .action(async () => {
    await doctorCommand();
  });

program
  .command("commit")
  .description(t("cli.commit"))
  .option("-m, --model <id>", t("ui.modelOverrideFlash"))
  .option("-y, --yes", t("ui.skipConfirmHint"))
  .action(async (opts) => {
    await commitCommand({ model: opts.model, yes: !!opts.yes });
  });

program
  .command("sessions [name]")
  .description(t("cli.sessions"))
  .option("-v, --verbose", t("ui.verboseHint"))
  .action((name: string | undefined, opts) => {
    sessionsCommand({ name, verbose: !!opts.verbose });
  });

program
  .command("events <name>")
  .description(t("cli.events"))
  .option("--type <type>", t("ui.eventTypeHint"))
  .option("--since <id>", t("ui.eventSinceHint"), (v) => Number.parseInt(v, 10))
  .option("--tail <n>", t("ui.eventTailHint"), (v) => Number.parseInt(v, 10))
  .option("--json", t("ui.jsonHint"))
  .option("--projection", t("ui.projectionHint"))
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
  .description(t("cli.replay"))
  .option("--print", t("ui.printHint"))
  .option("--head <n>", t("ui.headHint"), (v) => Number.parseInt(v, 10))
  .option("--tail <n>", t("ui.tailHint"), (v) => Number.parseInt(v, 10))
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
  .description(t("cli.diff"))
  .option("--md <path>", t("ui.mdReportHint"))
  .option("--print", t("ui.printHintTable"))
  .option("--tui", t("ui.tuiHint"))
  .option("--label-a <label>", t("ui.labelAHint"))
  .option("--label-b <label>", t("ui.labelBHint"))
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

const mcp = program.command("mcp").description(t("cli.mcp"));

mcp
  .command("list")
  .description(t("ui.mcpListDescription"))
  .option("--json", t("ui.jsonHintCatalog"))
  .action((opts) => {
    mcpListCommand({ json: !!opts.json });
  });

mcp
  .command("inspect <spec>")
  .description(t("ui.mcpInspectDescription"))
  .option("--json", t("ui.jsonHintReport"))
  .action(async (spec: string, opts) => {
    try {
      await mcpInspectCommand({ spec, json: !!opts.json });
    } catch (err) {
      process.stderr.write(`mcp inspect failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program.command("version").description(t("cli.version")).action(versionCommand);

program
  .command("update")
  .description(t("cli.update"))
  .option("--dry-run", t("ui.dryRunHint"))
  .action(async (opts: { dryRun?: boolean }) => {
    await updateCommand({ dryRun: !!opts.dryRun });
  });

program
  .command("index")
  .description(t("cli.index"))
  .option("--rebuild", t("ui.rebuildHint"))
  .option("--model <name>", t("ui.embedModelHint"))
  .option("--dir <path>", t("ui.projectDirHint"))
  .option("--ollama-url <url>", t("ui.ollamaUrlHint"))
  .option("-y, --yes", t("ui.skipPromptsHint"))
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
