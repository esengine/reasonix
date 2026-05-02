import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { clipToCells, wrapToCells } from "../../../frame/width.js";
import { CursorBlock } from "../primitives/BarRow.js";
import { CardBox } from "../primitives/CardBox.js";
import { PILL_MODEL, PILL_SECTION, Pill, modelBadgeFor } from "../primitives/Pill.js";
import { Spinner } from "../primitives/Spinner.js";
import type { ReasoningCard as ReasoningCardData } from "../state/cards.js";
import { CARD, FG } from "../theme/tokens.js";

/** Streaming live region stays at this many rows so Ink's eraseLines can't miscount enough to flicker. Full body lands in scrollback once the card settles. */
const STREAMING_PREVIEW_LINES = 4;
/** Settled reasoning collapses to tail-only — once the model is done thinking, the conclusion is the actionable signal; the rest is in the events log via `/reasoning last`. */
const SETTLED_TAIL_LINES = 2;
const HEADER_PAD = 1;
const BODY_PAD = 4;

export function ReasoningCard({
  card,
  expanded,
}: {
  card: ReasoningCardData;
  expanded: boolean;
}): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const lineCells = Math.max(20, cols - BODY_PAD - 4);

  const allLines = card.text.length > 0 ? card.text.split("\n") : [];
  const showBody = expanded && (allLines.length > 0 || card.streaming);
  const barColor = card.streaming ? CARD.reasoning.color : FG.faint;

  return (
    <CardBox color={barColor}>
      <ReasoningHeader card={card} />
      {showBody && (
        <>
          <Box height={1} />
          {card.streaming ? (
            <StreamingPreview card={card} allLines={allLines} lineCells={lineCells} />
          ) : (
            <SettledPreview card={card} allLines={allLines} lineCells={lineCells} />
          )}
        </>
      )}
    </CardBox>
  );
}

function ReasoningHeader({ card }: { card: ReasoningCardData }): React.ReactElement {
  const badge = modelBadgeFor(card.model);
  const mdl = PILL_MODEL[badge.kind];
  const sec = PILL_SECTION.reason;
  const meta = headerMeta(card);
  const duration = headerDuration(card);
  return (
    <Box paddingLeft={HEADER_PAD} flexDirection="row">
      <Pill label="REASONING" bg={sec.bg} fg={sec.fg} />
      <Text>{"  "}</Text>
      <Pill label={badge.label} bg={mdl.bg} fg={mdl.fg} />
      {meta && (
        <>
          <Text>{"  "}</Text>
          <Text color={FG.faint}>{meta}</Text>
        </>
      )}
      <Box flexGrow={1} />
      {card.streaming && !card.aborted && (
        <>
          <Spinner kind="braille" color={CARD.reasoning.color} />
          <Text color={CARD.reasoning.color}>{" thinking…"}</Text>
        </>
      )}
      {duration && <Text color={FG.faint}>{duration}</Text>}
    </Box>
  );
}

function headerMeta(card: ReasoningCardData): string {
  if (card.aborted) return "aborted";
  if (card.streaming) {
    return card.tokens > 0 ? `${card.tokens.toLocaleString()} tok` : "";
  }
  const parts: string[] = [];
  if (card.tokens > 0) parts.push(`${card.tokens.toLocaleString()} tok`);
  if (card.paragraphs > 0) parts.push(`${card.paragraphs} ¶`);
  return parts.join(" · ");
}

function headerDuration(card: ReasoningCardData): string {
  if (card.streaming || !card.endedAt) return "";
  const seconds = Math.max(0, (card.endedAt - card.ts) / 1000);
  return `${seconds.toFixed(1)}s`;
}

interface BodyProps {
  card: ReasoningCardData;
  allLines: string[];
  lineCells: number;
}

function StreamingPreview({ card, allLines, lineCells }: BodyProps): React.ReactElement {
  const visualLines = allLines.flatMap((l) => wrapToCells(l, lineCells));
  const visible = visualLines.slice(-STREAMING_PREVIEW_LINES);
  return <BodyLines card={card} lines={visible} lineCells={lineCells} cursorOnLast />;
}

function SettledPreview({ card, allLines, lineCells }: BodyProps): React.ReactElement {
  const visualLines = allLines.flatMap((l) => wrapToCells(l, lineCells));
  const visible = visualLines.slice(-SETTLED_TAIL_LINES);
  const droppedLines = Math.max(0, visualLines.length - visible.length);
  return (
    <>
      {droppedLines > 0 && <ElisionHint droppedLines={droppedLines} card={card} />}
      <BodyLines card={card} lines={visible} lineCells={lineCells} indexOffset={droppedLines} />
    </>
  );
}

interface BodyLinesProps {
  card: ReasoningCardData;
  lines: string[];
  lineCells: number;
  cursorOnLast?: boolean;
  indexOffset?: number;
}

function BodyLines({
  card,
  lines,
  lineCells,
  cursorOnLast = false,
  indexOffset = 0,
}: BodyLinesProps): React.ReactElement {
  return (
    <>
      {lines.map((line, i) => {
        const isLast = i === lines.length - 1;
        return (
          <Box key={`${card.id}:b:${indexOffset + i}`} paddingLeft={BODY_PAD} flexDirection="row">
            <Text italic color={FG.meta}>
              {clipToCells(line, lineCells)}
            </Text>
            {isLast && cursorOnLast && <CursorBlock />}
          </Box>
        );
      })}
    </>
  );
}

function ElisionHint({
  droppedLines,
  card,
}: {
  droppedLines: number;
  card: ReasoningCardData;
}): React.ReactElement {
  const parts: string[] = [];
  if (card.paragraphs > 1) {
    parts.push(`${card.paragraphs} ¶`);
  } else {
    parts.push(`${droppedLines} line${droppedLines === 1 ? "" : "s"}`);
  }
  if (card.tokens > 0) parts.push(`${card.tokens.toLocaleString()} tok`);
  return (
    <Box paddingLeft={BODY_PAD}>
      <Text color={FG.faint}>{`⋯ ${parts.join(" · ")} above · /reasoning last`}</Text>
    </Box>
  );
}
