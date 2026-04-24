import { Box, Text, useInput, useStdout } from "ink";
import React, { useMemo, useState } from "react";
import { formatEditBlockDiff } from "../../code/diff-preview.js";
import type { EditBlock } from "../../code/edit-blocks.js";

/**
 * Choice surfaced to the interceptor when the user resolves the modal:
 *   - `apply`                → apply this edit, keep prompting on next.
 *   - `reject`               → tell the model the user refused; do NOT
 *                              retry the same edit.
 *   - `apply-rest-of-turn`   → apply this edit AND every remaining edit
 *                              this turn without further prompts. Resets
 *                              at the next user turn.
 *   - `flip-to-auto`         → apply this edit + persistently switch the
 *                              session to AUTO mode (survives restart).
 */
export type EditReviewChoice = "apply" | "reject" | "apply-rest-of-turn" | "flip-to-auto";

export interface EditConfirmProps {
  block: EditBlock;
  onChoose: (choice: EditReviewChoice) => void;
}

/**
 * Overhead reserved for non-diff UI inside the modal: border (2),
 * title (1), separator (1), file-header (1), scroll-indicator rows
 * (up to 2), footer + margin (3), plus breathing room for the host
 * TUI's chrome above (stats panel ≈ 4, historical live rows, prompt
 * input ≈ 2). 18 rows absorbed before the diff gets any budget.
 */
const MODAL_OVERHEAD_ROWS = 18;

/**
 * Absolute floor on the diff viewport. If the terminal is absurdly
 * short (< 26 rows total) we still show at least 8 diff lines so the
 * modal is usable; the user scrolls more aggressively but can't end up
 * with a zero-height viewport.
 */
const MIN_DIFF_ROWS = 8;

/**
 * Modal-style approval for a single model-proposed file edit.
 *
 * Why per-edit instead of end-of-turn batch: users reported they can't
 * tell if the model is about to make one small change or seven sprawling
 * ones until the turn is over. Per-edit prompts let the user intervene
 * early — reject a bad direction before the model builds on it, or
 * approve the first few and hit `a` to let the rest land.
 *
 * Diff viewport: we compute the UNCAPPED diff once, then slice to a
 * height budget derived from terminal rows. Large diffs (100+ lines)
 * are scrollable via j/k/↑/↓/Space/PgUp/PgDn/g/G — the user can page
 * through the whole change before deciding, and the action footer
 * never scrolls off the bottom. Before the scroll support a 97-line
 * scene.ts diff truncated at "… 67 more …" which was unreviewable.
 */
export function EditConfirm({ block, onChoose }: EditConfirmProps) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 40;
  const budget = Math.max(MIN_DIFF_ROWS, rows - MODAL_OVERHEAD_ROWS);

  // Full diff — maxLines pushed high enough that the diff-preview
  // renderer never inserts its own truncation marker. Context trimming
  // (contextLines) still applies for tight scan.
  const allLines = useMemo(
    () => formatEditBlockDiff(block, { contextLines: 2, maxLines: 100_000, indent: "  " }),
    [block],
  );

  const [scroll, setScroll] = useState(0);
  const maxScroll = Math.max(0, allLines.length - budget);
  // Clamp scroll if budget shrinks (terminal resized) after a previous
  // keypress drove the offset past the new ceiling.
  const effectiveScroll = Math.min(scroll, maxScroll);

  useInput((input, key) => {
    // Action keys first — decision wins over scroll so a user who
    // hammered PgDn can still hit `y` at the end without a stray
    // extra scroll.
    if (key.return || input === "y") {
      onChoose("apply");
      return;
    }
    if (input === "n") {
      onChoose("reject");
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
    // Scroll navigation — vim-ish (j/k) and emacs-ish (arrows) both
    // work. Space for "next page" is the pager convention.
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
    // Esc falls through to the parent abort handler.
  });

  const isNew = block.search === "";
  const removed = isNew ? 0 : (block.search.match(/\n/g)?.length ?? 0) + 1;
  const added = block.replace === "" ? 0 : (block.replace.match(/\n/g)?.length ?? 0) + 1;
  const tag = isNew ? "NEW" : "EDIT";

  const visibleLines = allLines.slice(effectiveScroll, effectiveScroll + budget);
  const hiddenAbove = effectiveScroll;
  const hiddenBelow = Math.max(0, allLines.length - effectiveScroll - budget);
  const totalLines = allLines.length;
  const showScrollHud = hiddenAbove + hiddenBelow > 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Box>
        <Text bold color="cyan">
          {"▸ model wants to edit a file"}
        </Text>
      </Box>
      <Box>
        <Text color="cyan" dimColor>
          {"──────────────────────────────────────────"}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color={isNew ? "green" : "yellow"} bold>{`[${tag}] `}</Text>
          <Text color="cyan">{block.path}</Text>
          <Text dimColor>{`  (-${removed} +${added} lines)`}</Text>
          {showScrollHud ? (
            <Text dimColor>
              {`  ·  viewing ${effectiveScroll + 1}-${effectiveScroll + visibleLines.length}/${totalLines}`}
            </Text>
          ) : null}
        </Text>
      </Box>
      {hiddenAbove > 0 ? (
        <Text dimColor>{`  ↑ ${hiddenAbove} line${hiddenAbove === 1 ? "" : "s"} above  (↑/k or PgUp)`}</Text>
      ) : null}
      <Box marginTop={hiddenAbove > 0 ? 0 : 1} flexDirection="column">
        {visibleLines.map((line, i) => {
          const trimmed = line.trimStart();
          const color =
            trimmed.startsWith("+") ? "green" : trimmed.startsWith("-") ? "red" : undefined;
          const dim = !color;
          return (
            <Text
              // Stable-enough: slice only shifts by scroll; React keys only
              // need to be unique within the current render.
              // biome-ignore lint/suspicious/noArrayIndexKey: list is static per render
              key={`diff-${effectiveScroll}-${i}`}
              color={color}
              dimColor={dim}
            >
              {line}
            </Text>
          );
        })}
      </Box>
      {hiddenBelow > 0 ? (
        <Text dimColor>{`  ↓ ${hiddenBelow} line${hiddenBelow === 1 ? "" : "s"} below  (↓/j or Space/PgDn)`}</Text>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>
          {"["}
          <Text color="cyan" bold>
            y
          </Text>
          {"/Enter] apply  ·  ["}
          <Text color="cyan" bold>
            n
          </Text>
          {"] reject  ·  ["}
          <Text color="cyan" bold>
            a
          </Text>
          {"] apply rest  ·  ["}
          <Text color="cyan" bold>
            A
          </Text>
          {"] flip AUTO  ·  ["}
          <Text color="cyan" bold>
            ↑↓/Space
          </Text>
          {"] scroll  ·  [Esc] abort"}
        </Text>
      </Box>
    </Box>
  );
}
