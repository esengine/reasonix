import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { clipToCells } from "../../../frame/width.js";
import { BarRow } from "../primitives/BarRow.js";
import { Spinner } from "../primitives/Spinner.js";
import type { ToolCard as ToolCardData } from "../state/cards.js";
import { CARD, FG, TONE } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

const READ_TAIL = 2;
const OTHER_TAIL = 5;
const BODY_INDENT_CELLS = 7;

/** Read-style tools dump file/list bodies — short tail is enough; the model already has the full text in context. */
function tailLinesFor(name: string): number {
  const lower = name.toLowerCase();
  return /(?:^|_)(read|search|list|tree|get|status|diff|fetch|grep)(_|$)/.test(lower) ||
    lower === "job_output"
    ? READ_TAIL
    : OTHER_TAIL;
}

export function ToolCard({ card }: { card: ToolCardData }): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const lineCells = Math.max(20, cols - BODY_INDENT_CELLS - 1);
  const argsLabel = formatArgsSummary(card.args);
  const meta = formatMeta(card);
  const allLines = card.output.length > 0 ? card.output.split("\n") : [];
  const tail = tailLinesFor(card.name);
  const truncated = allLines.length > tail;
  const visible = truncated ? allLines.slice(-tail) : allLines;
  const hidden = truncated ? allLines.length - visible.length : 0;
  const errColor = card.exitCode && card.exitCode !== 0 ? CARD.error.color : FG.sub;
  const showBody = visible.length > 0;

  return (
    <Box flexDirection="column">
      <CardHeader
        tone="tool"
        glyph="▣"
        title={card.name}
        subtitle={argsLabel || undefined}
        meta={meta || undefined}
        inline={!card.done ? <Spinner kind="braille" color={CARD.tool.color} bold /> : undefined}
        trailing={
          card.retry ? (
            <Text color={TONE.warn} bold>{`↻ retry ${card.retry.attempt}/${card.retry.max}`}</Text>
          ) : undefined
        }
      />
      {showBody && (
        <>
          <BarRow tone="tool" indent={0} />
          {hidden > 0 && (
            <BarRow tone="tool">
              <Text color={FG.faint}>
                {`⋮ ${hidden} earlier line${hidden === 1 ? "" : "s"} (use /tool to read full)`}
              </Text>
            </BarRow>
          )}
          {visible.map((line, i) => (
            <BarRow key={`${card.id}:${hidden + i}`} tone="tool">
              <Text color={errColor}>{clipToCells(line, lineCells)}</Text>
            </BarRow>
          ))}
        </>
      )}
    </Box>
  );
}

function formatArgsSummary(args: unknown): string {
  if (typeof args === "string") return args.length > 60 ? `${args.slice(0, 60)}…` : args;
  if (args && typeof args === "object") {
    const keys = Object.keys(args as Record<string, unknown>);
    if (keys.length === 0) return "";
    const first = keys[0]!;
    const value = (args as Record<string, unknown>)[first];
    if (typeof value === "string") {
      const trimmed = value.length > 40 ? `${value.slice(0, 40)}…` : value;
      return keys.length === 1 ? trimmed : `${trimmed}  +${keys.length - 1}`;
    }
    return keys.join(" ");
  }
  return "";
}

function formatMeta(card: ToolCardData): string {
  const parts: string[] = [];
  if (card.elapsedMs > 0) parts.push(`${(card.elapsedMs / 1000).toFixed(2)}s`);
  if (card.aborted) {
    parts.push("aborted");
  } else if (card.done) {
    if (card.exitCode === 0) parts.push("exit 0");
    else if (card.exitCode !== undefined) parts.push(`exit ${card.exitCode}`);
  } else {
    parts.push("running");
  }
  return parts.length > 0 ? `· ${parts.join(" · ")}` : "";
}
