import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig.jsx = "react" needs React in value scope for JSX compilation
import React from "react";
import type { SlashCommandSpec } from "./slash.js";

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
 * Floating slash-command panel. Rendered below the input box when
 * the user is typing a `/…` prefix. Navigation state lives in the
 * parent (App.tsx owns `slashSelected`) so ↑/↓/Tab/Enter stay
 * consistent with the useInput handler. This component is pure
 * display: `matches` and `selectedIndex` come in, rows go out.
 */
export function SlashSuggestions({
  matches,
  selectedIndex,
}: SlashSuggestionsProps): React.ReactElement | null {
  if (matches === null) return null;
  if (matches.length === 0) {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text color="yellow">no slash command matches that prefix</Text>
        <Text dimColor> — Backspace to edit, or /help for the full list</Text>
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
      {hiddenAbove > 0 ? <Text dimColor> ↑ {hiddenAbove} more above</Text> : null}
      {shown.map((spec, i) => (
        <SuggestionRow key={spec.cmd} spec={spec} isSelected={windowStart + i === selectedIndex} />
      ))}
      {hiddenBelow > 0 ? <Text dimColor> ↓ {hiddenBelow} more below</Text> : null}
      <Text dimColor> [↑↓] navigate · [Tab]/[Enter] pick</Text>
    </Box>
  );
}

function SuggestionRow({ spec, isSelected }: { spec: SlashCommandSpec; isSelected: boolean }) {
  const marker = isSelected ? "▸" : " ";
  const name = `/${spec.cmd}`;
  const argsSuffix = spec.argsHint ? ` ${spec.argsHint}` : "";
  // Selected row gets full cyan coloring so it pops out against the
  // dimmed others — mirrors the style GitHub Issues / Discord use
  // for focused dropdown rows.
  if (isSelected) {
    return (
      <Box>
        <Text bold color="cyan">
          {marker} {name.padEnd(12)}
          {argsSuffix.padEnd(16)}
        </Text>
        <Text color="cyan"> {spec.summary}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text dimColor>
        {marker} {name.padEnd(12)}
        {argsSuffix.padEnd(16)} {spec.summary}
      </Text>
    </Box>
  );
}
