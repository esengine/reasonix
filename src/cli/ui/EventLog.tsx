import { Box, Text } from "ink";
import React from "react";
import { type TypedPlanState, isPlanStateEmpty } from "../../harvest.js";
import type { BranchProgress, BranchSummary } from "../../loop.js";
import type { TurnStats } from "../../telemetry.js";
import { Markdown } from "./markdown.js";

export type DisplayRole = "user" | "assistant" | "tool" | "system" | "error" | "info";

export interface DisplayEvent {
  id: string;
  role: DisplayRole;
  text: string;
  reasoning?: string;
  planState?: TypedPlanState;
  branch?: BranchSummary;
  branchProgress?: BranchProgress;
  toolName?: string;
  stats?: TurnStats;
  repair?: string;
  streaming?: boolean;
}

export const EventRow = React.memo(function EventRow({ event }: { event: DisplayEvent }) {
  if (event.role === "user") {
    return (
      <Box>
        <Text bold color="cyan">
          you ›{" "}
        </Text>
        <Text>{event.text}</Text>
      </Box>
    );
  }
  if (event.role === "assistant") {
    if (event.streaming) return <StreamingAssistant event={event} />;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold color="green">
            assistant
          </Text>
        </Box>
        {event.branch ? <BranchBlock branch={event.branch} /> : null}
        {event.reasoning ? <ReasoningBlock reasoning={event.reasoning} /> : null}
        {!isPlanStateEmpty(event.planState) ? (
          <PlanStateBlock planState={event.planState!} />
        ) : null}
        {event.text ? <Markdown text={event.text} /> : <Text dimColor>(no content)</Text>}
        {event.stats ? <StatsLine stats={event.stats} /> : null}
        {event.repair ? <Text color="magenta">{event.repair}</Text> : null}
      </Box>
    );
  }
  if (event.role === "tool") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">{`tool<${event.toolName ?? "?"}>  →`}</Text>
        <Text dimColor> {truncate(event.text, 400)}</Text>
      </Box>
    );
  }
  if (event.role === "error") {
    return (
      <Box marginTop={1}>
        <Text color="red" bold>
          error{" "}
        </Text>
        <Text color="red">{event.text}</Text>
      </Box>
    );
  }
  if (event.role === "info") {
    return (
      <Box>
        <Text dimColor>{event.text}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text>{event.text}</Text>
    </Box>
  );
});

function BranchBlock({ branch }: { branch: BranchSummary }) {
  const per = branch.uncertainties
    .map((u, i) => {
      const marker = i === branch.chosenIndex ? "▸" : " ";
      const t = (branch.temperatures[i] ?? 0).toFixed(1);
      return `${marker} #${i} T=${t} u=${u}`;
    })
    .join("  ");
  return (
    <Box>
      <Text color="blue">
        {"🔀 branched "}
        <Text bold>{branch.budget}</Text>
        {` samples → picked #${branch.chosenIndex}   `}
        <Text dimColor>{per}</Text>
      </Text>
    </Box>
  );
}

function PlanStateBlock({ planState }: { planState: TypedPlanState }) {
  const lines: Array<[string, string[]]> = [];
  if (planState.subgoals.length) lines.push(["subgoals", planState.subgoals]);
  if (planState.hypotheses.length) lines.push(["hypotheses", planState.hypotheses]);
  if (planState.uncertainties.length) lines.push(["uncertainties", planState.uncertainties]);
  if (planState.rejectedPaths.length) lines.push(["rejected", planState.rejectedPaths]);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map(([label, items]) => (
        <Text key={label} color="magenta">
          {"‹ "}
          <Text bold>{label}</Text>
          {` (${items.length}): ${items.join(" · ")}`}
        </Text>
      ))}
    </Box>
  );
}

function ReasoningBlock({ reasoning }: { reasoning: string }) {
  const max = 220;
  const flat = reasoning.replace(/\s+/g, " ").trim();
  const preview =
    flat.length <= max ? flat : `${flat.slice(0, max)}… (+${flat.length - max} chars)`;
  return (
    <Box marginBottom={1}>
      <Text dimColor italic>
        {"↳ thinking: "}
        {preview}
      </Text>
    </Box>
  );
}

/**
 * Compact progress view rendered while a turn is still streaming. We keep
 * this to a fixed ~3-line footprint so the dynamic region never scrolls past
 * the terminal viewport and leaves artifacts in scrollback.
 */
function StreamingAssistant({ event }: { event: DisplayEvent }) {
  if (event.branchProgress) {
    const p = event.branchProgress;
    const pct = Math.round((p.completed / p.total) * 100);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold color="green">
            assistant{" "}
          </Text>
          <Text color="blue">
            🔀 branching {p.completed}/{p.total} ({pct}%)
          </Text>
        </Box>
        <Text dimColor>
          {"  latest #"}
          {p.latestIndex}
          {" T="}
          {p.latestTemperature.toFixed(1)}
          {" u="}
          {p.latestUncertainties}
          {p.completed < p.total ? "  · waiting for other samples…" : "  · selecting winner…"}
        </Text>
      </Box>
    );
  }

  const tail = lastLine(event.text, 140);
  const reasoningTail = event.reasoning ? lastLine(event.reasoning, 120) : "";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color="green">
          assistant{" "}
        </Text>
        <Text dimColor>
          (streaming · {event.text.length}
          {event.reasoning ? ` + think ${event.reasoning.length}` : ""} chars)
        </Text>
      </Box>
      {reasoningTail ? (
        <Text dimColor italic>
          ↳ thinking: {reasoningTail}
        </Text>
      ) : null}
      {tail ? (
        <Text dimColor>▸ {tail}</Text>
      ) : (
        <Text dimColor italic>
          {"  (waiting for first token…)"}
        </Text>
      )}
    </Box>
  );
}

function lastLine(s: string, maxChars: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= maxChars ? flat : `…${flat.slice(-maxChars)}`;
}

function StatsLine({ stats }: { stats: TurnStats }) {
  const hit = (stats.cacheHitRatio * 100).toFixed(1);
  return (
    <Text dimColor>
      {"  ↳ cache "}
      {hit}
      {"% · tokens "}
      {stats.usage.promptTokens}
      {"→"}
      {stats.usage.completionTokens}
      {" · $"}
      {stats.cost.toFixed(6)}
    </Text>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} chars)`;
}
