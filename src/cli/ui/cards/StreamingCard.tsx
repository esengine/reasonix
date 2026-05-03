import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { clipToCells, wrapToCells } from "../../../frame/width.js";
import { useReserveRows } from "../layout/viewport-budget.js";
import { Markdown } from "../markdown.js";
import { CardBox } from "../primitives/CardBox.js";
import { PILL_MODEL, PILL_SECTION, Pill, modelBadgeFor } from "../primitives/Pill.js";
import { Spinner } from "../primitives/Spinner.js";
import type { StreamingCard as StreamingCardData } from "../state/cards.js";
import { CARD, FG, TONE } from "../theme/tokens.js";

const HEADER_PAD = 1;
const BODY_PAD = 4;
/** Streaming live region stays at this many rows so Ink's eraseLines can't miscount enough to flicker. Full body lands in scrollback once the card settles. */
const STREAMING_PREVIEW_LINES = 4;

export function StreamingCard({ card }: { card: StreamingCardData }): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  // Claim before the done-state branch — hook order must stay stable across the done flip.
  useReserveRows("stream", {
    min: STREAMING_PREVIEW_LINES + 1,
    max: STREAMING_PREVIEW_LINES + 2,
  });

  if (card.done && !card.aborted) {
    return (
      <CardBox color={CARD.streaming.color}>
        <Box paddingLeft={BODY_PAD} flexDirection="column">
          <Markdown text={card.text} />
        </Box>
      </CardBox>
    );
  }
  const lineCells = Math.max(20, cols - BODY_PAD - 4);
  const allLines = card.text.length > 0 ? card.text.split("\n") : [""];
  const visualLines = allLines.flatMap((l) => wrapToCells(l, lineCells));
  const visible = visualLines.slice(-STREAMING_PREVIEW_LINES);

  return (
    <CardBox color={card.aborted ? FG.faint : CARD.streaming.color}>
      {!card.aborted && <StreamingHeader card={card} />}
      {card.aborted && (
        <Box paddingLeft={HEADER_PAD} flexDirection="row">
          <Text color={FG.faint} bold>
            — aborted —
          </Text>
          <Text color={TONE.warn}>{"   stopped"}</Text>
        </Box>
      )}
      {visible.map((line, i) => (
        <Box
          key={`${card.id}:${allLines.length - visible.length + i}`}
          paddingLeft={BODY_PAD}
          flexDirection="row"
        >
          <Text color={card.aborted ? FG.meta : FG.body}>{clipToCells(line, lineCells)}</Text>
        </Box>
      ))}
      {card.aborted && (
        <Box paddingLeft={BODY_PAD}>
          <Text color={FG.faint}>{"[truncated by esc]"}</Text>
        </Box>
      )}
    </CardBox>
  );
}

function StreamingHeader({ card }: { card: StreamingCardData }): React.ReactElement {
  const badge = modelBadgeFor(card.model);
  const mdl = PILL_MODEL[badge.kind];
  const sec = PILL_SECTION.output;
  return (
    <Box paddingLeft={HEADER_PAD} flexDirection="row">
      <Pill label="OUTPUT" bg={sec.bg} fg={sec.fg} />
      <Text>{"  "}</Text>
      <Pill label={badge.label} bg={mdl.bg} fg={mdl.fg} />
      <Box flexGrow={1} />
      <Spinner kind="braille" color={CARD.streaming.color} />
      <Text color={CARD.streaming.color}>{" writing…"}</Text>
    </Box>
  );
}
