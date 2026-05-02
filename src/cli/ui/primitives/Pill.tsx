/** Bg-tinted inline chip — section labels (REASONING / TASK / TOOL) and badges (model / path). */

import { Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";

export interface PillProps {
  label: string;
  bg: string;
  fg: string;
  bold?: boolean;
}

export function Pill({ label, bg, fg, bold = true }: PillProps): React.ReactElement {
  return <Text backgroundColor={bg} color={fg} bold={bold}>{` ${label} `}</Text>;
}

/** Section pill bg tints — muted accent-of-card-tone, paired with the tone's fg. */
export const PILL_SECTION = {
  reason: { bg: "#2a1f3d", fg: "#d2a8ff" },
  output: { bg: "#0d1d2e", fg: "#79c0ff" },
  tool: { bg: "#0f2230", fg: "#79c0ff" },
  shell: { bg: "#0f2230", fg: "#79c0ff" },
  task: { bg: "#0d1d2e", fg: "#79c0ff" },
  taskDone: { bg: "#102815", fg: "#7ee787" },
  taskFailed: { bg: "#2c1416", fg: "#ff8b81" },
  plan: { bg: "#2a1f3d", fg: "#d2a8ff" },
  user: { bg: "#11141a", fg: "#8b949e" },
} as const;

/** Model pill — neutral bg, color signals model class. */
export const PILL_MODEL = {
  flash: { bg: "#11141a", fg: "#79c0ff" },
  pro: { bg: "#11141a", fg: "#d2a8ff" },
  r1: { bg: "#11141a", fg: "#b395f5" },
  unknown: { bg: "#11141a", fg: "#8b949e" },
} as const;

export interface ModelBadge {
  label: string;
  kind: keyof typeof PILL_MODEL;
}

/** Map full DeepSeek model id to short label + color class. */
export function modelBadgeFor(model: string | undefined): ModelBadge {
  if (!model) return { label: "?", kind: "unknown" };
  const stripped = model.replace(/^deepseek-/, "");
  if (stripped === "v4-flash" || stripped === "chat") return { label: "v4-flash", kind: "flash" };
  if (stripped === "v4-pro") return { label: "v4-pro", kind: "pro" };
  if (stripped === "r1" || stripped === "reasoner") return { label: "r1", kind: "r1" };
  return { label: stripped, kind: "unknown" };
}
