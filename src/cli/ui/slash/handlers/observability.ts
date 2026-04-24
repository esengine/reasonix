import { DEEPSEEK_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS } from "../../../../telemetry.js";
import { countTokens } from "../../../../tokenizer.js";
import type { SlashHandler } from "../dispatch.js";
import { compactNum, formatToolList } from "../helpers.js";

const think: SlashHandler = (_args, loop) => {
  const raw = loop.scratch.reasoning;
  if (!raw || !raw.trim()) {
    return {
      info:
        "no reasoning cached. `/think` shows the full R1 thought for the most recent turn — " +
        "only `deepseek-reasoner` produces it, and only once the turn completes.",
    };
  }
  return { info: `↳ full thinking (${raw.length} chars):\n\n${raw.trim()}` };
};

const tool: SlashHandler = (args, _loop, ctx) => {
  // EventLog truncates tool results at 400 chars for display. When the
  // user wants to check what the model actually read (e.g. to verify
  // it isn't hallucinating a file's contents), they need the full
  // text. `/tool` is the escape hatch.
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
  // Measure each slice of the next request locally so the user can see
  // *where* context is being spent — a much more useful number than
  // the "last turn's total" the gauge shows. Tokenization is lazy so
  // the first /context call carries the data-file load cost (~100ms);
  // subsequent calls are pure compute.
  const systemTokens = countTokens(loop.prefix.system);
  const toolsTokens = countTokens(JSON.stringify(loop.prefix.toolSpecs));
  const entries = loop.log.toMessages();
  let userTokens = 0;
  let assistantTokens = 0;
  let toolResultTokens = 0;
  let toolCallTokens = 0;
  const toolBreakdown: Array<{ name: string; tokens: number; turn: number }> = [];
  let logTurn = 0;
  for (const e of entries) {
    const content = typeof e.content === "string" ? e.content : "";
    if (e.role === "user") {
      userTokens += countTokens(content);
      logTurn += 1;
    } else if (e.role === "assistant") {
      assistantTokens += countTokens(content);
      if (Array.isArray(e.tool_calls) && e.tool_calls.length > 0) {
        toolCallTokens += countTokens(JSON.stringify(e.tool_calls));
      }
    } else if (e.role === "tool") {
      const n = countTokens(content);
      toolResultTokens += n;
      toolBreakdown.push({ name: e.name ?? "?", tokens: n, turn: logTurn });
    }
  }
  const logTokens = userTokens + assistantTokens + toolResultTokens + toolCallTokens;
  const total = systemTokens + toolsTokens + logTokens;
  const ctxMax = DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS;
  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%`.padStart(4) : "  0%");
  const row = (label: string, n: number, note = "") =>
    `  ${label.padEnd(20)}${compactNum(n).padStart(8)} tokens ${pct(n)}${note ? `   ${note}` : ""}`;

  const lines = [
    `Next-request estimate: ~${compactNum(total)} tokens of ${compactNum(ctxMax)} (${Math.round(
      (total / ctxMax) * 100,
    )}% of window)`,
    "",
    row("system prompt", systemTokens),
    row("tool specs", toolsTokens, `(${loop.prefix.toolSpecs.length} tools)`),
    row("log (all turns)", logTokens, `(${entries.length} messages)`),
    `    user                ${compactNum(userTokens).padStart(8)} tokens`,
    `    assistant           ${compactNum(assistantTokens).padStart(8)} tokens`,
    `    tool-call args      ${compactNum(toolCallTokens).padStart(8)} tokens`,
    `    tool results        ${compactNum(toolResultTokens).padStart(8)} tokens`,
  ];

  // Top 5 heaviest tool results — usually where unexpected bloat
  // lives (a big read_file, an unfiltered search_content).
  if (toolBreakdown.length > 0) {
    const top = [...toolBreakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
    lines.push("");
    lines.push(`Top tool results by cost (of ${toolBreakdown.length} total):`);
    for (const t of top) {
      lines.push(
        `    turn ${String(t.turn).padStart(3)}  ${t.name.padEnd(22)} ${compactNum(t.tokens).padStart(8)} tokens`,
      );
    }
  }

  lines.push("");
  lines.push(
    "Count is a local estimate (DeepSeek V3 tokenizer, pure-TS port); server prompt_tokens may add ~3-6% for chat-template role markers.",
  );
  return { info: lines.join("\n") };
};

const status: SlashHandler = (_args, loop, ctx) => {
  const branchBudget = loop.branchOptions.budget ?? 1;
  const ctxMax = DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS;
  const lastPromptTokens = loop.stats.summary().lastPromptTokens;
  const ctxPct = ctxMax > 0 ? Math.round((lastPromptTokens / ctxMax) * 100) : 0;
  const ctxLine =
    lastPromptTokens > 0
      ? `  ctx    ${compactNum(lastPromptTokens)}/${compactNum(ctxMax)} (${ctxPct}%)`
      : "  ctx    no turns yet";
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
    ctx.editMode === "auto"
      ? "  mode    AUTO — edits apply immediately (u to undo within 5s · Shift+Tab to flip)"
      : ctx.editMode === "review"
        ? "  mode    review — edits queue for /apply or y  (Shift+Tab to flip)"
        : "";
  const lines = [
    `  model   ${loop.model}`,
    `  flags   harvest=${loop.harvestEnabled ? "on" : "off"} · branch=${branchBudget > 1 ? branchBudget : "off"} · stream=${loop.stream ? "on" : "off"} · effort=${loop.reasoningEffort}`,
    ctxLine,
    mcpLine,
    sessionLine,
  ];
  if (pendingLine) lines.push(pendingLine);
  if (planLine) lines.push(planLine);
  if (modeLine) lines.push(modeLine);
  return { info: lines.join("\n") };
};

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

export const handlers: Record<string, SlashHandler> = {
  think,
  reasoning: think,
  tool,
  context,
  status,
  compact,
};
