import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { clipToCells } from "../../../frame/width.js";
import { useReserveRows } from "../layout/viewport-budget.js";
import { Markdown } from "../markdown.js";
import { BarRow, CursorBlock } from "../primitives/BarRow.js";
import type { StreamingCard as StreamingCardData } from "../state/cards.js";
import { FG, TONE } from "../theme/tokens.js";

const BODY_INDENT_CELLS = 5;

export function StreamingCard({ card }: { card: StreamingCardData }): React.ReactElement {
  // Done cards render via Markdown in <Static>; live frame stays plain
  // text since markdown on partial streamed chunks would jitter.
  if (card.done && !card.aborted) {
    return (
      <Box flexDirection="column" paddingLeft={3}>
        <Markdown text={card.text} />
      </Box>
    );
  }

  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const lineCells = Math.max(20, cols - BODY_INDENT_CELLS - 1);
  const allLines = card.text.length > 0 ? card.text.split("\n") : [""];
  // Stream zone soaks whatever rows the higher-priority modal/plan-card/input
  // didn't claim. Min 4 keeps a "▶ + 3 lines" footer visible even when a modal
  // takes the whole viewport.
  const budget = useReserveRows("stream", { min: 4, max: Number.POSITIVE_INFINITY });
  const reserved = (card.aborted ? 2 : 0) + 1;
  const lineSlots = Math.max(4, budget - reserved);
  const overflows = !card.done && allLines.length > lineSlots;
  const visible = overflows ? allLines.slice(-lineSlots) : allLines;
  const headDropped = overflows ? allLines.length - visible.length : 0;

  return (
    <Box flexDirection="column">
      {card.aborted && (
        <BarRow tone="streaming" glyph="—">
          <Text color={FG.faint} bold>
            — aborted —
          </Text>
          <Text color={TONE.warn}>{"   stopped"}</Text>
        </BarRow>
      )}
      {headDropped > 0 && (
        <BarRow tone="streaming" glyph="▾">
          <Text
            color={FG.faint}
          >{`… ${headDropped} earlier line${headDropped === 1 ? "" : "s"} (will appear in scrollback)`}</Text>
        </BarRow>
      )}
      {visible.map((line, i) => {
        const isLast = i === visible.length - 1;
        const isFirstRendered = !card.aborted && headDropped === 0 && i === 0;
        return (
          <BarRow
            key={`${card.id}:${headDropped + i}`}
            tone="streaming"
            glyph={isFirstRendered ? "▶" : undefined}
          >
            <Text color={card.aborted ? FG.meta : FG.body}>{clipToCells(line, lineCells)}</Text>
            {isLast && !card.done && <CursorBlock />}
          </BarRow>
        );
      })}
      {card.aborted && (
        <BarRow tone="streaming">
          <Text color={FG.faint}>{"[truncated by esc]"}</Text>
        </BarRow>
      )}
    </Box>
  );
}
