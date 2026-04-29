import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { type Frame, frameToAnsi } from "../../frame/index.js";

/** Frame → JSX. One Box per row. */
export function renderFrame(f: Frame, keyPrefix: string): React.ReactElement {
  return (
    <>
      {f.rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: row index is the row's identity
        <Box key={`${keyPrefix}/${i}`} height={1} flexShrink={0}>
          <Text>{frameToAnsi({ width: f.width, rows: [row] })}</Text>
        </Box>
      ))}
    </>
  );
}
