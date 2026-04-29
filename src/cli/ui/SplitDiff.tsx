/**
 * Side-by-side diff renderer — git-difftool / delta-style "old | new"
 * layout. Each row shows the same logical position on both sides;
 * removed lines have content on the left only with a red wash, added
 * lines on the right with a green wash, common context appears on
 * both sides dim.
 *
 * Layout:
 *
 *   40   function loginUser(...)        │ 40   function loginUser(...)
 *   41 - if (!email) throw new Error… │ 41 + if (!email || typeof email…
 *                                      │ 42 +   throw new TypeError(…)
 *                                      │ 43 + }
 *   42   return verify(email, …)        │ 44   return verify(email, …)
 *
 * Width is derived from the terminal — half each side minus a 3-cell
 * separator (` │ `). Long lines truncate with `…` rather than wrap,
 * so the row count stays predictable for the parent's height budget.
 */

import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for React.Fragment
import React from "react";
import type { SplitDiffRow } from "../../code/diff-preview.js";
import { COLOR } from "./theme.js";

export interface SplitDiffProps {
  rows: readonly SplitDiffRow[];
  /**
   * Total columns budget. Defaults to terminal width. Modal callers
   * pass a smaller number so the diff fits inside the modal frame.
   */
  totalCols?: number;
}

export function SplitDiff({ rows, totalCols }: SplitDiffProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = totalCols ?? stdout?.columns ?? 80;
  // Reserve ~6 cells for outer border + padding on the modal/log side,
  // 3 cells for the ` │ ` separator. Half the rest per column.
  const innerCols = Math.max(40, cols - 6);
  const halfCols = Math.floor((innerCols - 3) / 2);
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={`r-${i}-${row.left.num ?? "p"}-${row.right.num ?? "p"}`}>
          <Cell side={row.left} width={halfCols} which="left" />
          <Text color={COLOR.info} dimColor>
            {" │ "}
          </Text>
          <Cell side={row.right} width={halfCols} which="right" />
        </Box>
      ))}
    </Box>
  );
}

function Cell({
  side,
  width,
  which,
}: {
  side: SplitDiffRow["left"] | SplitDiffRow["right"];
  width: number;
  which: "left" | "right";
}) {
  const numPad = 4; // up to 9999 lines
  const sgnPad = 1; // single-char sign
  const inner = Math.max(8, width - numPad - sgnPad - 2 /* spaces */);

  const numStr = side.num !== null ? String(side.num).padStart(numPad) : " ".repeat(numPad);
  const sign =
    side.kind === "del" ? "-" : side.kind === "add" ? "+" : side.kind === "pad" ? " " : " ";
  const raw = side.text;
  const truncated = raw.length > inner ? `${raw.slice(0, inner - 1)}…` : raw;
  // Pad to fixed width so the bg color stretches across the whole
  // column even when the text is short — without this the red/green
  // wash would only cover the actual chars and the rest of the row
  // would be terminal default, which looks broken.
  const padded = truncated.padEnd(inner);

  if (side.kind === "del") {
    return (
      <Text color="#fbc8c8" backgroundColor="#2a1212">
        {`${numStr} ${sign} ${padded}`}
      </Text>
    );
  }
  if (side.kind === "add") {
    return (
      <Text color="#bef0c8" backgroundColor="#0c2718">
        {`${numStr} ${sign} ${padded}`}
      </Text>
    );
  }
  if (side.kind === "pad") {
    // Empty side — mute everything, no bg, no glyph. The "… more
    // lines" capRows marker also rides this kind on the left side
    // when present, so we render its text dim italic.
    return (
      <Text color={COLOR.info} dimColor italic={!!raw}>
        {`${numStr} ${sign} ${padded}`}
      </Text>
    );
  }
  // ctx: same content both sides, dim
  return <Text dimColor>{`${numStr} ${sign} ${padded}`}</Text>;
}
