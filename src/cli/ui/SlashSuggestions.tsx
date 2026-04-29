import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig.jsx = "react" needs React in value scope for JSX compilation
import React from "react";
import type { SlashCommandSpec } from "./slash.js";
import { COLOR, GLYPH } from "./theme.js";

export interface SlashSuggestionsProps {
  /**
   * Current matching suggestions, computed by the parent. `null` means
   * "not in slash-prefix mode" — render nothing. Empty array means "in
   * slash mode but no matches" — render the "no matches" hint.
   */
  matches: SlashCommandSpec[] | null;
  /** Index (within `matches`) of the currently highlighted row. */
  selectedIndex: number;
}

/**
 * Slash-command palette. Rendered below the input box while the user
 * is typing a `/…` prefix. Visual grammar matches the design doc's
 * picker style:
 *
 *      / suggestions                                   esc cancel
 *      ▸ /checkpoint   [name]    snapshot the workspace
 *        /restore      <name>    roll back files to a checkpoint
 *        /diff                   cumulative diff vs session start
 *      [↑↓] navigate · [Tab/⏎] pick
 *
 * Cmd tokens render in accent violet (one consistent color for "this
 * is a command"), descriptions in dim info color. The selected row
 * gets a leading ▸ + bold cmd; non-selected rows get a 2-space pad in
 * the same column so the cmd column stays aligned. No solid-bg pill —
 * the bracket-text pattern from the chrome carries through here.
 */
export function SlashSuggestions({
  matches,
  selectedIndex,
}: SlashSuggestionsProps): React.ReactElement | null {
  if (matches === null) return null;
  if (matches.length === 0) {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text color={COLOR.warn} bold>
          {GLYPH.warn}
        </Text>
        <Text> </Text>
        <Text color={COLOR.warn}>no slash command matches that prefix</Text>
        <Text dimColor>{" — Backspace to edit, or /help for the full list"}</Text>
      </Box>
    );
  }
  // Limit rows so the suggestion list never dwarfs the rest of the
  // UI. Keep the currently-selected row in view by sliding the
  // window when the selection is near either edge.
  const MAX = 8;
  const total = matches.length;
  const windowStart =
    total <= MAX ? 0 : Math.max(0, Math.min(selectedIndex - Math.floor(MAX / 2), total - MAX));
  const shown = matches.slice(windowStart, windowStart + MAX);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowStart - shown.length;
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box>
        <Text color={COLOR.accent} bold>
          {"/ "}
        </Text>
        <Text dimColor>{`${total} command${total === 1 ? "" : "s"}`}</Text>
        {hiddenAbove > 0 ? <Text dimColor>{`   ↑ ${hiddenAbove} above`}</Text> : null}
      </Box>
      {shown.map((spec, i) => (
        <SuggestionRow key={spec.cmd} spec={spec} isSelected={windowStart + i === selectedIndex} />
      ))}
      {hiddenBelow > 0 ? <Text dimColor>{`   ↓ ${hiddenBelow} below`}</Text> : null}
      <Box marginTop={0}>
        <Text dimColor>{"  ↑↓ navigate · Tab / ⏎ pick · esc cancel"}</Text>
      </Box>
    </Box>
  );
}

function SuggestionRow({ spec, isSelected }: { spec: SlashCommandSpec; isSelected: boolean }) {
  const name = `/${spec.cmd}`;
  const argsSuffix = spec.argsHint ? spec.argsHint : "";
  return (
    <Box>
      <Text color={isSelected ? COLOR.primary : COLOR.info} bold={isSelected}>
        {isSelected ? `${GLYPH.cur} ` : "  "}
      </Text>
      <Text color={COLOR.accent} bold={isSelected}>
        {name.padEnd(14)}
      </Text>
      <Text dimColor>{argsSuffix.padEnd(14)}</Text>
      <Text>{"  "}</Text>
      <Text color={isSelected ? COLOR.user : COLOR.info} dimColor={!isSelected}>
        {spec.summary}
      </Text>
    </Box>
  );
}
