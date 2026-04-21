import { Box, Text } from "ink";
import React from "react";
import type { SessionSummary } from "../../telemetry.js";

export interface StatsPanelProps {
  summary: SessionSummary;
  model: string;
  prefixHash: string;
}

export function StatsPanel({ summary, model, prefixHash }: StatsPanelProps) {
  const hitPct = (summary.cacheHitRatio * 100).toFixed(1);
  const hitColor =
    summary.cacheHitRatio >= 0.7 ? "green" : summary.cacheHitRatio >= 0.4 ? "yellow" : "red";
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color="cyan" bold>
            Reasonix
          </Text>
          <Text dimColor> · model </Text>
          <Text color="yellow">{model}</Text>
          <Text dimColor> · prefix </Text>
          <Text dimColor>{prefixHash}</Text>
        </Text>
        <Text dimColor>turns {summary.turns}</Text>
      </Box>
      <Box marginTop={1} gap={3}>
        <Text>
          <Text dimColor>cache hit </Text>
          <Text color={hitColor} bold>
            {hitPct}%
          </Text>
        </Text>
        <Text>
          <Text dimColor>cost </Text>
          <Text color="green">${summary.totalCostUsd.toFixed(6)}</Text>
        </Text>
        <Text>
          <Text dimColor>vs Claude </Text>
          <Text>${summary.claudeEquivalentUsd.toFixed(6)}</Text>
        </Text>
        <Text>
          <Text dimColor>saving </Text>
          <Text color="green" bold>
            {summary.savingsVsClaudePct.toFixed(1)}%
          </Text>
        </Text>
      </Box>
    </Box>
  );
}
