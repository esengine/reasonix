import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { type TypedPlanState, isPlanStateEmpty } from "../../harvest.js";
import type { BranchProgress, BranchSummary } from "../../loop.js";
import type { TurnStats } from "../../telemetry.js";
import { PlanStateBlock } from "./PlanStateBlock.js";
import { Markdown } from "./markdown.js";

export type DisplayRole = "user" | "assistant" | "tool" | "system" | "error" | "info" | "warning";

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
    // `flattenMcpResult` prefixes server-side errors with "ERROR: ".
    // Render those in red with a ✗ marker so they don't blend into
    // successful tool output (yellow) — the failure mode is what the
    // model most likely needs to act on next, and the user needs to
    // see at a glance.
    const isError = event.text.startsWith("ERROR:");
    const color = isError ? "red" : "yellow";
    const marker = isError ? "✗" : "→";
    // `edit_file` results get a dedicated diff renderer — colored
    // line-by-line so `-` removals show red, `+` additions show
    // green, unchanged context lines dim. Always full, never
    // truncated: users need to see the whole change to trust
    // /apply. Other tools keep the 400-char clip + /tool N escape.
    const isEditFile =
      (event.toolName === "edit_file" || event.toolName?.endsWith("_edit_file")) && !isError;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={color}>{`tool<${event.toolName ?? "?"}>  ${marker}`}</Text>
        {isEditFile ? (
          <EditFileDiff text={event.text} />
        ) : (
          <Text color={isError ? "red" : undefined} dimColor={!isError}>
            {" "}
            {truncate(event.text, 400)}
          </Text>
        )}
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
  if (event.role === "warning") {
    return (
      <Box>
        <Text color="yellow">▸ </Text>
        <Text color="yellow">{event.text}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text>{event.text}</Text>
    </Box>
  );
});

/**
 * Render the payload of an `edit_file` tool result with proper
 * diff coloring: first line is the header ("edited X (A→B chars)"),
 * subsequent lines are prefixed with `-` (removed), `+` (added), or
 * space (unchanged context). Unchanged lines render dim so the
 * changed ones pop visually. No truncation — the whole diff is
 * shown so the user can audit what landed before `/apply` or
 * `git diff` review.
 */
function EditFileDiff({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  // Line 0 is the status header ("edited X (A→B chars)"), Line 1 is
  // the unified-diff hunk header ("@@ -N,M +N,M @@"), the rest is
  // the colored diff body. We style the two headers distinctly so
  // the hunk marker stands out the way git-diff's cyan `@@` does in
  // most terminals.
  const [statusHeader, hunkHeader, ...body] = lines;
  return (
    <Box flexDirection="column">
      <Text dimColor>{` ${statusHeader ?? ""}`}</Text>
      {hunkHeader !== undefined ? (
        <Text color="cyan" bold>
          {hunkHeader}
        </Text>
      ) : null}
      {body.map((line, i) => {
        // Key includes the line content slice so React isn't forced
        // to treat purely-positional identity; lines in the same
        // diff don't reorder but could repeat (e.g. blank lines).
        const key = `${i}-${line.slice(0, 32)}`;
        if (line.startsWith("- ")) {
          return (
            <Text key={key} color="red">
              {line}
            </Text>
          );
        }
        if (line.startsWith("+ ")) {
          return (
            <Text key={key} color="green">
              {line}
            </Text>
          );
        }
        // Context line (starts with "  ") or unknown — dim.
        return (
          <Text key={key} dimColor>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

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

function ReasoningBlock({ reasoning }: { reasoning: string }) {
  const max = 260;
  const flat = reasoning.replace(/\s+/g, " ").trim();
  // Show the TAIL of the reasoning rather than the head. R1 opens
  // with generic scaffolding ("let me look at the structure...") that
  // repeats across turns and hides the part users actually want to
  // see — the decision right before the model commits to an action.
  // Users can dump the full reasoning with `/think` if needed.
  const preview =
    flat.length <= max ? flat : `… (+${flat.length - max} earlier chars) ${flat.slice(-max)}`;
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
function Elapsed() {
  const [s, setS] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setS(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return <Text dimColor>{`${mm}:${ss}`}</Text>;
}

function StreamingAssistant({ event }: { event: DisplayEvent }) {
  if (event.branchProgress) {
    const p = event.branchProgress;
    // completed=0 means we've just started; no sample has finished yet.
    if (p.completed === 0) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color="green">
              assistant{" "}
            </Text>
            <Text color="blue">
              🔀 launching {p.total} parallel samples (R1 thinking in parallel)…{" "}
            </Text>
            <Elapsed />
          </Box>
          <Text dimColor>{"  "}spread across T=0.0/0.5/1.0 · typical wait 30-90s for reasoner</Text>
        </Box>
      );
    }
    const pct = Math.round((p.completed / p.total) * 100);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold color="green">
            assistant{" "}
          </Text>
          <Text color="blue">
            🔀 branching {p.completed}/{p.total} ({pct}%){" "}
          </Text>
          <Elapsed />
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
  // Four distinct phases a turn can be in — label them plainly so
  // the user doesn't have to decode "streaming · 391 + think 4506
  // chars" to figure out what's happening:
  //   pre-first-byte: request in flight, no bytes back yet
  //   reasoning-only: R1 thinking, no visible content yet
  //   writing: content streaming (R1 has already produced its thought)
  //   both: rare — content present AND reasoning still growing
  // We can't cheaply distinguish "reasoning still growing" from
  // "reasoning finished but we already saw it", so when content is
  // present we just say "writing response" and surface both counts.
  const preFirstByte = !event.text && !event.reasoning;
  const reasoningOnly = !event.text && !!event.reasoning;
  let label: string;
  let labelColor: "yellow" | "cyan" | "green" | undefined;
  if (preFirstByte) {
    label = "request sent · waiting for server";
    labelColor = "yellow";
  } else if (reasoningOnly) {
    label = `R1 reasoning · ${event.reasoning?.length ?? 0} chars of thought`;
    labelColor = "cyan";
  } else {
    // Content phase. If reasoning is non-empty we include its size
    // so the user knows R1 did a thinking pass before speaking.
    label = event.reasoning
      ? `writing response · ${event.text.length} chars · after ${event.reasoning.length} chars of reasoning`
      : `writing response · ${event.text.length} chars`;
    labelColor = "green";
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color="green">
          assistant{" "}
        </Text>
        <Pulse />
        <Text color={labelColor}>{` ${label} `}</Text>
        <Elapsed />
      </Box>
      {reasoningTail ? (
        <Text dimColor italic>
          ↳ thinking: {reasoningTail}
        </Text>
      ) : null}
      {tail ? (
        <Text dimColor>▸ {tail}</Text>
      ) : reasoningOnly ? (
        <Text color="yellow" dimColor>
          {
            "  R1 is thinking before it speaks — body text starts when reasoning completes (typically 20-90s)."
          }
        </Text>
      ) : (
        <Text dimColor italic>
          {"  connection open, first byte typically in 5-60s depending on model + load"}
        </Text>
      )}
    </Box>
  );
}

/**
 * Blinking indicator so the user can tell the stream is alive even
 * when the reasoner hasn't produced body text yet. Ticks every 500 ms
 * regardless of content flow — it's a heartbeat, not a progress bar.
 */
function Pulse() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  return <Text color="cyan">{frames[tick % frames.length]}</Text>;
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
