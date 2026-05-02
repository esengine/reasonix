import { t } from "../../../../i18n/index.js";
import { formatDuration, formatLoopStatus, parseLoopCommand } from "../../loop.js";
import type { SlashHandler } from "../dispatch.js";

const exit: SlashHandler = () => ({ exit: true });

const clear: SlashHandler = () => ({
  clear: true,
  info: t("handlers.basic.clearInfo"),
});

const resetLog: SlashHandler = (_args, loop) => {
  const { dropped } = loop.clearLog();
  return {
    clear: true,
    info: t("handlers.basic.newInfo", { count: dropped }),
  };
};

const keys: SlashHandler = () => ({
  info: [
    t("handlers.basic.keysTitle"),
    "",
    t("handlers.basic.keysEnter"),
    t("handlers.basic.keysNewline"),
    t("handlers.basic.keysContinue"),
    t("handlers.basic.keysArrow"),
    t("handlers.basic.keysPage"),
    t("handlers.basic.keysHomeEnd"),
    t("handlers.basic.keysClearLine"),
    t("handlers.basic.keysDeleteWord"),
    t("handlers.basic.keysBackspace"),
    t("handlers.basic.keysEsc"),
    t("handlers.basic.keysEditYn"),
    t("handlers.basic.keysEditTab"),
    t("handlers.basic.keysEditUndo"),
    "",
    t("handlers.basic.keysPromptTitle"),
    t("handlers.basic.keysSlash"),
    t("handlers.basic.keysAtFile"),
    t("handlers.basic.keysAtFilePicker"),
    t("handlers.basic.keysAtUrl"),
    t("handlers.basic.keysAtUrlCache"),
    t("handlers.basic.keysBang"),
    t("handlers.basic.keysBangDetail"),
    t("handlers.basic.keysHash"),
    t("handlers.basic.keysHashGlobal"),
    t("handlers.basic.keysHashBoth"),
    t("handlers.basic.keysHashEscape"),
    "",
    t("handlers.basic.keysPickersTitle"),
    t("handlers.basic.keysPickerNav"),
    t("handlers.basic.keysPickerTab"),
    t("handlers.basic.keysPickerEnter"),
    "",
    t("handlers.basic.keysMcpTitle"),
    t("handlers.basic.keysMcpServers"),
    t("handlers.basic.keysMcpResource"),
    t("handlers.basic.keysMcpPrompt"),
    "",
    t("handlers.basic.keysUseful"),
  ].join("\n"),
});

const help: SlashHandler = () => ({
  info: [
    t("handlers.basic.helpTitle"),
    t("handlers.basic.helpHelp"),
    t("handlers.basic.helpKeys"),
    t("handlers.basic.helpStatus"),
    t("handlers.basic.helpPreset"),
    t("handlers.basic.helpModel"),
    t("handlers.basic.helpPro"),
    t("handlers.basic.helpHarvest"),
    t("handlers.basic.helpBranch"),
    t("handlers.basic.helpEffort"),
    t("handlers.basic.helpMcp"),
    t("handlers.basic.helpResource"),
    t("handlers.basic.helpPrompt"),
    t("handlers.basic.helpSetup"),
    t("handlers.basic.helpCompact"),
    t("handlers.basic.helpThink"),
    t("handlers.basic.helpTool"),
    t("handlers.basic.helpCost"),
    t("handlers.basic.helpMemory"),
    t("handlers.basic.helpMemorySub"),
    t("handlers.basic.helpSkill"),
    t("handlers.basic.helpSkillSub"),
    t("handlers.basic.helpRetry"),
    t("handlers.basic.helpApply"),
    t("handlers.basic.helpDiscard"),
    t("handlers.basic.helpWalk"),
    t("handlers.basic.helpUndo"),
    t("handlers.basic.helpHistory"),
    t("handlers.basic.helpShow"),
    t("handlers.basic.helpCommit"),
    t("handlers.basic.helpPlan"),
    t("handlers.basic.helpApplyPlan"),
    t("handlers.basic.helpMode"),
    t("handlers.basic.helpJobs"),
    t("handlers.basic.helpKill"),
    t("handlers.basic.helpLogs"),
    t("handlers.basic.helpSessions"),
    t("handlers.basic.helpForget"),
    t("handlers.basic.helpNew"),
    t("handlers.basic.helpClear"),
    t("handlers.basic.helpLoop"),
    t("handlers.basic.helpExit"),
    "",
    t("handlers.basic.helpShellTitle"),
    t("handlers.basic.helpShell"),
    t("handlers.basic.helpShellDetail"),
    t("handlers.basic.helpShellConsent"),
    t("handlers.basic.helpShellExample"),
    "",
    t("handlers.basic.helpMemoryTitle"),
    t("handlers.basic.helpMemoryPin"),
    t("handlers.basic.helpMemoryPinEx"),
    t("handlers.basic.helpMemoryGlobal"),
    t("handlers.basic.helpMemoryGlobalEx"),
    t("handlers.basic.helpMemoryPinBoth"),
    t("handlers.basic.helpMemoryEscape"),
    "",
    t("handlers.basic.helpFileTitle"),
    t("handlers.basic.helpFile"),
    t("handlers.basic.helpFilePicker"),
    "",
    t("handlers.basic.helpUrlTitle"),
    t("handlers.basic.helpUrl"),
    t("handlers.basic.helpUrlCache"),
    t("handlers.basic.helpUrlPunct"),
    "",
    t("handlers.basic.helpPresetsTitle"),
    t("handlers.basic.helpPresetAuto"),
    t("handlers.basic.helpPresetFlash"),
    t("handlers.basic.helpPresetPro"),
    "",
    t("handlers.basic.helpSessionsTitle"),
    t("handlers.basic.helpSessionCustom"),
    t("handlers.basic.helpSessionNone"),
    "",
    t("handlers.basic.helpLimitationTitle"),
    t("handlers.basic.helpLimitation1"),
    t("handlers.basic.helpLimitation2"),
    t("handlers.basic.helpLimitation3"),
    t("handlers.basic.helpLimitation4"),
  ].join("\n"),
});

const setup: SlashHandler = () => ({
  info: t("handlers.basic.setupInfo"),
});

const retry: SlashHandler = (_args, loop) => {
  const prev = loop.retryLastUser();
  if (!prev) {
    return { info: t("handlers.basic.retryNone") };
  }
  const preview = prev.length > 80 ? `${prev.slice(0, 80)}…` : prev;
  return {
    info: t("handlers.basic.retryInfo", { preview }),
    resubmit: prev,
  };
};

const loop: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.startLoop || !ctx.stopLoop || !ctx.getLoopStatus) {
    return { info: t("handlers.basic.loopTuiOnly") };
  }
  const cmd = parseLoopCommand(args);
  if (cmd.kind === "error") return { info: cmd.message };
  if (cmd.kind === "stop") {
    const wasActive = ctx.getLoopStatus() !== null;
    ctx.stopLoop();
    return {
      info: wasActive ? t("handlers.basic.loopStopped") : t("handlers.basic.loopNoActive"),
    };
  }
  if (cmd.kind === "status") {
    const status = ctx.getLoopStatus();
    if (!status) {
      return { info: t("handlers.basic.loopNoActiveHint") };
    }
    return { info: `▸ ${formatLoopStatus(status.prompt, status.nextFireMs, status.iter)}` };
  }
  ctx.startLoop(cmd.intervalMs, cmd.prompt);
  return {
    info: t("handlers.basic.loopStarted", {
      prompt: cmd.prompt,
      duration: formatDuration(cmd.intervalMs),
    }),
  };
};

export const handlers: Record<string, SlashHandler> = {
  exit,
  quit: exit,
  clear,
  new: resetLog,
  reset: resetLog,
  keys,
  help,
  "?": help,
  setup,
  retry,
  loop,
};
