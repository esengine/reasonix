import { Box, Text } from "ink";
import React from "react";
import { ModalCard } from "./ModalCard.js";
import { SingleSelect } from "./Select.js";
import { COLOR } from "./theme.js";

export type WorkspaceConfirmChoice = "switch" | "deny";

export interface WorkspaceConfirmProps {
  /** Resolved absolute path the model wants to switch to. */
  path: string;
  /** Current session root, shown above the target so the user sees the diff. */
  currentRoot: string;
  /** Number of MCP servers still attached — surfaced so the user knows
   * those won't follow the switch (their child processes were spawned
   * with the original cwd). 0 means no warning. */
  mcpServerCount: number;
  onChoose: (choice: WorkspaceConfirmChoice, denyContext?: string) => void;
}

/**
 * Modal-style approval for a `change_workspace` tool call. Two
 * choices, Enter / Esc bindings. No "always allow" — workspace
 * switches are per-target by nature.
 *
 * The "Deny" item supports inline context: pressing Tab appends `,`
 * and lets the user type a reason directly on the selected item. The
 * context is returned as the second argument to `onChoose`.
 */
export function WorkspaceConfirm({
  path,
  currentRoot,
  mcpServerCount,
  onChoose,
}: WorkspaceConfirmProps) {
  const subtitle =
    mcpServerCount > 0
      ? `MCP servers (${mcpServerCount}) stay anchored to the original launch root.`
      : "Re-registers filesystem / shell / memory tools at the new path.";

  return (
    <ModalCard accent={COLOR.warn} icon="⇄" title="switch workspace" subtitle={subtitle}>
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text dimColor>{"from  "}</Text>
          <Text color={COLOR.info}>{currentRoot}</Text>
        </Box>
        <Box>
          <Text dimColor>{"to    "}</Text>
          <Text color={COLOR.primary} bold>
            {path}
          </Text>
        </Box>
      </Box>
      <SingleSelect
        initialValue="switch"
        items={[
          {
            value: "switch",
            label: "Switch",
            hint: "Re-register filesystem / shell / memory tools against the new root.",
          },
          {
            value: "deny",
            label: "Deny",
            hint: "Tell the model why you're refusing; it will continue without changing directories.",
            denyWithContext: true,
          },
        ]}
        onSubmit={(v, ctx) => onChoose(v as WorkspaceConfirmChoice, ctx)}
        onCancel={() => onChoose("deny")}
        footer="[↑↓] navigate  ·  [Enter] select  ·  [Tab] add context  ·  [Esc] deny"
      />
    </ModalCard>
  );
}
