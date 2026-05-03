import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { BarRow } from "../primitives/BarRow.js";
import type { ErrorCard as ErrorCardData } from "../state/cards.js";
import { CARD, FG } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

const STACK_TAIL = 5;

export function ErrorCard({ card }: { card: ErrorCardData }): React.ReactElement {
  const meta =
    card.retries !== undefined && card.retries > 0
      ? `· ${card.retries} retr${card.retries === 1 ? "y" : "ies"}`
      : undefined;
  const stackLines = card.stack ? card.stack.split("\n") : [];
  const stackTrunc = stackLines.length > STACK_TAIL;
  const stackVisible = stackTrunc ? stackLines.slice(-STACK_TAIL) : stackLines;
  const stackHidden = stackTrunc ? stackLines.length - stackVisible.length : 0;
  const hasStack = stackVisible.length > 0;

  return (
    <Box flexDirection="column">
      <CardHeader tone="error" glyph="✖" title="Error" subtitle={card.title} meta={meta} />
      <BarRow tone="error" indent={0} />
      {card.message.split("\n").map((line, i) => (
        <BarRow key={`${card.id}:msg:${i}`} tone="error">
          <Text color={CARD.error.color}>{line}</Text>
        </BarRow>
      ))}
      {hasStack && (
        <>
          <BarRow tone="error" indent={0} />
          <BarRow tone="error">
            <Text color={FG.meta}>{"stack trace"}</Text>
          </BarRow>
          {stackHidden > 0 && (
            <BarRow tone="error">
              <Text color={FG.faint}>
                {`⋮ ${stackHidden} earlier stack line${stackHidden === 1 ? "" : "s"} hidden`}
              </Text>
            </BarRow>
          )}
          {stackVisible.map((line, i) => (
            <BarRow key={`${card.id}:stk:${stackHidden + i}`} tone="error">
              <Text color={FG.meta}>{line}</Text>
            </BarRow>
          ))}
        </>
      )}
    </Box>
  );
}
