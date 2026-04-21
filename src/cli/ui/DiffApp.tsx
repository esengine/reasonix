/**
 * Ink TUI for `reasonix diff`. Split-pane: A on the left, B on the right,
 * shared cursor. Header shows aggregate deltas; footer shows the current
 * pair's divergence note (if any) + key cheat sheet.
 *
 * j/k moves the cursor by one turn; n/N jumps to the next/prev divergent
 * turn — which is the whole point of a diff tool. Quit with q.
 *
 * Pure navigation lives in src/diff.ts (findNextDivergence / findPrevDivergence).
 */

import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useState } from "react";
import {
  type DiffReport,
  type TurnPair,
  findNextDivergence,
  findPrevDivergence,
} from "../../diff.js";
import { RecordView } from "./RecordView.js";

export interface DiffAppProps {
  report: DiffReport;
}

export function DiffApp({ report }: DiffAppProps) {
  const { exit } = useApp();
  const maxIdx = Math.max(0, report.pairs.length - 1);
  // Start at the first divergence when one exists — that's the user's most
  // likely destination. Falls back to idx 0 for fully-matching diffs.
  const initialIdx = report.firstDivergenceTurn
    ? report.pairs.findIndex((p) => p.turn === report.firstDivergenceTurn)
    : 0;
  const [idx, setIdx] = useState(Math.max(0, initialIdx));

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === "j" || key.downArrow || input === " " || key.return) {
      setIdx((i) => Math.min(maxIdx, i + 1));
    } else if (input === "k" || key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
    } else if (input === "g") {
      setIdx(0);
    } else if (input === "G") {
      setIdx(maxIdx);
    } else if (input === "n") {
      const next = findNextDivergence(report.pairs, idx);
      if (next !== -1) setIdx(next);
    } else if (input === "N" || input === "p") {
      const prev = findPrevDivergence(report.pairs, idx);
      if (prev !== -1) setIdx(prev);
    }
  });

  const pair = report.pairs[idx];

  return (
    <Box flexDirection="column">
      <DiffHeader report={report} />

      <Box marginTop={1} paddingX={1} justifyContent="space-between">
        <Text color="cyan" bold>
          turn {pair?.turn ?? "?"} ({idx + 1} / {report.pairs.length})
        </Text>
        <Text>{pair ? <KindBadge kind={pair.kind} /> : null}</Text>
      </Box>

      <Box flexDirection="row" marginTop={1}>
        <Pane label={report.a.label} headerColor="blue" records={paneRecords(pair, "a")} />
        <Pane label={report.b.label} headerColor="magenta" records={paneRecords(pair, "b")} />
      </Box>

      {pair?.divergenceNote ? (
        <Box marginTop={1} paddingX={1}>
          <Text color="yellow">★ </Text>
          <Text>{pair.divergenceNote}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="gray">
        <Text dimColor>
          <Text bold>j</Text>/<Text bold>↓</Text> next · <Text bold>k</Text>/<Text bold>↑</Text>{" "}
          prev · <Text bold>n</Text> next-diverge · <Text bold>N</Text>/<Text bold>p</Text>{" "}
          prev-diverge · <Text bold>g</Text>/<Text bold>G</Text> first/last · <Text bold>q</Text>{" "}
          quit
        </Text>
      </Box>
    </Box>
  );
}

// ----------------------------------------------------------------------------

function DiffHeader({ report }: { report: DiffReport }) {
  const a = report.a;
  const b = report.b;

  const cacheDelta = b.stats.cacheHitRatio - a.stats.cacheHitRatio;
  const costDelta =
    a.stats.totalCostUsd > 0
      ? ((b.stats.totalCostUsd - a.stats.totalCostUsd) / a.stats.totalCostUsd) * 100
      : 0;

  // Prefix stability one-liner (same logic as the stdout summary).
  const aStable = a.stats.prefixHashes.length <= 1;
  const bStable = b.stats.prefixHashes.length <= 1;
  let prefixLine: string | null = null;
  if (aStable !== bStable) {
    const stableLabel = aStable ? report.a.label : report.b.label;
    const churnLabel = aStable ? report.b.label : report.a.label;
    const churnCount = aStable ? b.stats.prefixHashes.length : a.stats.prefixHashes.length;
    prefixLine = `${stableLabel} stayed byte-stable; ${churnLabel} churned ${churnCount} distinct prefixes.`;
  } else if (a.stats.prefixHashes[0] && a.stats.prefixHashes[0] === b.stats.prefixHashes[0]) {
    prefixLine = `shared prefix hash ${a.stats.prefixHashes[0].slice(0, 12)}… — cache delta attributable to log stability, not prompt change.`;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color="cyan" bold>
            reasonix diff
          </Text>
          <Text dimColor> · A=</Text>
          <Text color="blue">{a.label}</Text>
          <Text dimColor> vs B=</Text>
          <Text color="magenta">{b.label}</Text>
        </Text>
        <Text dimColor>{report.pairs.length} turns aligned</Text>
      </Box>

      <Box marginTop={1} gap={3}>
        <Text>
          <Text dimColor>cache </Text>
          <Text>{(a.stats.cacheHitRatio * 100).toFixed(1)}%</Text>
          <Text dimColor> → </Text>
          <Text>{(b.stats.cacheHitRatio * 100).toFixed(1)}%</Text>
          <Text color={cacheDelta >= 0 ? "green" : "red"} bold>
            {"  "}
            {cacheDelta >= 0 ? "+" : ""}
            {(cacheDelta * 100).toFixed(1)}pp
          </Text>
        </Text>
        <Text>
          <Text dimColor>cost </Text>
          <Text>${a.stats.totalCostUsd.toFixed(6)}</Text>
          <Text dimColor> → </Text>
          <Text>${b.stats.totalCostUsd.toFixed(6)}</Text>
          <Text color={costDelta <= 0 ? "green" : "red"} bold>
            {"  "}
            {costDelta >= 0 ? "+" : ""}
            {costDelta.toFixed(1)}%
          </Text>
        </Text>
        <Text>
          <Text dimColor>model calls </Text>
          <Text>
            {a.stats.turns} → {b.stats.turns}
          </Text>
        </Text>
      </Box>

      {prefixLine ? (
        <Box marginTop={1}>
          <Text dimColor italic>
            {prefixLine}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Pane({
  label,
  headerColor,
  records,
}: {
  label: string;
  headerColor: "blue" | "magenta";
  records: TurnPair["aTools"];
}) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
      borderStyle="single"
      borderColor={headerColor}
    >
      <Text color={headerColor} bold>
        {label}
      </Text>
      {records.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor italic>
            (no records on this side for this turn)
          </Text>
        </Box>
      ) : (
        <Static items={records.map((rec, i) => ({ key: `${label}-${i}`, rec }))}>
          {({ key, rec }) => <RecordView key={key} rec={rec} compact />}
        </Static>
      )}
    </Box>
  );
}

function KindBadge({ kind }: { kind: TurnPair["kind"] }) {
  if (kind === "match") {
    return <Text color="green">✓ match</Text>;
  }
  if (kind === "diverge") {
    return <Text color="yellow">★ diverge</Text>;
  }
  if (kind === "only_in_a") {
    return <Text color="blue">← only in A</Text>;
  }
  return <Text color="magenta">→ only in B</Text>;
}

// ----------------------------------------------------------------------------

function paneRecords(pair: TurnPair | undefined, side: "a" | "b"): TurnPair["aTools"] {
  if (!pair) return [];
  const tools = side === "a" ? pair.aTools : pair.bTools;
  const assistant = side === "a" ? pair.aAssistant : pair.bAssistant;
  const out: TurnPair["aTools"] = [...tools];
  if (assistant) out.push(assistant);
  return out;
}
