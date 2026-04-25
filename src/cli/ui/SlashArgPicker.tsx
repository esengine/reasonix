import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig.jsx = "react" needs React in value scope for JSX compilation
import React from "react";
import type { SlashCommandSpec } from "./slash.js";

export interface SlashArgPickerProps {
  /**
   * When set, render a picker with these matches (filter already
   * applied upstream). Null → not in picker mode; check `hintSpec`
   * for a usage hint instead.
   */
  matches: readonly string[] | null;
  /** Highlighted row within `matches`. */
  selectedIndex: number;
  /**
   * Spec of the command the user is typing args for. Used to render
   * the header label ("/edit <file>") even when matches is empty or
   * the caller wants a hint instead of a picker.
   */
  spec: SlashCommandSpec;
  /** What kind of arg guidance to render. */
  kind: "picker" | "hint";
  /** The user's partial input — shown in the "no matches" hint. */
  partial: string;
}

/**
 * Argument-level picker for a slash command. Mirrors the visual
 * layout of SlashSuggestions / AtMentionSuggestions so the UI stays
 * consistent across all three picker surfaces.
 */
export function SlashArgPicker({
  matches,
  selectedIndex,
  spec,
  kind,
  partial,
}: SlashArgPickerProps): React.ReactElement | null {
  // Hint mode: a single dim row explaining the argsHint + summary.
  if (kind === "hint") {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          {"  "}
          <Text bold>/{spec.cmd}</Text>
          {spec.argsHint ? ` ${spec.argsHint}` : ""} — {spec.summary}
        </Text>
      </Box>
    );
  }

  if (matches === null) return null;
  if (matches.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text dimColor>
          {"  "}
          <Text bold>/{spec.cmd}</Text>
          {spec.argsHint ? ` ${spec.argsHint}` : ""} — {spec.summary}
        </Text>
        <Text color="yellow"> no match for "{partial}" — keep typing, or Backspace to edit</Text>
      </Box>
    );
  }

  const MAX = 8;
  const total = matches.length;
  const windowStart =
    total <= MAX ? 0 : Math.max(0, Math.min(selectedIndex - Math.floor(MAX / 2), total - MAX));
  const shown = matches.slice(windowStart, windowStart + MAX);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowStart - shown.length;
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text dimColor>
        {"  "}
        <Text bold>/{spec.cmd}</Text>
        {spec.argsHint ? ` ${spec.argsHint}` : ""} — {spec.summary}
      </Text>
      {hiddenAbove > 0 ? <Text dimColor> ↑ {hiddenAbove} more above</Text> : null}
      {shown.map((value, i) => (
        <ArgRow key={value} value={value} isSelected={windowStart + i === selectedIndex} />
      ))}
      {hiddenBelow > 0 ? <Text dimColor> ↓ {hiddenBelow} more below</Text> : null}
      <Text dimColor> [↑↓] navigate · [Tab]/[Enter] pick</Text>
    </Box>
  );
}

function ArgRow({ value, isSelected }: { value: string; isSelected: boolean }) {
  const marker = isSelected ? "▸" : " ";
  if (isSelected) {
    return (
      <Box>
        <Text bold color="cyan">
          {marker} {value}
        </Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text dimColor>
        {marker} {value}
      </Text>
    </Box>
  );
}
