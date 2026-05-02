/** Right-side context panel — plan + running tools + usage snapshot. Read-only, no scroll. */

import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import type { Card, PlanStep } from "../state/cards.js";
import { useAgentState } from "../state/provider.js";
import { CARD, FG, TONE, formatCNY } from "../theme/tokens.js";

export const SIDEBAR_WIDTH = 28;
/** Below this terminal width, sidebar refuses to render so the main column has room to breathe. */
export const SIDEBAR_MIN_TOTAL_COLS = 88;

export interface SidebarPanelProps {
  ongoingTool?: { name: string; args?: string } | null;
  subagentActivity?: { task: string; iter: number; phase?: "exploring" | "summarising" } | null;
}

export function SidebarPanel({
  ongoingTool,
  subagentActivity,
}: SidebarPanelProps): React.ReactElement {
  const cards = useAgentState((s) => s.cards);
  const activePlan = findActivePlan(cards);
  const lastUsage = findLastUsage(cards);

  return (
    <Box flexDirection="column" width={SIDEBAR_WIDTH} marginLeft={1} paddingX={1}>
      {activePlan ? <PlanSection card={activePlan} /> : null}
      {ongoingTool || subagentActivity ? (
        <RunningSection tool={ongoingTool} subagent={subagentActivity} />
      ) : null}
      {lastUsage ? <UsageSection card={lastUsage} /> : null}
    </Box>
  );
}

function findActivePlan(cards: ReadonlyArray<Card>) {
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i];
    if (c?.kind === "plan" && c.variant === "active") return c;
  }
  return null;
}

function findLastUsage(cards: ReadonlyArray<Card>) {
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i];
    if (c?.kind === "usage") return c;
  }
  return null;
}

function SectionHeader({ glyph, title, tone }: { glyph: string; title: string; tone: string }) {
  return (
    <Box marginBottom={0}>
      <Text color={tone} bold>{`${glyph} ${title}`}</Text>
    </Box>
  );
}

function Divider() {
  return (
    <Box marginY={0}>
      <Text color={FG.faint}>{"─".repeat(SIDEBAR_WIDTH - 2)}</Text>
    </Box>
  );
}

function PlanSection({ card }: { card: { steps: PlanStep[]; title: string } }) {
  const total = card.steps.length;
  const done = card.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const runningIdx = card.steps.findIndex((s) => s.status === "running");
  // Window of ±5 around the running step keeps long plans glanceable.
  const visible = windowSteps(card.steps, runningIdx, 5);

  return (
    <>
      <SectionHeader
        glyph={CARD.plan.glyph}
        title={`Plan  ${done}/${total}`}
        tone={CARD.plan.color}
      />
      <Divider />
      {visible.kind === "all" ? null : (
        <Text color={FG.faint}>{`(${visible.hidden} earlier hidden)`}</Text>
      )}
      {visible.steps.map((s, i) => (
        <StepRow key={s.id} step={s} index={visible.startIndex + i} />
      ))}
      {visible.kind === "windowed" && visible.hiddenAfter > 0 ? (
        <Text color={FG.faint}>{`(${visible.hiddenAfter} more)`}</Text>
      ) : null}
    </>
  );
}

function StepRow({ step, index }: { step: PlanStep; index: number }) {
  const glyph = STATUS_GLYPH[step.status];
  const color = STATUS_COLOR[step.status];
  const num = `${index + 1}.`;
  const truncated = truncate(step.title, SIDEBAR_WIDTH - 6);
  return (
    <Box>
      <Text color={color}>{glyph}</Text>
      <Text color={step.status === "running" ? FG.strong : FG.sub}>{` ${num} ${truncated}`}</Text>
    </Box>
  );
}

const STATUS_GLYPH: Record<PlanStep["status"], string> = {
  queued: " ",
  running: "▶",
  done: "✓",
  failed: "✗",
  blocked: "!",
  skipped: "s",
};

const STATUS_COLOR: Record<PlanStep["status"], string> = {
  queued: FG.faint,
  running: TONE.brand,
  done: TONE.ok,
  failed: TONE.err,
  blocked: TONE.warn,
  skipped: FG.faint,
};

function RunningSection({
  tool,
  subagent,
}: {
  tool?: { name: string; args?: string } | null;
  subagent?: { task: string; iter: number; phase?: "exploring" | "summarising" } | null;
}) {
  return (
    <>
      <Box marginTop={1}>
        <Text color={TONE.info} bold>
          {"◐ Running"}
        </Text>
      </Box>
      <Divider />
      {tool ? (
        <Box>
          <Text color={CARD.tool.color}>{CARD.tool.glyph}</Text>
          <Text color={FG.body}>{` ${truncate(tool.name, SIDEBAR_WIDTH - 4)}`}</Text>
        </Box>
      ) : null}
      {subagent ? (
        <Box>
          <Text color={CARD.subagent.color}>{CARD.subagent.glyph}</Text>
          <Text color={FG.body}>{` ${truncate(subagent.task, SIDEBAR_WIDTH - 4)}`}</Text>
        </Box>
      ) : null}
    </>
  );
}

function UsageSection({
  card,
}: {
  card: {
    tokens: { prompt: number; reason: number; output: number; promptCap: number };
    cost: number;
  };
}) {
  const totalTok = card.tokens.prompt + card.tokens.reason + card.tokens.output;
  const ctxPct =
    card.tokens.promptCap > 0 ? Math.round((card.tokens.prompt / card.tokens.promptCap) * 100) : 0;
  return (
    <>
      <Box marginTop={1}>
        <Text color={CARD.usage.color} bold>{`${CARD.usage.glyph} Last turn`}</Text>
      </Box>
      <Divider />
      <Box>
        <Text color={FG.body}>{`${formatCNY(card.cost, 4)} · ${formatTok(totalTok)} tok`}</Text>
      </Box>
      {card.tokens.promptCap > 0 ? (
        <Box>
          <Text color={ctxPct > 80 ? TONE.warn : FG.sub}>{`ctx ${ctxPct}% used`}</Text>
        </Box>
      ) : null}
    </>
  );
}

function formatTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

export type WindowResult =
  | { kind: "all"; steps: PlanStep[]; startIndex: 0 }
  | {
      kind: "windowed";
      steps: PlanStep[];
      startIndex: number;
      hidden: number;
      hiddenAfter: number;
    };

/** Show the focus step ± padding; collapse the rest into "(N hidden)" hints. */
export function windowSteps(steps: PlanStep[], focusIdx: number, padding: number): WindowResult {
  if (steps.length <= padding * 2 + 1) {
    return { kind: "all", steps, startIndex: 0 };
  }
  const focus = focusIdx >= 0 ? focusIdx : 0;
  const start = Math.max(0, focus - padding);
  const end = Math.min(steps.length, start + padding * 2 + 1);
  const trimmedStart = Math.max(0, end - (padding * 2 + 1));
  return {
    kind: "windowed",
    steps: steps.slice(trimmedStart, end),
    startIndex: trimmedStart,
    hidden: trimmedStart,
    hiddenAfter: steps.length - end,
  };
}
