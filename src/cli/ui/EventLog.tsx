import { Box, Text } from "ink";
import React from "react";
import type { TurnStats } from "../../telemetry.js";

export type DisplayRole = "user" | "assistant" | "tool" | "system" | "error" | "info";

export interface DisplayEvent {
  id: string;
  role: DisplayRole;
  text: string;
  toolName?: string;
  stats?: TurnStats;
  repair?: string;
  streaming?: boolean;
}

export interface EventLogProps {
  events: DisplayEvent[];
  max?: number;
}

export function EventLog({ events, max = 40 }: EventLogProps) {
  const visible = events.slice(-max);
  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((ev) => (
        <EventRow key={ev.id} event={ev} />
      ))}
    </Box>
  );
}

function EventRow({ event }: { event: DisplayEvent }) {
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
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold color="green">
            assistant{" "}
          </Text>
          {event.streaming ? <Text dimColor>(streaming…)</Text> : null}
        </Box>
        <Text>{event.text || <Text dimColor>(no content)</Text>}</Text>
        {event.stats ? <StatsLine stats={event.stats} /> : null}
        {event.repair ? <Text color="magenta"> {event.repair}</Text> : null}
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
