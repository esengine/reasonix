import { saveReasoningEffort } from "../../../../config.js";
import { PRESETS } from "../../presets.js";
import type { SlashHandler } from "../dispatch.js";

const model: SlashHandler = (args, loop, ctx) => {
  const id = args[0];
  const known = ctx.models ?? null;
  if (!id) {
    const hint =
      known && known.length > 0
        ? known.join(" | ")
        : "try deepseek-v4-flash or deepseek-v4-pro — run /models to fetch the live list";
    return { info: `usage: /model <id>   (${hint})` };
  }
  loop.configure({ model: id });
  // Soft validation: if we have the live list and the id isn't in
  // it, flag a warning but still switch — DeepSeek may have just
  // released something we haven't indexed yet, and refusing would
  // be worse than a bad API error on the next call.
  if (known && known.length > 0 && !known.includes(id)) {
    return {
      info: `model → ${id}   (⚠ not in the fetched catalog: ${known.join(", ")}. If this is wrong the next call will 400 — run /models to refresh.)`,
    };
  }
  return { info: `model → ${id}` };
};

const models: SlashHandler = (_args, loop, ctx) => {
  const list = ctx.models ?? null;
  if (list === null) {
    ctx.refreshModels?.();
    return {
      info: "fetching /models from DeepSeek… run /models again in a moment. If it stays empty, your API key may lack permission or the network is blocked.",
    };
  }
  if (list.length === 0) {
    return {
      info: "DeepSeek /models returned an empty list. Try /models again, or check your account status at api-docs.deepseek.com.",
    };
  }
  const current = loop.model;
  const lines = list.map((id) => (id === current ? `▸ ${id}  (current)` : `  ${id}`));
  return {
    info: [
      `Available models (DeepSeek /models · ${list.length} total):`,
      "",
      ...lines,
      "",
      "Switch with: /model <id>",
    ].join("\n"),
  };
};

const harvest: SlashHandler = (args, loop) => {
  const arg = (args[0] ?? "").toLowerCase();
  const on = arg === "" ? !loop.harvestEnabled : arg === "on" || arg === "true" || arg === "1";
  loop.configure({ harvest: on });
  if (loop.harvestEnabled) {
    return {
      info: "harvest → on  (Pillar-2 plan-state extraction · +1 cheap flash call per turn · opt-in only; no preset turns it on)",
    };
  }
  return { info: "harvest → off" };
};

const preset: SlashHandler = (args, loop) => {
  const name = (args[0] ?? "").toLowerCase();
  // Persist the effort along with the preset change so a relaunch
  // doesn't revert to the previously-saved /effort value.
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
    return { info: "preset → auto  (v4-flash → v4-pro on hard turns · default)" };
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
    return { info: "preset → flash  (v4-flash always · cheapest · /pro still bumps one turn)" };
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
    return { info: "preset → pro  (v4-pro always · ~3× flash · for hard multi-turn work)" };
  }
  return { info: "usage: /preset <auto|flash|pro>" };
};

const branch: SlashHandler = (args, loop) => {
  const raw = (args[0] ?? "").toLowerCase();
  if (raw === "" || raw === "off" || raw === "0" || raw === "1") {
    loop.configure({ branch: 1 });
    return { info: "branch → off" };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 2) {
    return { info: "usage: /branch <N>   (N>=2, or 'off')" };
  }
  if (n > 8) {
    return { info: "branch budget capped at 8 to prevent runaway cost" };
  }
  loop.configure({ branch: n });
  return {
    info: `branch → ${n}  (runs ${n} parallel samples per turn · ${n}× per-turn cost · streaming disabled · manual only, no preset enables branching)`,
  };
};

const effort: SlashHandler = (args, loop) => {
  const raw = (args[0] ?? "").toLowerCase();
  if (raw === "") {
    return {
      info: `reasoning_effort → ${loop.reasoningEffort}  (use /effort high for cheaper/faster, /effort max for the agent-class default · persisted across relaunches)`,
    };
  }
  if (raw !== "high" && raw !== "max") {
    return { info: "usage: /effort <high|max>" };
  }
  loop.configure({ reasoningEffort: raw });
  // Persist so the next launch starts with this value instead of
  // reverting to the constructor default.
  try {
    saveReasoningEffort(raw);
  } catch {
    /* disk full / perms — runtime change still took effect */
  }
  return { info: `reasoning_effort → ${raw} (persisted)` };
};

const pro: SlashHandler = (args, loop, ctx) => {
  const arg = (args[0] ?? "").toLowerCase();
  if (arg === "off" || arg === "cancel" || arg === "disarm") {
    if (!loop.proArmed) {
      return { info: "nothing armed — /pro with no args will arm pro for your next turn" };
    }
    if (ctx.disarmPro) ctx.disarmPro();
    else loop.disarmPro();
    return { info: "▸ /pro disarmed — next turn falls back to the current preset" };
  }
  if (arg && arg !== "on" && arg !== "arm") {
    return {
      info: "usage: /pro       arm pro for the next turn (one-shot, auto-disarms after)\n       /pro off  cancel armed state before the next turn",
    };
  }
  if (ctx.armPro) ctx.armPro();
  else loop.armProForNextTurn();
  return {
    info: `▸ /pro armed — your NEXT message runs on ${ESCALATION_MODEL_ID} regardless of preset. Auto-disarms after one turn. Use /preset max for a persistent switch.`,
  };
};

// Kept in sync with loop.ts ESCALATION_MODEL — hard-coding rather than
// importing it because loop.ts already exports enough surface, and this
// string is user-facing (description strings stay verbatim even if the
// internal constant renames).
const ESCALATION_MODEL_ID = "deepseek-v4-pro";

const budget: SlashHandler = (args, loop) => {
  const arg = args[0]?.trim() ?? "";
  // Bare /budget → status. No-cap state is the default Reasonix ships
  // with, so the message stays calm rather than making it sound like
  // a missing config.
  if (arg === "") {
    if (loop.budgetUsd === null) {
      return {
        info: "no session budget set — Reasonix will keep going until you stop it. Set one with: /budget <usd>   (e.g. /budget 5)",
      };
    }
    const spent = loop.stats.totalCost;
    const pct = (spent / loop.budgetUsd) * 100;
    return {
      info: `budget: $${spent.toFixed(4)} of $${loop.budgetUsd.toFixed(2)} (${pct.toFixed(1)}%) · /budget off to clear, /budget <usd> to change`,
    };
  }
  // Explicit clear.
  if (arg === "off" || arg === "none" || arg === "0") {
    loop.setBudget(null);
    return { info: "budget → off (no cap)" };
  }
  // Strip a leading $ since users will type it half the time.
  const cleaned = arg.replace(/^\$/, "");
  const usd = Number(cleaned);
  if (!Number.isFinite(usd) || usd <= 0) {
    return {
      info: `usage: /budget <usd>   (got "${arg}" — must be a positive number, e.g. /budget 5 or /budget 12.50)`,
    };
  }
  loop.setBudget(usd);
  const spent = loop.stats.totalCost;
  if (spent >= usd) {
    return {
      info: `▲ budget → $${usd.toFixed(2)} but already spent $${spent.toFixed(4)}. Next turn will be refused — bump the cap higher to keep going, or end the session.`,
    };
  }
  return {
    info: `budget → $${usd.toFixed(2)}  (so far: $${spent.toFixed(4)} · warns at 80%, refuses next turn at 100% · /budget off to clear)`,
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
