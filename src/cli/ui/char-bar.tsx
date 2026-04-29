/**
 * Character-cell progress bar — the visual primitive shared across:
 *   · cache hit ratio in the status bar
 *   · undo banner countdown
 *   · /context token-usage breakdown (stacked variant)
 *   · plan step progress
 *   · MCP progress notifications
 *   · walk-through "block N of M" position
 *
 * Why one helper: in a TUI you can only convey "fraction" by character
 * fill, not by gradient bg. Doing it ad-hoc per call site led to five
 * subtly different bar styles (some used `█/░`, some `■/-`, some
 * inverted bg). Centralizing here means the visual cue is one
 * consistent thing the user reads at-a-glance everywhere.
 *
 * All variants render in 1 row, 1 cell tall. Width defaults to 24
 * which is wide enough for "10% increments are visible to the eye"
 * but narrow enough to fit beside other status info.
 */

import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { COLOR, GLYPH } from "./theme.js";

export interface CharBarProps {
  /** 0–100 (clamped). Negative or NaN → 0; >100 → 100. */
  pct: number;
  /** Cell count. Default 24. Min 4 enforced so the bar is at least readable. */
  width?: number;
  /** Filled-cell color. Defaults to brand cyan. */
  color?: string;
  /** Empty-cell color. Defaults to dim slate. */
  emptyColor?: string;
  /**
   * Whether to render the percentage label after the bar. Off when the
   * caller wants to put its own meta after (e.g. "12 of 30 done").
   */
  showLabel?: boolean;
  /** Optional label override (default: "{pct}%"). */
  label?: string;
}

/**
 * Single-color progress bar. Render shape:
 *   `████████████░░░░░░░░░░░░  50%`
 *
 * Filled section is `█` in `color`, empty section is `░` in
 * `emptyColor`. Label sits in the same row, dim by default.
 */
export function CharBar({
  pct,
  width = 24,
  color = COLOR.primary,
  emptyColor,
  showLabel = true,
  label,
}: CharBarProps): React.ReactElement {
  const total = Math.max(4, width);
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.round((total * clamped) / 100);
  return (
    <Box>
      <Text color={color}>{GLYPH.block.repeat(filled)}</Text>
      <Text color={emptyColor ?? COLOR.info} dimColor>
        {GLYPH.shade1.repeat(total - filled)}
      </Text>
      {showLabel ? <Text dimColor>{`  ${label ?? `${Math.round(clamped)}%`}`}</Text> : null}
    </Box>
  );
}

export interface StackedSegment {
  /** Percent of the total width this segment occupies. 0–100. */
  pct: number;
  color: string;
  /** Optional label (used by legend renderer; not rendered in the bar). */
  label?: string;
}

export interface StackedCharBarProps {
  segments: readonly StackedSegment[];
  width?: number;
  /** Color of the trailing "free / unused" cells. */
  emptyColor?: string;
}

/**
 * Stacked progress bar. Multiple colored segments + a trailing empty
 * region. Rendered left-to-right in segment order; if the segments'
 * pcts sum >100 the trailing empty just becomes 0.
 *
 * Used by `/context` to break down system / tools / log / input
 * occupancy across the prompt budget.
 */
export function StackedCharBar({
  segments,
  width = 32,
  emptyColor,
}: StackedCharBarProps): React.ReactElement {
  const total = Math.max(4, width);
  const cells = segments.map((s) => Math.max(0, Math.round((total * s.pct) / 100)));
  const used = cells.reduce((acc, n) => acc + n, 0);
  const empty = Math.max(0, total - used);
  return (
    <Box>
      {segments.map((seg, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered, fixed-shape
        <Text key={`seg-${i}`} color={seg.color}>
          {GLYPH.block.repeat(cells[i] ?? 0)}
        </Text>
      ))}
      <Text color={emptyColor ?? COLOR.info} dimColor>
        {GLYPH.shade1.repeat(empty)}
      </Text>
    </Box>
  );
}
