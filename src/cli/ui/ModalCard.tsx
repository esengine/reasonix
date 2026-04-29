/**
 * Shared visual frame for confirmation modals (ChoiceConfirm,
 * PlanConfirm, ShellConfirm, EditConfirm, PlanCheckpointConfirm,
 * PlanReviseConfirm). Renders as a true bordered card matching the
 * design doc — full accent-colored Unicode box around header + body,
 * with a horizontal rule separating the title row from the content
 * area so the modal reads as a discrete interrupt, not just a few
 * spaced lines in the live region.
 *
 * Layout:
 *
 *   ╭───────────────────────────────────────────────╮
 *   │  ICON  TITLE                       subtitle    │
 *   ├───────────────────────────────────────────────┤
 *   │                                                │
 *   │  <children — body of the modal>                │
 *   │                                                │
 *   ╰───────────────────────────────────────────────╯
 *
 * Color drives the accent (border + icon + title) so the user learns
 * to recognize the modal type by glance: violet = choice, cyan = plan,
 * amber = shell, green = edit review, red = budget exhausted.
 *
 * Why Ink `borderStyle="round"` is fine here despite the historical
 * comment about eraseLines miscounts: the modals only render in
 * single-instance positions (they replace the prompt area, never the
 * scrollback), so the frame doesn't get re-painted every tick. The
 * earlier bug class was about animated wide rows wrapping mid-render.
 */

import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope
import React from "react";

export interface ModalCardProps {
  /** Accent color — border + icon + title text. */
  accent: string;
  /** Section title — rendered bold in the accent color. */
  title: string;
  /** Optional dim subtitle next to the title. */
  subtitle?: string;
  /** Optional leading glyph (icon). Rendered in the accent color. */
  icon?: string;
  /**
   * Optional footer slot — renders below a horizontal rule, after the
   * body. Used for action-button rows like `[apply] [discard]` so they
   * sit visually pinned to the bottom of the modal regardless of body
   * scroll height. When absent, the modal ends right after the body.
   */
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function ModalCard({
  accent,
  title,
  subtitle,
  icon,
  footer,
  children,
}: ModalCardProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  // Subtract 4: 2 cells for the left+right border + 2 cells of paddingX.
  // Min 28 keeps the rule visible even on absurdly narrow terminals.
  const innerWidth = Math.min(76, Math.max(28, cols - 6));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginY={1}>
      {/* Header row — icon + bold title in accent color, dim subtitle
          right-aligned. The horizontal rule below it doubles as a
          separator and a visual weight that says "this is the thing
          to read". */}
      <Box>
        {icon ? (
          <>
            <Text color={accent} bold>
              {icon}
            </Text>
            <Text>{"  "}</Text>
          </>
        ) : null}
        <Text color={accent} bold>
          {title}
        </Text>
        {subtitle ? (
          <>
            <Box flexGrow={1} />
            <Text dimColor>{subtitle}</Text>
          </>
        ) : null}
      </Box>
      <Box>
        <Text color={accent} dimColor>
          {"─".repeat(innerWidth)}
        </Text>
      </Box>
      {/* Body — children render with no extra padding so the modal
          body looks like one continuous content area inside the border. */}
      <Box flexDirection="column">{children}</Box>
      {/* Optional footer — divider rule + slot. Lets modals separate
          actions from body without each one re-implementing the rule. */}
      {footer ? (
        <>
          <Box>
            <Text color={accent} dimColor>
              {"─".repeat(innerWidth)}
            </Text>
          </Box>
          <Box flexDirection="column">{footer}</Box>
        </>
      ) : null}
    </Box>
  );
}
