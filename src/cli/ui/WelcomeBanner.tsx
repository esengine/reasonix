/** Empty-session welcome card — sharp ASCII box + tagline + 4 starter slash commands. */

import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { stringWidth } from "../../frame/width.js";
import { t } from "../../i18n/index.js";
import { FG, TONE } from "./theme/tokens.js";

export interface WelcomeBannerProps {
  /** True when running `reasonix code`. Surfaces code-mode hints. */
  inCodeMode?: boolean;
  /** Live URL of the embedded dashboard, or null when it isn't running. */
  dashboardUrl?: string | null;
  /** Bumped on language change; forces re-render so t() picks up new locale. */
  languageVersion?: number;
}

const HINTS = ["/help", "/init", "/memory", "/cost"] as const;
const BOX_INNER_WIDTH = 35;

export function WelcomeBanner({
  inCodeMode,
  dashboardUrl,
}: WelcomeBannerProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const tagline = inCodeMode ? t("ui.taglineCode") : t("ui.taglineChat");
  const taglineSub = t("ui.taglineSub");
  const boxWidth = BOX_INNER_WIDTH + 2;
  const boxIndent = Math.max(2, Math.floor((cols - boxWidth) / 2));
  const pad = " ".repeat(boxIndent);

  const emptyRow = `║${" ".repeat(BOX_INNER_WIDTH)}║`;
  const rows: Array<{ text: string; color?: string; bold?: boolean }> = [
    { text: `╔${"═".repeat(BOX_INNER_WIDTH)}╗`, color: TONE.brand },
    { text: emptyRow, color: TONE.brand },
    { text: `║${centerInside("◈  REASONIX", BOX_INNER_WIDTH)}║`, color: TONE.brand, bold: true },
    { text: emptyRow, color: TONE.brand },
    { text: `║${centerInside(tagline, BOX_INNER_WIDTH)}║`, color: TONE.brand },
    { text: `║${centerInside(taglineSub, BOX_INNER_WIDTH)}║`, color: TONE.brand },
    { text: emptyRow, color: TONE.brand },
    { text: `╚${"═".repeat(BOX_INNER_WIDTH)}╝`, color: TONE.brand },
  ];

  const hintsRow = HINTS.join("   ·   ");
  const hintsIndent = Math.max(2, Math.floor((cols - stringWidth(hintsRow)) / 2));
  const startTextRaw = t("ui.startSessionHint");
  const startIndent = Math.max(2, Math.floor((cols - stringWidth(startTextRaw)) / 2));

  return (
    <Box flexDirection="column" marginY={1}>
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reordered
        <Text key={i} color={row.color} bold={row.bold}>
          {`${pad}${row.text}`}
        </Text>
      ))}

      <Text color={FG.sub}>
        {" ".repeat(startIndent)}
        {startTextRaw}
      </Text>

      <Box marginTop={1}>
        <Text>{" ".repeat(hintsIndent)}</Text>
        {HINTS.map((cmd, i) => (
          <React.Fragment key={cmd}>
            <Text color={FG.meta}>{cmd}</Text>
            {i < HINTS.length - 1 && <Text color={FG.faint}>{"   ·   "}</Text>}
          </React.Fragment>
        ))}
      </Box>

      {dashboardUrl ? (
        <Box marginTop={1} flexDirection="row" justifyContent="center">
          <Text color={TONE.brand} bold>
            {"▸ web · "}
          </Text>
          <Text color={TONE.accent}>{dashboardUrl}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function centerInside(text: string, pad: number): string {
  const w = stringWidth(text);
  if (w >= pad) return text;
  const left = Math.floor((pad - w) / 2);
  const right = pad - w - left;
  return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}
