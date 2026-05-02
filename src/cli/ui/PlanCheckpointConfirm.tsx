/** Modal picker for `PlanCheckpointError`: continue / revise / stop. */

import { Box } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import type { PlanStep } from "../../tools/plan.js";
import { PlanStepList, type StepStatus } from "./PlanStepList.js";
import { SingleSelect } from "./Select.js";
import { ApprovalCard } from "./cards/ApprovalCard.js";
import { useReserveRows } from "./layout/viewport-budget.js";

export type CheckpointChoice = "continue" | "revise" | "stop";

export interface PlanCheckpointConfirmProps {
  stepId: string;
  title?: string;
  completed: number;
  total: number;
  /** Full step list from the approved plan, when available. */
  steps?: PlanStep[];
  /** Set of stepIds the model has marked complete so far. */
  completedStepIds?: Set<string>;
  onChoose: (choice: CheckpointChoice) => void;
}

function PlanCheckpointConfirmInner({
  stepId,
  title,
  completed,
  total,
  steps,
  completedStepIds,
  onChoose,
}: PlanCheckpointConfirmProps) {
  const stepRows = steps?.length ?? 0;
  useReserveRows("modal", { min: 10, max: Math.max(14, stepRows + 12) });

  const label = title ? `${stepId} · ${title}` : stepId;
  const counter = total > 0 ? `${completed}/${total}` : "";
  const isLast = total > 0 && completed >= total;
  const statuses = buildStatusMap(steps, completedStepIds, stepId, isLast);
  const subtitle = counter ? `${counter}  ·  ${label}` : label;
  return (
    <ApprovalCard tone="ok" glyph="⛁" title="Checkpoint — step done" metaRight={subtitle}>
      {steps && steps.length > 0 ? (
        <Box marginBottom={1} flexDirection="column">
          <PlanStepList steps={steps} statuses={statuses} focusStepId={stepId} />
        </Box>
      ) : null}
      <SingleSelect
        initialValue={isLast ? "stop" : "continue"}
        items={[
          {
            value: "continue",
            label: "Continue — run the next step",
            hint: "Model resumes with the next step.",
          },
          {
            value: "revise",
            label: "Revise — give feedback before the next step",
            hint: "Stay paused, type guidance; model adjusts the remaining plan.",
          },
          {
            value: "stop",
            label: "Stop — end the plan here",
            hint: "Model summarizes what was done and ends.",
          },
        ]}
        onSubmit={(v) => onChoose(v as CheckpointChoice)}
        onCancel={() => onChoose("stop")}
      />
    </ApprovalCard>
  );
}

export const PlanCheckpointConfirm = React.memo(PlanCheckpointConfirmInner);

/** Current step renders as "done" — flush order isn't guaranteed at picker time. */
function buildStatusMap(
  steps: PlanStep[] | undefined,
  completedStepIds: Set<string> | undefined,
  currentStepId: string,
  isLast: boolean,
): Map<string, StepStatus> {
  const map = new Map<string, StepStatus>();
  if (!steps) return map;
  for (const step of steps) {
    if (completedStepIds?.has(step.id) || step.id === currentStepId) {
      map.set(step.id, "done");
    } else {
      map.set(step.id, "pending");
    }
  }
  void isLast;
  return map;
}
