/**
 * Shared Ink block that renders a TypedPlanState. Used by the live chat
 * EventLog AND by the RecordView in replay/diff TUIs, so harvest output
 * looks identical live and on replay.
 *
 * Colors are semantic (not decorative):
 *   - subgoals:       cyan         — structure / plan
 *   - hypotheses:     green        — current beliefs (like assistant)
 *   - uncertainties:  yellow       — attention required (like tool)
 *   - rejected paths: red dim      — ruled out (muted, like error-but-resolved)
 *
 * Only the label is colored + bold. The items themselves render in the
 * terminal's default foreground, so they stay readable on any background —
 * which is why the old single-magenta block was hard to see on dark themes.
 */

import { Box, Text } from "ink";
import React from "react";
import type { TypedPlanState } from "../../harvest.js";

type FieldColor = "cyan" | "green" | "yellow" | "red";

export function PlanStateBlock({ planState }: { planState: TypedPlanState }) {
  const fields: Array<[string, string[], FieldColor, boolean]> = [];
  if (planState.subgoals.length) fields.push(["subgoals", planState.subgoals, "cyan", false]);
  if (planState.hypotheses.length)
    fields.push(["hypotheses", planState.hypotheses, "green", false]);
  if (planState.uncertainties.length)
    fields.push(["uncertainties", planState.uncertainties, "yellow", false]);
  if (planState.rejectedPaths.length)
    fields.push(["rejected", planState.rejectedPaths, "red", true]);
  if (fields.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {fields.map(([label, items, color, dim]) => (
        <Text key={label}>
          <Text color={color} bold dimColor={dim}>
            {"‹ "}
            {label}
          </Text>
          <Text dimColor>{` (${items.length})`}</Text>
          <Text>{`: ${items.join(" · ")}`}</Text>
        </Text>
      ))}
    </Box>
  );
}
