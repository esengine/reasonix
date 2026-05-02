/** Modal picker for `ask_choice` — options + optional "type my own" escape hatch. */

// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import type { ChoiceOption } from "../../tools/choice.js";
import { SingleSelect } from "./Select.js";
import { ApprovalCard } from "./cards/ApprovalCard.js";
import { useReserveRows } from "./layout/viewport-budget.js";

export type ChoiceConfirmChoice =
  | { kind: "pick"; optionId: string }
  | { kind: "custom" }
  | { kind: "cancel" };

export interface ChoiceConfirmProps {
  question: string;
  options: ChoiceOption[];
  allowCustom: boolean;
  onChoose: (choice: ChoiceConfirmChoice) => void;
}

const CUSTOM_VALUE = "__custom__";
const CANCEL_VALUE = "__cancel__";

function ChoiceConfirmInner({ question, options, allowCustom, onChoose }: ChoiceConfirmProps) {
  const optionRows = options.length + (allowCustom ? 1 : 0) + 1; // +1 for cancel
  useReserveRows("modal", { min: 6, max: Math.max(10, optionRows + 6) });

  const items: Array<{ value: string; label: string; hint?: string }> = options.map((opt) => ({
    value: opt.id,
    label: `${opt.id} · ${opt.title}`,
    hint: opt.summary,
  }));
  if (allowCustom) {
    items.push({
      value: CUSTOM_VALUE,
      label: "Let me type my own answer",
      hint: "None of the above fits — type a free-form reply. The model reads it verbatim.",
    });
  }
  items.push({
    value: CANCEL_VALUE,
    label: "Cancel — drop the question",
    hint: "Model stops and asks what you want instead.",
  });

  return (
    <ApprovalCard tone="info" title={question} metaRight="awaiting">
      <SingleSelect
        initialValue={options[0]?.id}
        items={items}
        onSubmit={(v) => {
          if (v === CUSTOM_VALUE) onChoose({ kind: "custom" });
          else if (v === CANCEL_VALUE) onChoose({ kind: "cancel" });
          else onChoose({ kind: "pick", optionId: v });
        }}
        onCancel={() => onChoose({ kind: "cancel" })}
      />
    </ApprovalCard>
  );
}

export const ChoiceConfirm = React.memo(ChoiceConfirmInner);
