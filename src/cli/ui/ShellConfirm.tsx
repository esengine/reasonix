import { Box, Text } from "ink";
import React from "react";
import { ModalCard } from "./ModalCard.js";
import { SingleSelect } from "./Select.js";
import { COLOR } from "./theme.js";

export type ShellConfirmChoice = "run_once" | "always_allow" | "deny";

export interface ShellConfirmProps {
  command: string;
  /**
   * The prefix that would be persisted if the user picks
   * "always allow". Typically the first 1-2 tokens of `command`.
   */
  allowPrefix: string;
  /**
   * Which tool is asking. `run_background` spawns via JobRegistry and
   * returns early; `run_command` (default) blocks until the process
   * exits. Shown as a hint in the modal so the user knows whether
   * approving will block the TUI or not.
   */
  kind?: "run_command" | "run_background";
  onChoose: (choice: ShellConfirmChoice, denyContext?: string) => void;
}

/**
 * Modal-style approval for a shell command the model wants to run.
 * Three choices:
 *   1. Run once — execute this invocation, prefix NOT remembered.
 *   2. Always allow — persist the prefix to `~/.reasonix/config.json`
 *      under this project so every future invocation with that prefix
 *      auto-runs.
 *   3. Deny — tell the model the user refused.
 * Arrow keys + Enter. No y/n hotkey — too easy to trigger by accident
 * when the user was mid-typing a response.
 *
 * The "Deny" item supports inline context: pressing Tab appends `,`
 * and lets the user type a reason directly on the selected item. The
 * context is returned as the second argument to `onChoose`.
 */
export function ShellConfirm({ command, allowPrefix, kind, onChoose }: ShellConfirmProps) {
  const isBackground = kind === "run_background";
  const subtitle = isBackground
    ? "long-running process — keeps running after approval, /kill to stop"
    : "model wants to run a shell command";

  // Deny item with inline context support (Tab → `, ` + inline typing)
  const denyItem = {
    value: "deny" as const,
    label: "Deny",
    hint: "Not what you wanted? Press Tab to append `,` and tell the model what to do instead.",
    denyWithContext: true as const,
  };

  return (
    <ModalCard
      accent={COLOR.err}
      icon={isBackground ? "⏱" : "⚡"}
      title={isBackground ? "background process" : "shell command"}
      subtitle={subtitle}
    >
      <Box marginBottom={1}>
        <Text color={COLOR.primary} bold>
          {"$ "}
        </Text>
        <Text bold>{command}</Text>
      </Box>
      <SingleSelect
        initialValue="run_once"
        items={[
          {
            value: "run_once",
            label: "Run once",
            hint: "Execute this command, don't remember it.",
          },
          {
            value: "always_allow",
            label: `Always allow "${allowPrefix}" in this project`,
            hint: "Save the prefix to ~/.reasonix/config.json; future matches auto-run.",
          },
          denyItem,
        ]}
        onSubmit={(v, ctx) => {
          if (v === "deny") onChoose("deny", ctx);
          else onChoose(v as ShellConfirmChoice);
        }}
        onCancel={() => onChoose("deny")}
        footer="[↑↓] navigate  ·  [Enter] select  ·  [Tab] add context  ·  [Esc] deny"
      />
    </ModalCard>
  );
}

/**
 * Pick the "always allow" prefix from a full command. Heuristic:
 *   - one-token commands ("ls", "pytest") → the token itself
 *   - multi-token → first two tokens for well-known wrappers
 *     (`npm install`, `git commit`, `cargo add`, `docker run` …)
 *     otherwise just the first token (covers `node <script>` where the
 *     second token is usually a file path specific to this invocation).
 * Exported so tests can pin the heuristic.
 */
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
