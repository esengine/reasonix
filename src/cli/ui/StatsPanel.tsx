import { Box, Text } from "ink";
import React from "react";
import { DEEPSEEK_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS } from "../../telemetry.js";
import type { SessionSummary } from "../../telemetry.js";
import { VERSION } from "../../version.js";

export interface StatsPanelProps {
  summary: SessionSummary;
  model: string;
  prefixHash: string;
  harvestOn?: boolean;
  branchBudget?: number;
  /**
   * True when `reasonix code` is currently running in read-only Plan
   * Mode. Surfaced as a red "PLAN" tag in the panel header so the user
   * can tell at a glance that edits are gated behind submit_plan +
   * approval.
   */
  planMode?: boolean;
  /**
   * Account balance fetched once at launch (and optionally refreshed
   * per-turn by the TUI). `null` or absent hides the balance cell
   * entirely — /user/balance failed or the user ran with `--no-config`.
   * The top-up warning fires below 1.0 unit of whatever currency
   * the endpoint reports so a Chinese user with CNY and a U.S. user
   * with USD both see "getting low."
   */
  balance?: { currency: string; total: number } | null;
  /**
   * Published npm version newer than VERSION. Rendered as a yellow
   * "· update: X" nudge in the panel header. `null` / `undefined`
   * hides the nudge (offline launch, already up to date, or check
   * still in flight).
   */
  updateAvailable?: string | null;
}

export function StatsPanel({
  summary,
  model,
  prefixHash,
  harvestOn,
  branchBudget,
  planMode,
  balance,
  updateAvailable,
}: StatsPanelProps) {
  const hitPct = (summary.cacheHitRatio * 100).toFixed(1);
  const hitColor =
    summary.cacheHitRatio >= 0.7 ? "green" : summary.cacheHitRatio >= 0.4 ? "yellow" : "red";
  const branchOn = (branchBudget ?? 1) > 1;

  const ctxMax = DEEPSEEK_CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT_TOKENS;
  const ctxRatio = summary.lastPromptTokens / ctxMax;
  const ctxColor = ctxRatio >= 0.8 ? "red" : ctxRatio >= 0.5 ? "yellow" : undefined;

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color="cyan" bold>
            Reasonix
          </Text>
          <Text dimColor>{` v${VERSION}`}</Text>
          <Text dimColor> · model </Text>
          <Text color="yellow">{model}</Text>
          <Text dimColor> · prefix </Text>
          <Text dimColor>{prefixHash}</Text>
          {harvestOn ? <Text color="magenta"> · harvest</Text> : null}
          {branchOn ? <Text color="blue"> · branch{branchBudget}</Text> : null}
          {planMode ? (
            <Text color="red" bold>
              {" "}
              · PLAN
            </Text>
          ) : null}
        </Text>
        <Text>
          {updateAvailable ? (
            <Text color="yellow" bold>{`update: ${updateAvailable} · `}</Text>
          ) : null}
          <Text dimColor>turns {summary.turns} · type /help</Text>
        </Text>
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
          <Text color="green" bold>
            ${summary.totalCostUsd.toFixed(6)}
          </Text>
          <Text dimColor>
            {" (in "}${summary.totalInputCostUsd.toFixed(6)}
            {" · out "}${summary.totalOutputCostUsd.toFixed(6)}
            {")"}
          </Text>
        </Text>
        {summary.lastPromptTokens > 0 ? (
          <Text>
            <Text dimColor>ctx </Text>
            <Text color={ctxColor} bold={ctxColor !== undefined}>
              {formatTokens(summary.lastPromptTokens)}/{formatTokens(ctxMax)}
            </Text>
            <Text dimColor> ({(ctxRatio * 100).toFixed(0)}%)</Text>
            {ctxRatio >= 0.8 ? (
              <Text color="red" bold>
                {" "}
                · /compact
              </Text>
            ) : null}
          </Text>
        ) : null}
        {balance ? (
          <Text>
            <Text dimColor>balance </Text>
            <Text color={balance.total < 1 ? "red" : balance.total < 5 ? "yellow" : "green"} bold>
              {balance.currency === "USD" ? "$" : ""}
              {balance.total.toFixed(2)}
              {balance.currency !== "USD" ? ` ${balance.currency}` : ""}
            </Text>
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

/**
 * Compact integer formatter: 1234 → "1.2k", 131072 → "131k". Keeps the
 * panel narrow enough to fit on 80-col terminals even when the context
 * is near full.
 */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 100 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
}
