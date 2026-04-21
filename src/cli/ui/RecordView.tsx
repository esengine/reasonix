/**
 * Shared renderer for a single TranscriptRecord. Used by ReplayApp and
 * DiffApp — both need the same visual grammar (user cyan, assistant green,
 * tool yellow, error red, cache badge colored by threshold) so transcripts
 * look consistent wherever they're displayed.
 *
 * Kept small on purpose: no streaming/branch/planState paths (those are
 * live-chat concerns and never appear in replayed transcripts).
 */

import { Box, Text } from "ink";
import React from "react";
import type { TranscriptRecord } from "../../transcript.js";

export interface RecordViewProps {
  rec: TranscriptRecord;
  /**
   * When rendering side-by-side in diff mode, shorter truncation limits
   * keep long tool results from dominating the pane. Passes through
   * untouched when undefined.
   */
  compact?: boolean;
}

export function RecordView({ rec, compact = false }: RecordViewProps) {
  const toolArgsMax = compact ? 120 : 200;
  const toolContentMax = compact ? 200 : 400;

  if (rec.role === "user") {
    return (
      <Box marginTop={1}>
        <Text bold color="cyan">
          you ›{" "}
        </Text>
        <Text>{rec.content}</Text>
      </Box>
    );
  }
  if (rec.role === "assistant_final") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold color="green">
            assistant
          </Text>
          {rec.cost !== undefined ? (
            <Text dimColor>
              {"  $"}
              {rec.cost.toFixed(6)}
            </Text>
          ) : null}
          {rec.usage ? <CacheBadge usage={rec.usage} /> : null}
        </Box>
        {rec.content ? (
          <Text>{rec.content}</Text>
        ) : (
          <Text dimColor italic>
            (tool-call response only)
          </Text>
        )}
      </Box>
    );
  }
  if (rec.role === "tool") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">
          {"tool<"}
          {rec.tool ?? "?"}
          {">"}
        </Text>
        {rec.args ? (
          <Text dimColor>
            {"  args: "}
            {truncate(rec.args, toolArgsMax)}
          </Text>
        ) : null}
        <Text dimColor>
          {"  → "}
          {truncate(rec.content, toolContentMax)}
        </Text>
      </Box>
    );
  }
  if (rec.role === "error") {
    return (
      <Box marginTop={1}>
        <Text color="red" bold>
          error{" "}
        </Text>
        <Text color="red">{rec.error ?? rec.content}</Text>
      </Box>
    );
  }
  if (rec.role === "done" || rec.role === "assistant_delta") {
    // Noise in replay; skip.
    return null;
  }
  return (
    <Box>
      <Text dimColor>
        [{rec.role}] {rec.content}
      </Text>
    </Box>
  );
}

function CacheBadge({ usage }: { usage: NonNullable<TranscriptRecord["usage"]> }) {
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? 0;
  const total = hit + miss;
  if (total === 0) return null;
  const pct = (hit / total) * 100;
  const color = pct >= 70 ? "green" : pct >= 40 ? "yellow" : "red";
  return (
    <Text>
      <Text dimColor>{"  · cache "}</Text>
      <Text color={color}>{pct.toFixed(1)}%</Text>
    </Text>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} chars)`;
}
