import { saveReasoningEffort } from "../../../../config.js";
import type { SlashHandler } from "../dispatch.js";

const model: SlashHandler = (args, loop, ctx) => {
  const id = args[0];
  const known = ctx.models ?? null;
  if (!id) {
    const hint =
      known && known.length > 0
        ? known.join(" | ")
        : "try deepseek-chat or deepseek-reasoner — run /models to fetch the live list";
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
  return { info: `harvest → ${loop.harvestEnabled ? "on" : "off"}` };
};

const preset: SlashHandler = (args, loop) => {
  const name = (args[0] ?? "").toLowerCase();
  if (name === "fast" || name === "default") {
    loop.configure({ model: "deepseek-chat", harvest: false, branch: 1 });
    return { info: "preset → fast  (deepseek-chat, no harvest, no branch)" };
  }
  if (name === "smart") {
    loop.configure({ model: "deepseek-reasoner", harvest: true, branch: 1 });
    return { info: "preset → smart  (reasoner + harvest, ~10x cost vs fast)" };
  }
  if (name === "max" || name === "best") {
    loop.configure({ model: "deepseek-reasoner", harvest: true, branch: 3 });
    return {
      info: "preset → max  (reasoner + harvest + branch3, ~30x cost vs fast, slowest)",
    };
  }
  return { info: "usage: /preset <fast|smart|max>" };
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
  return { info: `branch → ${n}  (harvest auto-enabled; streaming disabled)` };
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

export const handlers: Record<string, SlashHandler> = {
  model,
  models,
  harvest,
  preset,
  branch,
  effort,
};
