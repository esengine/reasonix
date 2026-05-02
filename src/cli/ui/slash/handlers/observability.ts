import { t } from "../../../../i18n/index.js";
import {
  DEEPSEEK_CONTEXT_TOKENS,
  DEEPSEEK_PRICING,
  DEFAULT_CONTEXT_TOKENS,
} from "../../../../telemetry/stats.js";
import { countTokens } from "../../../../tokenizer.js";
import { computeCtxBreakdown } from "../../ctx-breakdown.js";
import type { SlashHandler } from "../dispatch.js";
import { compactNum, formatToolList } from "../helpers.js";

const think: SlashHandler = (_args, loop) => {
  const raw = loop.scratch.reasoning;
  if (!raw || !raw.trim()) {
    return { info: t("handlers.observability.thinkEmpty") };
  }
  return {
    info: `${t("handlers.observability.thinkInfo", { count: raw.length })}\n\n${raw.trim()}`,
  };
};

const tool: SlashHandler = (args, _loop, ctx) => {
  const history = ctx.toolHistory?.() ?? [];
  if (history.length === 0) {
    return { info: t("handlers.observability.toolEmpty") };
  }
  const raw = (args[0] ?? "").toLowerCase();
  if (raw === "" || raw === "list" || raw === "ls") {
    return { info: formatToolList(history) };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return { info: t("handlers.observability.toolUsage") };
  }
  if (n > history.length) {
    return { info: t("handlers.observability.toolOob", { count: history.length, n }) };
  }
  const entry = history[history.length - n];
  if (!entry) {
    return { info: t("handlers.observability.toolNotFound", { n }) };
  }
  return {
    info: `${t("handlers.observability.toolInfo", { name: entry.toolName, n, chars: entry.text.length })}\n\n${entry.text}`,
  };
};

const context: SlashHandler = (_args, loop) => {
  const breakdown = computeCtxBreakdown(loop);
  const total =
    breakdown.systemTokens + breakdown.toolsTokens + breakdown.logTokens + breakdown.inputTokens;
  const winPct = breakdown.ctxMax > 0 ? Math.round((total / breakdown.ctxMax) * 100) : 0;
  const fallbackInfo = t("handlers.observability.contextInfo", {
    total: compactNum(total),
    max: compactNum(breakdown.ctxMax),
    pct: winPct,
    sys: compactNum(breakdown.systemTokens),
    tools: compactNum(breakdown.toolsTokens),
    log: compactNum(breakdown.logTokens),
  });
  return { info: fallbackInfo, ctxBreakdown: breakdown };
};

const status: SlashHandler = (_args, loop, ctx) => {
  const branchBudget = loop.branchOptions.budget ?? 1;
  const ctxMax = DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS;
  const summary = loop.stats.summary();
  const lastPromptTokens = summary.lastPromptTokens;
  const ctxPct = ctxMax > 0 ? Math.round((lastPromptTokens / ctxMax) * 100) : 0;
  const ctxBar = lastPromptTokens > 0 ? renderTinyBar(ctxPct, 16) : "";
  const ctxLine =
    lastPromptTokens > 0
      ? t("handlers.observability.statusCtx", {
          bar: ctxBar,
          used: compactNum(lastPromptTokens),
          max: compactNum(ctxMax),
          pct: ctxPct,
        })
      : t("handlers.observability.statusCtxNone");

  const cost = summary.totalCostUsd;
  const cacheLine =
    summary.turns > 3
      ? (() => {
          const cachePct = Math.round(summary.cacheHitRatio * 100);
          return t("handlers.observability.statusCost", {
            cost: cost.toFixed(4),
            bar: renderTinyBar(cachePct, 12),
            pct: cachePct,
            turns: summary.turns,
          });
        })()
      : t("handlers.observability.statusCostCold", {
          cost: cost.toFixed(4),
          turns: summary.turns,
        });

  const budgetLine =
    typeof loop.budgetUsd === "number"
      ? (() => {
          const pct = Math.round((cost / loop.budgetUsd!) * 100);
          const tag = pct >= 100 ? " ▲ EXHAUSTED" : pct >= 80 ? " ▲ 80%+" : "";
          return t("handlers.observability.statusBudget", {
            spent: cost.toFixed(4),
            cap: loop.budgetUsd!.toFixed(2),
            pct,
            tag,
          });
        })()
      : "";

  const pending = ctx.pendingEditCount ?? 0;
  const sessionLine = loop.sessionName
    ? t("handlers.observability.statusSession", {
        name: loop.sessionName,
        count: loop.log.length,
        resumed: loop.resumedMessageCount,
      })
    : t("handlers.observability.statusSessionEphemeral");
  const mcpCount = ctx.mcpSpecs?.length ?? 0;
  const toolCount = loop.prefix.toolSpecs.length;
  const mcpLine = t("handlers.observability.statusMcp", { servers: mcpCount, tools: toolCount });
  const pendingLine =
    pending > 0 ? t("handlers.observability.statusEdits", { count: pending }) : "";
  const planLine = ctx.planMode ? t("handlers.observability.statusPlan") : "";
  const modeLine =
    ctx.editMode === "yolo"
      ? t("handlers.observability.statusModeYolo")
      : ctx.editMode === "auto"
        ? t("handlers.observability.statusModeAuto")
        : ctx.editMode === "review"
          ? t("handlers.observability.statusModeReview")
          : "";
  const dashUrl = ctx.getDashboardUrl?.();
  const dashLine = dashUrl ? t("handlers.observability.statusDash", { url: dashUrl }) : "";
  const lines = [
    t("handlers.observability.statusModel", { model: loop.model }),
    t("handlers.observability.statusFlags", {
      harvest: loop.harvestEnabled ? "on" : "off",
      branch: branchBudget > 1 ? branchBudget : "off",
      stream: loop.stream ? "on" : "off",
      effort: loop.reasoningEffort,
    }),
    cacheLine,
    ctxLine,
    mcpLine,
    sessionLine,
  ];
  if (budgetLine) lines.push(budgetLine);
  if (pendingLine) lines.push(pendingLine);
  if (planLine) lines.push(planLine);
  if (modeLine) lines.push(modeLine);
  if (dashLine) lines.push(dashLine);
  return { info: lines.join("\n") };
};

function renderTinyBar(pct: number, width: number): string {
  const w = Math.max(4, width);
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((w * clamped) / 100);
  return `[${"█".repeat(filled)}${"░".repeat(w - filled)}]`;
}

const compact: SlashHandler = (args, loop) => {
  const tight = Number.parseInt(args[0] ?? "", 10);
  const cap = Number.isFinite(tight) && tight >= 100 ? tight : 4000;
  const { healedCount, tokensSaved, charsSaved } = loop.compact(cap);
  if (healedCount === 0) {
    return {
      info: t("handlers.observability.compactNone", { cap: cap.toLocaleString() }),
    };
  }
  return {
    info: t("handlers.observability.compactInfo", {
      count: healedCount,
      cap: cap.toLocaleString(),
      tokens: tokensSaved.toLocaleString(),
      chars: charsSaved.toLocaleString(),
    }),
  };
};

const cost: SlashHandler = (args, loop, ctx) => {
  if (args.length > 0) {
    return estimateCost(args.join(" "), loop);
  }
  const turn = loop.stats.turns[loop.stats.turns.length - 1];
  if (!turn) {
    return { info: t("handlers.observability.costNoTurn") };
  }
  if (!ctx.postUsage) {
    return { info: t("handlers.observability.costNeedsTui") };
  }
  const summary = loop.stats.summary();
  const ctxMax = DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS;
  ctx.postUsage({
    turn: turn.turn,
    promptTokens: turn.usage.promptTokens,
    reasonTokens: 0,
    outputTokens: turn.usage.completionTokens,
    promptCap: ctxMax,
    cacheHit: turn.cacheHitRatio,
    cost: turn.cost,
    sessionCost: summary.totalCostUsd,
  });
  return {};
};

function estimateCost(userText: string, loop: import("../../../../loop.js").CacheFirstLoop) {
  const pricing = DEEPSEEK_PRICING[loop.model];
  if (!pricing) {
    return { info: t("handlers.observability.costNoPricing", { model: loop.model }) };
  }
  const userTokens = countTokens(userText);
  const breakdown = computeCtxBreakdown(loop);
  const promptTokens =
    breakdown.systemTokens + breakdown.toolsTokens + breakdown.logTokens + userTokens;

  const turns = loop.stats.turns;
  const avgOutput =
    turns.length > 0
      ? Math.round(turns.reduce((s, tk) => s + tk.usage.completionTokens, 0) / turns.length)
      : 800;
  const cacheHit = loop.stats.summary().cacheHitRatio;

  const inputUsdMiss = (promptTokens * pricing.inputCacheMiss) / 1_000_000;
  const inputUsdLikely =
    (promptTokens * ((1 - cacheHit) * pricing.inputCacheMiss + cacheHit * pricing.inputCacheHit)) /
    1_000_000;
  const outputUsd = (avgOutput * pricing.output) / 1_000_000;

  const fmt = (n: number) => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(4)}`;
  const lines = [
    t("handlers.observability.costEstimate", {
      model: loop.model,
      prompt: promptTokens.toLocaleString(),
      sys: compactNum(breakdown.systemTokens),
      tools: compactNum(breakdown.toolsTokens),
      log: compactNum(breakdown.logTokens),
      msg: compactNum(userTokens),
    }),
    t("handlers.observability.costWorstCase", {
      input: fmt(inputUsdMiss),
      output: fmt(outputUsd),
      avg: avgOutput.toLocaleString(),
      total: fmt(inputUsdMiss + outputUsd),
    }),
    turns.length > 0
      ? t("handlers.observability.costLikely", {
          pct: Math.round(cacheHit * 100),
          input: fmt(inputUsdLikely),
          output: fmt(outputUsd),
          total: fmt(inputUsdLikely + outputUsd),
        })
      : t("handlers.observability.costLikelyCold"),
  ];
  return { info: lines.join("\n") };
}

export const handlers: Record<string, SlashHandler> = {
  think,
  reasoning: think,
  tool,
  context,
  status,
  compact,
  cost,
};
