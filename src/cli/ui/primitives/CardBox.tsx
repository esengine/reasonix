/** Wraps card content in a Box with `▎` rendered as a per-row borderLeft, so wrap continuations of long markdown / output lines still show the accent bar. */

import { Box } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";

const BAR_STYLE = {
  topLeft: " ",
  top: " ",
  topRight: " ",
  right: " ",
  bottomRight: " ",
  bottom: " ",
  bottomLeft: " ",
  left: "▎",
} as const;

export function CardBox({
  color,
  children,
}: {
  color: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box marginLeft={2} flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle={BAR_STYLE}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeft
        borderLeftColor={color}
        flexGrow={1}
      >
        {children}
      </Box>
    </Box>
  );
}
