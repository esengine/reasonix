import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { BarRow } from "../primitives/BarRow.js";
import type { CtxCard as CtxCardData } from "../state/cards.js";
import { FG, TONE } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

const BAR_CELLS = 32;

function row(label: string, tokens: number, ratio: number, color: string): React.ReactElement {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)));
  return (
    <BarRow tone="usage">
      <Text color={FG.sub}>{label.padEnd(8)}</Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color={FG.faint}>{"░".repeat(BAR_CELLS - filled)}</Text>
      <Text bold color={FG.body}>{`  ${tokens.toLocaleString()}`}</Text>
      <Text color={FG.faint}>{`  ${(ratio * 100).toFixed(1)}%`}</Text>
    </BarRow>
  );
}

export function CtxCard({ card }: { card: CtxCardData }): React.ReactElement {
  const cap = Math.max(1, card.ctxMax);
  const used = card.systemTokens + card.toolsTokens + card.logTokens + card.inputTokens;
  const usedPct = (used / cap) * 100;
  const meta = `· ${used.toLocaleString()} / ${cap.toLocaleString()} (${usedPct.toFixed(1)}%)`;

  return (
    <Box flexDirection="column">
      <CardHeader tone="usage" glyph="⌘" title="Context window" meta={meta} />
      <BarRow tone="usage" indent={0} />
      {row("system", card.systemTokens, card.systemTokens / cap, TONE.brand)}
      {row("tools", card.toolsTokens, card.toolsTokens / cap, TONE.warn)}
      {row("log", card.logTokens, card.logTokens / cap, TONE.ok)}
      {row("input", card.inputTokens, card.inputTokens / cap, TONE.accent)}
      {card.topTools.length > 0 && (
        <>
          <BarRow tone="usage" indent={0} />
          <BarRow tone="usage">
            <Text color={FG.faint}>
              {`top tools (${card.toolsCount} total · ${card.logMessages} log msgs):`}
            </Text>
          </BarRow>
          {card.topTools.slice(0, 5).map((t) => (
            <BarRow key={`${t.turn}-${t.name}`} tone="usage">
              <Text color={FG.sub}>{`  ${t.name}`}</Text>
              <Text color={FG.faint}>{`  · turn ${t.turn} · ${t.tokens.toLocaleString()}`}</Text>
            </BarRow>
          ))}
        </>
      )}
    </Box>
  );
}
