import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { BarRow } from "../primitives/BarRow.js";
import type { TaskCard as TaskCardData, TaskStep } from "../state/cards.js";
import { CARD, FG, TONE } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

const STEP_GLYPH: Record<TaskStep["status"], string> = {
  queued: "○",
  running: "▶",
  done: "✓",
  failed: "✗",
};

const STEP_COLOR: Record<TaskStep["status"], string> = {
  queued: FG.faint,
  running: TONE.brand,
  done: TONE.ok,
  failed: TONE.err,
};

const TASK_COLOR: Record<TaskCardData["status"], string> = {
  running: CARD.task.color,
  done: TONE.ok,
  failed: TONE.err,
};

const TASK_GLYPH: Record<TaskCardData["status"], string> = {
  running: "▶",
  done: "✓",
  failed: "✗",
};

export function TaskCard({ card }: { card: TaskCardData }): React.ReactElement {
  const elapsed = `${(card.elapsedMs / 1000).toFixed(1)}s`;
  const showSteps = card.steps.length > 0;
  return (
    <Box flexDirection="column">
      <CardHeader
        tone="task"
        glyph={TASK_GLYPH[card.status]}
        title={`Step ${card.index} of ${card.total} · ${card.title}`}
        meta={`${elapsed} ·`}
        trailing={<Text color={TASK_COLOR[card.status]}>{card.status}</Text>}
        barColor={TASK_COLOR[card.status]}
      />
      {showSteps && (
        <>
          <BarRow tone="task" indent={0} />
          {card.steps.map((step) => (
            <BarRow key={step.id} tone="task">
              <Text color={STEP_COLOR[step.status]}>{STEP_GLYPH[step.status]}</Text>
              <Text bold color={FG.body}>{`  ${(step.toolName ?? "step").padEnd(7)} `}</Text>
              <Text color={FG.sub}>{step.title}</Text>
              {step.detail && <Text color={FG.faint}>{`  ${step.detail}`}</Text>}
              {step.elapsedMs !== undefined && (
                <Text color={FG.faint}>{`  ${(step.elapsedMs / 1000).toFixed(2)}s`}</Text>
              )}
            </BarRow>
          ))}
        </>
      )}
    </Box>
  );
}
