import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import type { CacheFirstLoop } from "../../loop.js";
import { DEEPSEEK_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS } from "../../telemetry.js";
import { countTokens } from "../../tokenizer.js";
import { formatTokens } from "./primitives.js";
import { COLOR } from "./theme.js";

export interface CtxBreakdownData {
  systemTokens: number;
  toolsTokens: number;
  logTokens: number;
  inputTokens: number;
  ctxMax: number;
  toolsCount: number;
  logMessages: number;
  topTools: Array<{ name: string; tokens: number; turn: number }>;
}

/**
 * Walk the loop's prefix + log and tally tokens per category. Cheap
 * after the tokenizer warm-up (~100 ms first call, sub-ms after).
 * Memoize at the call site if used inside a render path.
 */
export function computeCtxBreakdown(loop: CacheFirstLoop): CtxBreakdownData {
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
  const ctxMax = DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS;
  const topTools = [...toolBreakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  return {
    systemTokens,
    toolsTokens,
    logTokens,
    inputTokens: 0,
    ctxMax,
    toolsCount: loop.prefix.toolSpecs.length,
    logMessages: entries.length,
    topTools,
  };
}

/**
 * 4-segment stacked bar with legend + top-tools list. Pushed to
 * scrollback by the `/context` slash; the always-on bottom footer
 * uses its own slim 1-row layout in `CtxFooter`.
 */
export function CtxBreakdownBlock({ data }: { data: CtxBreakdownData }): React.ReactElement {
  const total = data.systemTokens + data.toolsTokens + data.logTokens + data.inputTokens;
  const winPct = data.ctxMax > 0 ? Math.round((total / data.ctxMax) * 100) : 0;
  const barWidth = 48;
  const cellOf = (n: number) => (data.ctxMax > 0 ? Math.round((n / data.ctxMax) * barWidth) : 0);
  const sysCells = cellOf(data.systemTokens);
  const toolsCells = cellOf(data.toolsTokens);
  const logCells = cellOf(data.logTokens);
  const inputCells = cellOf(data.inputTokens);
  const used = sysCells + toolsCells + logCells + inputCells;
  const freeCells = Math.max(0, barWidth - used);
  const sevColor = winPct >= 80 ? COLOR.err : winPct >= 60 ? COLOR.warn : COLOR.ok;

  return (
    <Box
      flexDirection="column"
      marginY={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={COLOR.brand}
      paddingLeft={1}
    >
      <Box>
        <Text color={COLOR.brand} bold>
          ▣ context
        </Text>
        <Text dimColor>{`  ${formatTokens(total)} of ${formatTokens(data.ctxMax)}`}</Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text color={sevColor} bold>
          {`${winPct}%`}
        </Text>
        {winPct >= 80 ? (
          <Text color={COLOR.err} bold>
            {"  ·  /compact"}
          </Text>
        ) : null}
      </Box>
      <Box>
        <Text color={COLOR.brand}>{"█".repeat(sysCells)}</Text>
        <Text color={COLOR.accent}>{"█".repeat(toolsCells)}</Text>
        <Text color={COLOR.primary}>{"█".repeat(logCells)}</Text>
        <Text color={COLOR.tool}>{"█".repeat(inputCells)}</Text>
        <Text color={COLOR.info} dimColor>
          {"░".repeat(freeCells)}
        </Text>
      </Box>
      <Box>
        <Text color={COLOR.brand}>■</Text>
        <Text dimColor>{` system ${formatTokens(data.systemTokens)}`}</Text>
        <Text>{"   "}</Text>
        <Text color={COLOR.accent}>■</Text>
        <Text dimColor>{` tools ${formatTokens(data.toolsTokens)}`}</Text>
        <Text dimColor>{` (${data.toolsCount})`}</Text>
        <Text>{"   "}</Text>
        <Text color={COLOR.primary}>■</Text>
        <Text dimColor>{` log ${formatTokens(data.logTokens)}`}</Text>
        <Text dimColor>{` (${data.logMessages} msg)`}</Text>
        <Text>{"   "}</Text>
        <Text color={COLOR.tool}>■</Text>
        <Text dimColor>{` input ${formatTokens(data.inputTokens)}`}</Text>
      </Box>
      {data.topTools.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{`  top tool results by cost (${data.topTools.length}):`}</Text>
          {data.topTools.map((t) => (
            <Box key={`${t.turn}-${t.name}`}>
              <Text dimColor>{`    turn ${String(t.turn).padStart(3)}  `}</Text>
              <Text color={COLOR.info}>{t.name.padEnd(22)}</Text>
              <Text dimColor>{`  ${formatTokens(t.tokens).padStart(8)}`}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>{"  /compact shrinks oversized tool results · /new wipes log"}</Text>
      </Box>
    </Box>
  );
}
