import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig.jsx = "react" needs React in value scope for JSX compilation
import React from "react";

export interface AtMentionSuggestionsProps {
  /**
   * Current matching file paths, ranked by the picker. `null` means
   * "not in @-prefix mode" — render nothing. Empty array means "in @
   * mode but no files match that partial" — render a hint.
   */
  matches: readonly string[] | null;
  /** Index (within `matches`) of the currently highlighted row. */
  selectedIndex: number;
  /** The partial query the user typed after `@`. Shown in the hint row. */
  query: string;
}

/**
 * Floating `@`-mention picker. Rendered below the input box when the
 * user is typing an `@…` prefix in code mode. Navigation state lives
 * in the parent (App.tsx owns `atSelected`) — this component is pure
 * display. Mirrors {@link SlashSuggestions} shape so the keybindings
 * and layout feel identical across the two pickers.
 */
export function AtMentionSuggestions({
  matches,
  selectedIndex,
  query,
}: AtMentionSuggestionsProps): React.ReactElement | null {
  if (matches === null) return null;
  if (matches.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="yellow">no files match "@{query}"</Text>
        <Text dimColor>
          {" "}
          — keep typing, or Backspace to edit. Paths resolve from the code root.
        </Text>
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
    <Box flexDirection="column" paddingX={1}>
      {hiddenAbove > 0 ? <Text dimColor> ↑ {hiddenAbove} more above</Text> : null}
      {shown.map((path, i) => (
        <FileRow key={path} path={path} isSelected={windowStart + i === selectedIndex} />
      ))}
      {hiddenBelow > 0 ? <Text dimColor> ↓ {hiddenBelow} more below</Text> : null}
      <Text dimColor> [↑↓] navigate · [Tab]/[Enter] pick · file content inlined on send</Text>
    </Box>
  );
}

function FileRow({ path, isSelected }: { path: string; isSelected: boolean }) {
  const marker = isSelected ? "▸" : " ";
  // Split the path so the basename visually pops — same dropdown
  // affordance as VS Code's Quick Open.
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? `${path.slice(0, slash)}/` : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  if (isSelected) {
    return (
      <Box>
        <Text bold color="cyan">
          {marker} {base}
        </Text>
        <Text color="cyan">{dir ? `  ${dir}` : ""}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text dimColor>
        {marker} {base}
        {dir ? `  ${dir}` : ""}
      </Text>
    </Box>
  );
}
