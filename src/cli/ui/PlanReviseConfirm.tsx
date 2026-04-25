/**
 * Modal shown when the model proposes a plan revision via
 * `revise_plan`. Renders a step-level diff between the old remaining
 * tail and the new proposed tail:
 *
 *    ●● ✓ step-2 · Wire middleware           (kept, dim)
 *  − ●●● ✗ step-3 · Migrate session cookies  (removed, red)
 *  + ●●  ▶ step-3 · Skip cookie migration    (added, green)
 *  + ●●  ▶ step-4 · Update cookie tests      (added, green)
 *
 * Two buttons: Accept / Reject. Accept replaces the in-memory plan's
 * remaining steps with the new ones; Reject leaves the original plan
 * intact and lets the model continue. The picker's border is amber
 * to distinguish from the green checkpoint picker — revisions are a
 * different decision point, deserve a different visual lane.
 */

import { Box, Text } from "ink";
import React from "react";
import type { PlanStep } from "../../tools/plan.js";
import { SingleSelect } from "./Select.js";

export type ReviseChoice = "accept" | "reject";

export interface PlanReviseConfirmProps {
  reason: string;
  /** Remaining steps from the current plan (before this revision). */
  oldRemaining: PlanStep[];
  /** Remaining steps the model is proposing as a replacement. */
  newRemaining: PlanStep[];
  /** Optional updated plan summary. */
  summary?: string;
  onChoose: (choice: ReviseChoice) => void;
}

interface DiffRow {
  kind: "kept" | "removed" | "added";
  step: PlanStep;
}

function computeDiff(oldSteps: PlanStep[], newSteps: PlanStep[]): DiffRow[] {
  const oldIds = new Set(oldSteps.map((s) => s.id));
  const newIds = new Set(newSteps.map((s) => s.id));
  const rows: DiffRow[] = [];
  // Show removed (in old, not in new) first — preserve original order.
  for (const s of oldSteps) {
    if (!newIds.has(s.id)) rows.push({ kind: "removed", step: s });
  }
  // Then walk new list. Steps in both lists render as kept; new-only as added.
  for (const s of newSteps) {
    rows.push({ kind: oldIds.has(s.id) ? "kept" : "added", step: s });
  }
  return rows;
}

function riskDots(risk: PlanStep["risk"]): {
  dots: string;
  color: "green" | "yellow" | "red" | "gray";
} {
  switch (risk) {
    case "high":
      return { dots: "●●●", color: "red" };
    case "med":
      return { dots: "●● ", color: "yellow" };
    case "low":
      return { dots: "●  ", color: "green" };
    default:
      return { dots: "   ", color: "gray" };
  }
}

function PlanReviseConfirmInner({
  reason,
  oldRemaining,
  newRemaining,
  summary,
  onChoose,
}: PlanReviseConfirmProps) {
  const rows = computeDiff(oldRemaining, newRemaining);
  const removedCount = rows.filter((r) => r.kind === "removed").length;
  const addedCount = rows.filter((r) => r.kind === "added").length;
  const keptCount = rows.filter((r) => r.kind === "kept").length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Box>
        <Text bold color="yellow">
          ✏ plan revision proposed
        </Text>
        <Text dimColor>{`  −${removedCount} +${addedCount} (${keptCount} kept)`}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{reason}</Text>
      </Box>
      {summary ? (
        <Box marginTop={1}>
          <Text dimColor>{`updated summary: ${summary}`}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {rows.map((row) => {
          const risk = riskDots(row.step.risk);
          const prefix = row.kind === "removed" ? "−" : row.kind === "added" ? "+" : " ";
          const prefixColor =
            row.kind === "removed" ? "red" : row.kind === "added" ? "green" : "gray";
          const dim = row.kind === "kept";
          const strike = row.kind === "removed";
          return (
            <Box key={`${row.kind}-${row.step.id}`}>
              <Text color={prefixColor} bold>
                {`${prefix} `}
              </Text>
              <Text color={risk.color} bold dimColor={dim}>
                {risk.dots}
              </Text>
              <Text dimColor={dim} strikethrough={strike}>
                {` ${row.step.id} · ${row.step.title}`}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <SingleSelect
          initialValue="accept"
          items={[
            {
              value: "accept",
              label: "Accept revision — apply the new step list",
              hint: "Replaces the remaining plan with the proposed steps. Done steps are untouched.",
            },
            {
              value: "reject",
              label: "Reject — keep the original plan",
              hint: "Drops the proposal. Model continues with the original remaining steps.",
            },
          ]}
          onSubmit={(v) => onChoose(v as ReviseChoice)}
          onCancel={() => onChoose("reject")}
          footer="[↑↓] navigate  ·  [Enter] select  ·  [Esc] reject"
        />
      </Box>
    </Box>
  );
}

export const PlanReviseConfirm = React.memo(PlanReviseConfirmInner);
