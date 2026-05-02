import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React, { useState } from "react";
import { DenyContextInput } from "./DenyContextInput.js";
import { SingleSelect } from "./Select.js";
import { ApprovalCard } from "./cards/ApprovalCard.js";
import { useReserveRows } from "./layout/viewport-budget.js";
import { FG, TONE } from "./theme/tokens.js";

export type ShellConfirmChoice = "run_once" | "always_allow" | "deny";

export interface ShellConfirmProps {
  command: string;
  /** Prefix that would be persisted if the user picks "always allow". */
  allowPrefix: string;
  /** `run_background` returns early; `run_command` blocks the TUI. */
  kind?: "run_command" | "run_background";
  onChoose: (choice: ShellConfirmChoice, denyContext?: string) => void;
}

export function ShellConfirm({ command, allowPrefix, kind, onChoose }: ShellConfirmProps) {
  useReserveRows("modal", { min: 8, max: 14 });

  const isBackground = kind === "run_background";
  const subtitle = isBackground
    ? "long-running process — keeps running after approval, /kill to stop"
    : "model wants to run a shell command";

  const [phase, setPhase] = useState<"pick" | "deny">("pick");

  if (phase === "deny") {
    return (
      <ApprovalCard
        tone="error"
        glyph="✗"
        title="Deny — provide context"
        metaRight="optional"
        footerHint="⏎ submit  ·  esc skip (deny without reason)"
      >
        <DenyContextInput
          onSubmit={(context) => onChoose("deny", context || undefined)}
          onCancel={() => onChoose("deny")}
        />
      </ApprovalCard>
    );
  }

  return (
    <ApprovalCard
      tone="warn"
      glyph={isBackground ? "⏱" : "?"}
      title={isBackground ? "Background process" : "Shell command"}
      metaRight="awaiting"
      footerHint="↑↓ pick  ·  ⏎ confirm  ·  esc cancel"
    >
      <Box marginBottom={1}>
        <Text color={FG.faint}>{subtitle}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold color={TONE.err}>
          {"$ "}
        </Text>
        <Text bold color={FG.strong}>
          {command}
        </Text>
      </Box>
      <SingleSelect
        initialValue="run_once"
        items={[
          {
            value: "run_once",
            label: "allow once",
            hint: "run this command, ask again next time",
          },
          {
            value: "always_allow",
            label: "allow always",
            hint: `remember \`${allowPrefix}\` for this project`,
          },
          {
            value: "deny",
            label: "deny",
            hint: "skip; agent will pick an alternative",
          },
        ]}
        onSubmit={(v) => {
          if (v === "deny") setPhase("deny");
          else onChoose(v as ShellConfirmChoice);
        }}
        onCancel={() => onChoose("deny")}
      />
    </ApprovalCard>
  );
}

/** First two tokens for known wrappers (`npm install`, `git commit`, …); else first token only. */
export function derivePrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  if (tokens.length === 1) return tokens[0]!;
  const first = tokens[0]!;
  const TWO_TOKEN_WRAPPERS = new Set([
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "bun",
    "git",
    "cargo",
    "go",
    "docker",
    "kubectl",
    "python",
    "python3",
    "deno",
    "pip",
    "pip3",
    "make",
    "rake",
    "bundle",
    "gem",
  ]);
  return TWO_TOKEN_WRAPPERS.has(first) ? `${first} ${tokens[1]}` : first;
}
