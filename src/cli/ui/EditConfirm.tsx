import { Box, Text } from "ink";
import React, { useMemo, useState } from "react";
import { formatEditBlockSplit } from "../../code/diff-preview.js";
import type { EditBlock } from "../../code/edit-blocks.js";
import { DenyContextInput } from "./DenyContextInput.js";
import { SplitDiff } from "./SplitDiff.js";
import { ApprovalCard } from "./cards/ApprovalCard.js";
import { useKeystroke } from "./keystroke-context.js";
import { useReserveRows, useTotalRows } from "./layout/viewport-budget.js";

export type EditReviewChoice = "apply" | "reject" | "apply-rest-of-turn" | "flip-to-auto";

export interface EditConfirmProps {
  block: EditBlock;
  onChoose: (choice: EditReviewChoice, denyContext?: string) => void;
}

const MODAL_OVERHEAD_ROWS = 18;
const MIN_DIFF_ROWS = 8;

const REVIEW_FOOTER =
  "[y/Enter] apply  ·  [n] reject with reason  ·  [a] apply rest  ·  [A] flip AUTO  ·  [↑↓/Space] scroll  ·  [Esc] abort";

export function EditConfirm({ block, onChoose }: EditConfirmProps) {
  const rows = useTotalRows();
  const allocated = useReserveRows("modal", {
    min: MODAL_OVERHEAD_ROWS + MIN_DIFF_ROWS,
    max: Math.max(MODAL_OVERHEAD_ROWS + MIN_DIFF_ROWS, rows - 4),
  });
  const budget = Math.max(MIN_DIFF_ROWS, allocated - MODAL_OVERHEAD_ROWS);

  const allRows = useMemo(
    () => formatEditBlockSplit(block, { contextLines: 2, maxLines: 100_000 }),
    [block],
  );

  const [scroll, setScroll] = useState(0);
  const maxScroll = Math.max(0, allRows.length - budget);
  const effectiveScroll = Math.min(scroll, maxScroll);

  const [phase, setPhase] = useState<"review" | "context">("review");

  useKeystroke((ev) => {
    if (ev.paste) return;
    if (phase === "context") return;

    const input = ev.input;
    const key = ev;
    if (key.return || input === "y") {
      onChoose("apply");
      return;
    }
    if (input === "n") {
      setPhase("context");
      return;
    }
    if (input === "a") {
      onChoose("apply-rest-of-turn");
      return;
    }
    if (input === "A") {
      onChoose("flip-to-auto");
      return;
    }
    if (key.downArrow || input === "j") {
      setScroll((s) => Math.min(maxScroll, s + 1));
      return;
    }
    if (key.upArrow || input === "k") {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (key.pageDown || input === " " || input === "f") {
      setScroll((s) => Math.min(maxScroll, s + Math.max(1, budget - 2)));
      return;
    }
    if (key.pageUp || input === "b") {
      setScroll((s) => Math.max(0, s - Math.max(1, budget - 2)));
      return;
    }
    if (input === "g") {
      setScroll(0);
      return;
    }
    if (input === "G") {
      setScroll(maxScroll);
      return;
    }
  });

  const isNew = block.search === "";
  const removed = isNew ? 0 : (block.search.match(/\n/g)?.length ?? 0) + 1;
  const added = block.replace === "" ? 0 : (block.replace.match(/\n/g)?.length ?? 0) + 1;
  const tag = isNew ? "NEW" : "EDIT";
  const tone = isNew ? "ok" : "warn";
  const glyph = isNew ? "✚" : "✎";

  const visibleRows = allRows.slice(effectiveScroll, effectiveScroll + budget);
  const hiddenAbove = effectiveScroll;
  const hiddenBelow = Math.max(0, allRows.length - effectiveScroll - budget);
  const totalLines = allRows.length;
  const showScrollHud = hiddenAbove + hiddenBelow > 0;

  const metaParts = [`-${removed} +${added} lines`];
  if (showScrollHud) {
    metaParts.push(
      `viewing ${effectiveScroll + 1}-${effectiveScroll + visibleRows.length}/${totalLines}`,
    );
  }

  if (phase === "context") {
    return (
      <ApprovalCard
        tone="error"
        glyph="✗"
        title="Deny — provide context"
        metaRight="optional"
        footerHint="⏎ submit  ·  esc skip (deny without reason)"
      >
        <DenyContextInput
          onSubmit={(context) => onChoose("reject", context)}
          onCancel={() => setPhase("review")}
        />
      </ApprovalCard>
    );
  }

  return (
    <ApprovalCard
      tone={tone}
      glyph={glyph}
      title={`${tag}  ${block.path}`}
      metaRight={metaParts.join("  ·  ")}
      footerHint={REVIEW_FOOTER}
    >
      {hiddenAbove > 0 ? (
        <Text
          dimColor
        >{`  ↑ ${hiddenAbove} line${hiddenAbove === 1 ? "" : "s"} above  (↑/k or PgUp)`}</Text>
      ) : null}
      <SplitDiff rows={visibleRows} />
      <Box>
        <Text color="#fbc8c8" backgroundColor="#2a1212">
          {"  - old  "}
        </Text>
        <Text>{"  "}</Text>
        <Text color="#bef0c8" backgroundColor="#0c2718">
          {"  + new  "}
        </Text>
        <Text dimColor>
          {"   side-by-side · removed lines on the left, added on the right · paired by offset"}
        </Text>
      </Box>
      {hiddenBelow > 0 ? (
        <Text
          dimColor
        >{`  ↓ ${hiddenBelow} line${hiddenBelow === 1 ? "" : "s"} below  (↓/j or Space/PgDn)`}</Text>
      ) : null}
    </ApprovalCard>
  );
}
