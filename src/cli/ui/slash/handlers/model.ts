import { saveReasoningEffort } from "../../../../config.js";
import { t } from "../../../../i18n/index.js";
import { PRESETS } from "../../presets.js";
import type { SlashHandler } from "../dispatch.js";

const model: SlashHandler = (args, loop, ctx) => {
  const id = args[0];
  const known = ctx.models ?? null;
  if (!id) {
    const hint = known && known.length > 0 ? known.join(" | ") : t("handlers.model.modelHint");
    return { info: t("handlers.model.modelUsage", { hint }) };
  }
  loop.configure({ model: id });
  if (known && known.length > 0 && !known.includes(id)) {
    return {
      info: t("handlers.model.modelNotInCatalog", { id, list: known.join(", ") }),
    };
  }
  return { info: t("handlers.model.modelSet", { id }) };
};

const models: SlashHandler = (_args, loop, ctx) => {
  const list = ctx.models ?? null;
  if (list === null) {
    ctx.refreshModels?.();
    return { info: t("handlers.model.modelsFetching") };
  }
  if (list.length === 0) {
    return { info: t("handlers.model.modelsEmpty") };
  }
  const current = loop.model;
  const lines = list.map((id) =>
    id === current ? t("handlers.model.modelsCurrent", { id }) : `  ${id}`,
  );
  return {
    info: [
      t("handlers.model.modelsHeader", { count: list.length }),
      "",
      ...lines,
      "",
      t("handlers.model.modelsSwitch"),
    ].join("\n"),
  };
};

const harvest: SlashHandler = (args, loop) => {
  const arg = (args[0] ?? "").toLowerCase();
  const on = arg === "" ? !loop.harvestEnabled : arg === "on" || arg === "true" || arg === "1";
  loop.configure({ harvest: on });
  if (loop.harvestEnabled) {
    return { info: t("handlers.model.harvestOn") };
  }
  return { info: t("handlers.model.harvestOff") };
};

const preset: SlashHandler = (args, loop) => {
  const name = (args[0] ?? "").toLowerCase();
  const applyAndPersist = (effort: "high" | "max") => {
    try {
      saveReasoningEffort(effort);
    } catch {
      /* disk full / perms — runtime change still took effect */
    }
  };
  if (name === "auto") {
    const p = PRESETS.auto;
    loop.configure({
      model: p.model,
      autoEscalate: p.autoEscalate,
      reasoningEffort: p.reasoningEffort,
      harvest: p.harvest,
      branch: p.branch,
    });
    applyAndPersist(p.reasoningEffort);
    return { info: t("handlers.model.presetAuto") };
  }
  if (name === "flash") {
    const p = PRESETS.flash;
    loop.configure({
      model: p.model,
      autoEscalate: p.autoEscalate,
      reasoningEffort: p.reasoningEffort,
      harvest: p.harvest,
      branch: p.branch,
    });
    applyAndPersist(p.reasoningEffort);
    return { info: t("handlers.model.presetFlash") };
  }
  if (name === "pro") {
    const p = PRESETS.pro;
    loop.configure({
      model: p.model,
      autoEscalate: p.autoEscalate,
      reasoningEffort: p.reasoningEffort,
      harvest: p.harvest,
      branch: p.branch,
    });
    applyAndPersist(p.reasoningEffort);
    return { info: t("handlers.model.presetPro") };
  }
  return { info: t("handlers.model.presetUsage") };
};

const branch: SlashHandler = (args, loop) => {
  const raw = (args[0] ?? "").toLowerCase();
  if (raw === "" || raw === "off" || raw === "0" || raw === "1") {
    loop.configure({ branch: 1 });
    return { info: t("handlers.model.branchOff") };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 2) {
    return { info: t("handlers.model.branchUsage") };
  }
  if (n > 8) {
    return { info: t("handlers.model.branchCapped") };
  }
  loop.configure({ branch: n });
  return { info: t("handlers.model.branchSet", { n }) };
};

const effort: SlashHandler = (args, loop) => {
  const raw = (args[0] ?? "").toLowerCase();
  if (raw === "") {
    return { info: t("handlers.model.effortStatus", { effort: loop.reasoningEffort }) };
  }
  if (raw !== "high" && raw !== "max") {
    return { info: t("handlers.model.effortUsage") };
  }
  loop.configure({ reasoningEffort: raw });
  try {
    saveReasoningEffort(raw);
  } catch {
    /* disk full / perms — runtime change still took effect */
  }
  return { info: t("handlers.model.effortSet", { effort: raw }) };
};

const ESCALATION_MODEL_ID = "deepseek-v4-pro";

const pro: SlashHandler = (args, loop, ctx) => {
  const arg = (args[0] ?? "").toLowerCase();
  if (arg === "off" || arg === "cancel" || arg === "disarm") {
    if (!loop.proArmed) {
      return { info: t("handlers.model.proNothingArmed") };
    }
    if (ctx.disarmPro) ctx.disarmPro();
    else loop.disarmPro();
    return { info: t("handlers.model.proDisarmed") };
  }
  if (arg && arg !== "on" && arg !== "arm") {
    return { info: t("handlers.model.proUsage") };
  }
  if (ctx.armPro) ctx.armPro();
  else loop.armProForNextTurn();
  return {
    info: t("handlers.model.proArmed", { model: ESCALATION_MODEL_ID }),
  };
};

const budget: SlashHandler = (args, loop) => {
  const arg = args[0]?.trim() ?? "";
  if (arg === "") {
    if (loop.budgetUsd === null) {
      return { info: t("handlers.model.budgetNoCap") };
    }
    const spent = loop.stats.totalCost;
    const pct = (spent / loop.budgetUsd) * 100;
    return {
      info: t("handlers.model.budgetStatus", {
        spent: spent.toFixed(4),
        cap: loop.budgetUsd.toFixed(2),
        pct: pct.toFixed(1),
      }),
    };
  }
  if (arg === "off" || arg === "none" || arg === "0") {
    loop.setBudget(null);
    return { info: t("handlers.model.budgetOff") };
  }
  const cleaned = arg.replace(/^\$/, "");
  const usd = Number(cleaned);
  if (!Number.isFinite(usd) || usd <= 0) {
    return { info: t("handlers.model.budgetUsage", { arg }) };
  }
  loop.setBudget(usd);
  const spent = loop.stats.totalCost;
  if (spent >= usd) {
    return {
      info: t("handlers.model.budgetExhausted", {
        cap: usd.toFixed(2),
        spent: spent.toFixed(4),
      }),
    };
  }
  return {
    info: t("handlers.model.budgetSet", {
      cap: usd.toFixed(2),
      spent: spent.toFixed(4),
    }),
  };
};

export const handlers: Record<string, SlashHandler> = {
  model,
  models,
  harvest,
  preset,
  branch,
  effort,
  pro,
  budget,
};
