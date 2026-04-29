import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React, { useMemo } from "react";
import stringWidth from "string-width";
import type { CacheFirstLoop } from "../../loop.js";
import type { SessionSummary } from "../../telemetry.js";
import { computeCtxBreakdown } from "./ctx-breakdown.js";
import { Bar, ChromeRule, formatTokens } from "./primitives.js";
import { COLOR } from "./theme.js";

interface CtxFooterProps {
  loop: CacheFirstLoop;
  summary: SessionSummary;
}

const BAR_CELLS = 14;

export function CtxFooter({ loop, summary }: CtxFooterProps): React.ReactElement {
  // Memoize on turn boundary. `summary.turns` is a freshness key — its
  // change forces recomputation when the loop's log appends a new turn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: summary.turns is a freshness key, not a value used in the body
  const data = useMemo(() => computeCtxBreakdown(loop), [loop, summary.turns]);
  const { stdout } = useStdout();
  const cols = (stdout?.columns ?? 80) - 2;

  const total = data.systemTokens + data.toolsTokens + data.logTokens + data.inputTokens;
  const ratio = data.ctxMax > 0 ? Math.min(1, total / data.ctxMax) : 0;
  const pct = Math.round(ratio * 100);
  const severity = pct >= 80 ? COLOR.err : pct >= 60 ? COLOR.warn : COLOR.ok;

  // Always-shown core: label + bar + total + pct + (compact warn when severe)
  const labelStr = "  ctx  ";
  const totalStr = `${formatTokens(total)}/${formatTokens(data.ctxMax)}`;
  const pctStr = ` · ${pct}%`;
  const warnStr = pct >= 80 ? "  ·  /compact" : "";
  const fixedW =
    stringWidth(labelStr) +
    BAR_CELLS +
    1 + // space after bar
    stringWidth(totalStr) +
    stringWidth(pctStr) +
    stringWidth(warnStr);

  // Optional breakdown segments. Greedy fit by priority (drop first → drop last):
  //   input → log → tools → sys. Sys comes off the line LAST because it's
  //   the most stable number; users learn its size and read other segments
  //   relative to it.
  let budget = cols - fixedW;
  const sysSeg = `  ·  sys ${formatTokens(data.systemTokens)}`;
  const toolsSeg = `  ·  tools ${formatTokens(data.toolsTokens)}`;
  const logSeg = `  ·  log ${formatTokens(data.logTokens)}`;
  const inputSeg = data.inputTokens > 0 ? `  ·  input ${formatTokens(data.inputTokens)}` : "";

  const showSys = budget >= stringWidth(sysSeg);
  if (showSys) budget -= stringWidth(sysSeg);
  const showTools = budget >= stringWidth(toolsSeg);
  if (showTools) budget -= stringWidth(toolsSeg);
  const showLog = budget >= stringWidth(logSeg);
  if (showLog) budget -= stringWidth(logSeg);
  const showInput = inputSeg !== "" && budget >= stringWidth(inputSeg);
  if (showInput) budget -= stringWidth(inputSeg);

  return (
    <Box flexDirection="column" paddingX={1}>
      <ChromeRule />
      <Text>
        <Text color={COLOR.info} dimColor>
          {labelStr}
        </Text>
        <Bar ratio={ratio} color={severity} cells={BAR_CELLS} />
        <Text> </Text>
        <Text color={severity} bold>
          {totalStr}
        </Text>
        <Text dimColor>{pctStr}</Text>
        {showSys ? <Text dimColor>{sysSeg}</Text> : null}
        {showTools ? <Text dimColor>{toolsSeg}</Text> : null}
        {showLog ? <Text dimColor>{logSeg}</Text> : null}
        {showInput ? <Text dimColor>{inputSeg}</Text> : null}
        {warnStr ? (
          <Text color={COLOR.err} bold>
            {warnStr}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
