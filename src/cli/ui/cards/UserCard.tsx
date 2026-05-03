import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { Markdown } from "../markdown.js";
import { CardBox } from "../primitives/CardBox.js";
import type { UserCard as UserCardData } from "../state/cards.js";
import { CARD, FG } from "../theme/tokens.js";
import { formatRelativeTime } from "./time.js";

const HEADER_PAD = 1;
const BODY_PAD = 4;

export function UserCard({ card }: { card: UserCardData }): React.ReactElement {
  return (
    <CardBox color={CARD.user.color}>
      <Box paddingLeft={HEADER_PAD} flexDirection="row">
        <Text color={FG.meta}>◇</Text>
        <Text bold color={FG.sub}>
          {" you"}
        </Text>
        <Text color={FG.faint}>{`  · ${formatRelativeTime(card.ts)}`}</Text>
      </Box>
      <Box paddingLeft={BODY_PAD} flexDirection="column">
        <Markdown text={card.text} />
      </Box>
    </CardBox>
  );
}
