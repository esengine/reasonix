/** Modal-style picker for `submit_plan`: accept / refine / cancel. */

import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import type { PlanStep } from "../../tools/plan.js";
import { PlanStepList } from "./PlanStepList.js";
import { SingleSelect } from "./Select.js";
import { ApprovalCard } from "./cards/ApprovalCard.js";
import { useReserveRows } from "./layout/viewport-budget.js";
import { CARD, TONE } from "./theme/tokens.js";

export type PlanConfirmChoice = "approve" | "refine" | "revise" | "cancel";

export interface PlanConfirmProps {
  plan: string;
  steps?: PlanStep[];
  /** Optional human-friendly title from the model — surfaced in the header. */
  summary?: string;
  onChoose: (choice: PlanConfirmChoice) => void;
  projectRoot?: string;
}

function PlanConfirmInner({ plan, steps, onChoose }: PlanConfirmProps) {
  const stepRows = steps?.length ?? 0;
  useReserveRows("modal", { min: 10, max: Math.max(16, stepRows + 14) });

  const hasOpenQuestions =
    /^#{1,6}\s*(open[-\s]?questions?|risks?|unknowns?|assumptions?|unclear)/im.test(plan) ||
    /^#{1,6}\s*(待确认|开放问题|风险|未知|假设|不确定)/im.test(plan);

  return (
    <ApprovalCard
      tone="accent"
      glyph="⊞"
      title="Approve plan"
      metaRight="awaiting"
      metaRightColor={CARD.plan.color}
    >
      {hasOpenQuestions ? (
        <Box marginBottom={1}>
          <Text color={TONE.warn}>
            ▲ the plan flags open questions or risks — pick <Text bold>refine</Text> to write
            concrete answers before the model moves on.
          </Text>
        </Box>
      ) : null}
      {steps && steps.length > 0 ? (
        <Box marginBottom={1} flexDirection="column">
          <PlanStepList steps={steps} />
        </Box>
      ) : null}
      <SingleSelect
        initialValue={hasOpenQuestions ? "refine" : "approve"}
        items={[
          {
            value: "approve",
            label: "accept",
            hint: "run it now, in order",
          },
          {
            value: "refine",
            label: "refine",
            hint: "give the agent more guidance, draft a new plan",
          },
          {
            value: "revise",
            label: "revise",
            hint: "edit the plan inline before running (skip / reorder steps)",
          },
          {
            value: "cancel",
            label: "reject",
            hint: "discard, agent will retry from scratch",
          },
        ]}
        onSubmit={(v) => onChoose(v as PlanConfirmChoice)}
        onCancel={() => onChoose("cancel")}
      />
    </ApprovalCard>
  );
}

/** Memoized — parent re-renders every tick; props only change on user action. */
export const PlanConfirm = React.memo(PlanConfirmInner);
