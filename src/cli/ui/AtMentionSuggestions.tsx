import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig.jsx = "react" needs React in value scope for JSX compilation
import React from "react";
import { COLOR, GLYPH } from "./theme.js";

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
 * `@`-mention picker. Rendered below the input box while the user is
 * typing an `@…` prefix in code mode. Visual grammar matches the
 * design's file picker:
 *
 *      @ files matching "auth"                              esc
 *      ▸ login.ts          src/auth/
 *        refresh.ts        src/auth/
 *        validators.ts     src/auth/
 *        auth.test.ts      tests/
 *      [↑↓] navigate · Tab / ⏎ insert as @path · file content inlined
 *
 * Basename in primary cyan (the user's eye lands here first), dir
 * suffix in dim info color. No solid-bg pill on the selected row —
 * leading ▸ + bold + brighter color does the same job without the
 * loud bg block. Mirrors {@link SlashSuggestions}.
 */
export function AtMentionSuggestions({
  matches,
  selectedIndex,
  query,
}: AtMentionSuggestionsProps): React.ReactElement | null {
  if (matches === null) return null;
  if (matches.length === 0) {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text color={COLOR.warn} bold>
          {GLYPH.warn}
        </Text>
        <Text> </Text>
        <Text color={COLOR.warn}>{`no files match "@${query}"`}</Text>
        <Text dimColor>{" — keep typing or Backspace; paths resolve from the code root"}</Text>
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
      <Box>
        <Text color={COLOR.primary} bold>
          {"@ "}
        </Text>
        <Text dimColor>
          {query
            ? `${total} match${total === 1 ? "" : "es"} for "${query}"`
            : `${total} file${total === 1 ? "" : "s"}`}
        </Text>
        {hiddenAbove > 0 ? <Text dimColor>{`   ↑ ${hiddenAbove} above`}</Text> : null}
      </Box>
      {shown.map((path, i) => (
        <FileRow key={path} path={path} isSelected={windowStart + i === selectedIndex} />
      ))}
      {hiddenBelow > 0 ? <Text dimColor>{`   ↓ ${hiddenBelow} below`}</Text> : null}
      <Box marginTop={0}>
        <Text dimColor>{"  ↑↓ navigate · Tab / ⏎ insert as @path · esc cancel"}</Text>
      </Box>
    </Box>
  );
}

function FileRow({ path, isSelected }: { path: string; isSelected: boolean }) {
  // Split the path so the basename visually pops — same dropdown
  // affordance as VS Code's Quick Open. Basename in primary cyan
  // (selected: bold), dir suffix in dim info color so the eye lands
  // on the filename first and uses the path only as a disambiguator.
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? `${path.slice(0, slash)}/` : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <Box>
      <Text color={isSelected ? COLOR.primary : COLOR.info} bold={isSelected}>
        {isSelected ? `${GLYPH.cur} ` : "  "}
      </Text>
      <Text color={COLOR.primary} bold={isSelected}>
        {base.padEnd(20)}
      </Text>
      {dir ? <Text dimColor>{`  ${dir}`}</Text> : null}
    </Box>
  );
}
