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
    return {
      info:
        "no reasoning cached. `/think` shows the full thinking-mode thought for the most recent " +
        "turn — only thinking-mode models (deepseek-v4-flash / -v4-pro / -reasoner) produce it, " +
        "and only once the turn completes.",
    };
  }
  return { info: `↳ full thinking (${raw.length} chars):\n\n${raw.trim()}` };
};

const tool: SlashHandler = (args, _loop, ctx) => {
  // ToolCard clips display to a one-line summary; users need the full
  // text to verify the model isn't hallucinating a file's contents.
  // `/tool` is the escape hatch.
  const history = ctx.toolHistory?.() ?? [];
  if (history.length === 0) {
    return {
      info:
        "no tool calls yet in this session. `/tool` lists them once the model has actually " +
        "used a tool; `/tool N` dumps the full (untruncated) output of the Nth-most-recent.",
    };
  }
  const raw = (args[0] ?? "").toLowerCase();
  if (raw === "" || raw === "list" || raw === "ls") {
    return { info: formatToolList(history) };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return {
      info: "usage: /tool [N]   (no arg → list; N=1 → most recent result in full, N=2 → previous, …)",
    };
  }
  if (n > history.length) {
    return {
      info: `only ${history.length} tool call(s) in history — asked for #${n}. Try /tool with no arg to see the list.`,
    };
  }
  const entry = history[history.length - n];
  if (!entry) {
    return { info: `could not read tool call #${n}` };
  }
  return {
    info: `↳ tool<${entry.toolName}> #${n} (${entry.text.length} chars):\n\n${entry.text}`,
  };
};

const context: SlashHandler = (_args, loop) => {
  const breakdown = computeCtxBreakdown(loop);
  const total =
    breakdown.systemTokens + breakdown.toolsTokens + breakdown.logTokens + breakdown.inputTokens;
  const winPct = breakdown.ctxMax > 0 ? Math.round((total / breakdown.ctxMax) * 100) : 0;
  const fallbackInfo = `context: ~${compactNum(total)} of ${compactNum(breakdown.ctxMax)} (${winPct}%) · system ${compactNum(breakdown.systemTokens)} · tools ${compactNum(breakdown.toolsTokens)} · log ${compactNum(breakdown.logTokens)}`;
  return { info: fallbackInfo, ctxBreakdown: breakdown };
};

const status: SlashHandler = (_args, loop, ctx) => {
  const branchBudget = loop.branchOptions.budget ?? 1;
  const ctxMax = DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS;
  const summary = loop.stats.summary();
  const lastPromptTokens = summary.lastPromptTokens;
  const ctxPct = ctxMax > 0 ? Math.round((lastPromptTokens / ctxMax) * 100) : 0;
  // 16-cell context bar — narrower than /context's 48 since /status is
  // a quick glance, not the deep dive. Same `█/░` characters so the
  // visual grammar stays consistent across slashes.
  const ctxBar = lastPromptTokens > 0 ? renderTinyBar(ctxPct, 16) : "";
  const ctxLine =
    lastPromptTokens > 0
      ? `  ctx     ${ctxBar} ${compactNum(lastPromptTokens)}/${compactNum(ctxMax)} (${ctxPct}%)`
      : "  ctx     no turns yet";

  // Cost / cache hit row — the high-signal numbers from StatsPanel.
  // Cache pct only shown after the cold-start window so a 0.0% on
  // turn 1 doesn't read as broken.
  const cost = summary.totalCostUsd;
  const cacheLine =
    summary.turns > 3
      ? (() => {
          const cachePct = Math.round(summary.cacheHitRatio * 100);
          return `  cost    $${cost.toFixed(4)} · cache ${renderTinyBar(cachePct, 12)} ${cachePct}% · turns ${summary.turns}`;
        })()
      : `  cost    $${cost.toFixed(4)} · turns ${summary.turns} (cache warming up)`;

  // Budget row — only when a cap is set
  const budgetLine =
    typeof loop.budgetUsd === "number"
      ? (() => {
          const pct = Math.round((cost / loop.budgetUsd!) * 100);
          const tag = pct >= 100 ? " ▲ EXHAUSTED" : pct >= 80 ? " ▲ 80%+" : "";
          return `  budget  $${cost.toFixed(4)} / $${loop.budgetUsd!.toFixed(2)} (${pct}%)${tag}`;
        })()
      : "";

  const pending = ctx.pendingEditCount ?? 0;
  const sessionLine = loop.sessionName
    ? `  session "${loop.sessionName}" · ${loop.log.length} messages in log (resumed ${loop.resumedMessageCount})`
    : "  session (ephemeral — no persistence)";
  const mcpCount = ctx.mcpSpecs?.length ?? 0;
  const toolCount = loop.prefix.toolSpecs.length;
  const mcpLine = `  mcp     ${mcpCount} server(s), ${toolCount} tool(s) in registry`;
  const pendingLine =
    pending > 0 ? `  edits   ${pending} pending (/apply to commit, /discard to drop)` : "";
  const planLine = ctx.planMode ? "  plan    ON — writes gated (submit_plan + approval)" : "";
  const modeLine =
    ctx.editMode === "yolo"
      ? "  mode    YOLO — edits + shell auto-run with no prompt (/undo still rolls back · Shift+Tab to flip)"
      : ctx.editMode === "auto"
        ? "  mode    AUTO — edits apply immediately (u to undo within 5s · Shift+Tab to flip)"
        : ctx.editMode === "review"
          ? "  mode    review — edits queue for /apply or y  (Shift+Tab to flip)"
          : "";
  const dashLine = ctx.getDashboardUrl?.()
    ? `  dash    ${ctx.getDashboardUrl?.()} (open in browser · /dashboard stop)`
    : "";
  const lines = [
    `  model   ${loop.model}`,
    `  flags   harvest=${loop.harvestEnabled ? "on" : "off"} · branch=${branchBudget > 1 ? branchBudget : "off"} · stream=${loop.stream ? "on" : "off"} · effort=${loop.reasoningEffort}`,
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
  // Manual companion to the automatic 60%/80% auto-compact. Re-applies
  // token-aware truncation with a tighter cap (default 4000 tokens per
  // tool result) and rewrites the session file so the shrink persists.
  // Useful when the ctx gauge in StatsPanel goes yellow/red mid-session
  // and the user wants to keep chatting without /forget'ing everything.
  const tight = Number.parseInt(args[0] ?? "", 10);
  const cap = Number.isFinite(tight) && tight >= 100 ? tight : 4000;
  const { healedCount, tokensSaved, charsSaved } = loop.compact(cap);
  if (healedCount === 0) {
    return {
      info: `▸ nothing to compact — no tool result or tool-call args in history exceed ${cap.toLocaleString()} tokens.`,
    };
  }
  return {
    info: `▸ compacted ${healedCount} payload(s) to ${cap.toLocaleString()} tokens each (tool results + tool-call args), saved ${tokensSaved.toLocaleString()} tokens (${charsSaved.toLocaleString()} chars). Session file rewritten.`,
  };
};

const cost: SlashHandler = (args, loop, ctx) => {
  if (args.length > 0) {
    return estimateCost(args.join(" "), loop);
  }
  const t = loop.stats.turns[loop.stats.turns.length - 1];
  if (!t) {
    return { info: "no turn yet — `/cost` shows the most recent turn's token + spend breakdown." };
  }
  if (!ctx.postUsage) {
    return { info: "/cost needs a TUI context (postUsage wired)." };
  }
  const summary = loop.stats.summary();
  const ctxMax = DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS;
  ctx.postUsage({
    turn: t.turn,
    promptTokens: t.usage.promptTokens,
    reasonTokens: 0,
    outputTokens: t.usage.completionTokens,
    promptCap: ctxMax,
    cacheHit: t.cacheHitRatio,
    cost: t.cost,
    sessionCost: summary.totalCostUsd,
  });
  return {};
};

/** /cost <text> — pre-turn estimate. Pairs with /budget for the cost-aware-prompt loop. */
function estimateCost(userText: string, loop: import("../../../../loop.js").CacheFirstLoop) {
  const pricing = DEEPSEEK_PRICING[loop.model];
  if (!pricing) {
    return {
      info: `▸ /cost: no pricing table for model "${loop.model}". Add one to telemetry/stats.ts.`,
    };
  }
  const userTokens = countTokens(userText);
  const breakdown = computeCtxBreakdown(loop);
  const promptTokens =
    breakdown.systemTokens + breakdown.toolsTokens + breakdown.logTokens + userTokens;

  const turns = loop.stats.turns;
  const avgOutput =
    turns.length > 0
      ? Math.round(turns.reduce((s, t) => s + t.usage.completionTokens, 0) / turns.length)
      : 800;
  const cacheHit = loop.stats.summary().cacheHitRatio;

  const inputUsdMiss = (promptTokens * pricing.inputCacheMiss) / 1_000_000;
  const inputUsdLikely =
    (promptTokens * ((1 - cacheHit) * pricing.inputCacheMiss + cacheHit * pricing.inputCacheHit)) /
    1_000_000;
  const outputUsd = (avgOutput * pricing.output) / 1_000_000;

  const fmt = (n: number) => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(4)}`;
  const lines = [
    `▸ /cost estimate · ${loop.model} · ${promptTokens.toLocaleString()} prompt tokens` +
      ` (sys ${compactNum(breakdown.systemTokens)} + tools ${compactNum(breakdown.toolsTokens)}` +
      ` + log ${compactNum(breakdown.logTokens)} + msg ${compactNum(userTokens)})`,
    `  worst case (full miss): ${fmt(inputUsdMiss)} input + ~${fmt(outputUsd)} output (${avgOutput.toLocaleString()} avg) ≈ ${fmt(inputUsdMiss + outputUsd)}`,
    turns.length > 0
      ? `  likely (${Math.round(cacheHit * 100)}% session cache hit): ${fmt(inputUsdLikely)} input + ~${fmt(outputUsd)} output ≈ ${fmt(inputUsdLikely + outputUsd)}`
      : "  likely: matches worst case until cache fills (no completed turns yet)",
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
