import { Box, Text, useStdout } from "ink";
import React from "react";
import type { EditMode } from "../../config.js";
import { DEEPSEEK_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS } from "../../telemetry.js";
import type { SessionSummary } from "../../telemetry.js";
import { VERSION } from "../../version.js";
import { useTick } from "./ticker.js";

/**
 * Cyan → blue → purple truecolor gradient for the REASONIX wordmark.
 * Each char gets its own hex color — terminals that support 24-bit
 * color (nearly all since 2016) render this as a smooth fade. Older
 * 256-color terminals snap to nearest; 8-color fall all the way back
 * to plain cyan via Ink's color pipeline, so the worst case is still
 * legible.
 */
const WORDMARK_STYLES: ReadonlyArray<{ ch: string; color: string; isLogo: boolean }> = [
  { ch: "◈", color: "#5eead4", isLogo: true }, // teal — brand mark
  { ch: " ", color: "#5eead4", isLogo: false },
  { ch: "R", color: "#67e8f9", isLogo: false }, // cyan
  { ch: "E", color: "#7dd3fc", isLogo: false }, // sky
  { ch: "A", color: "#93c5fd", isLogo: false }, // blue
  { ch: "S", color: "#a5b4fc", isLogo: false }, // indigo
  { ch: "O", color: "#c4b5fd", isLogo: false }, // violet
  { ch: "N", color: "#d8b4fe", isLogo: false }, // purple
  { ch: "I", color: "#f0abfc", isLogo: false }, // fuchsia
  { ch: "X", color: "#f0abfc", isLogo: false }, // fuchsia
];

/**
 * Gradient-filled, animated app wordmark. The `◈` brand mark breathes
 * (bold on/off) once every ~1.6s when idle, ~600ms when the model is
 * working, so a glance at the top of the screen tells you immediately
 * whether the app is doing something. Letters' keys use the char+color
 * pair (not an index) so React state attaches to the glyph itself;
 * fine because WORDMARK_STYLES never reorders.
 */
function Wordmark({ busy }: { busy: boolean }) {
  const tick = useTick();
  // Slow pulse = 12 ticks (~1.4s). Busy pulse = 5 ticks (~600ms).
  const period = busy ? 5 : 12;
  const bright = Math.floor(tick / period) % 2 === 0;
  return (
    <Text>
      {WORDMARK_STYLES.map((c) => (
        <Text key={`${c.ch}-${c.color}`} color={c.color} bold={c.isLogo ? bright : true}>
          {c.ch}
        </Text>
      ))}
    </Text>
  );
}

export interface StatsPanelProps {
  summary: SessionSummary;
  model: string;
  prefixHash: string;
  harvestOn?: boolean;
  branchBudget?: number;
  /**
   * Current `reasoning_effort` cap. Shown as a green "· max" / yellow
   * "· high" tag in the header so the user always sees which tier the
   * next turn will use. Absent/undefined hides the tag (e.g. before
   * the loop is constructed).
   */
  reasoningEffort?: "high" | "max";
  /**
   * True when `reasonix code` is currently running in read-only Plan
   * Mode. Surfaced as a red "PLAN" tag in the panel header so the user
   * can tell at a glance that edits are gated behind submit_plan +
   * approval.
   */
  planMode?: boolean;
  /**
   * Edit-gate mode. Surfaced as a small pill in the header so the user
   * can see at a glance whether edits will be queued for review or
   * applied immediately. Omitted in chat (non-code) mode.
   */
  editMode?: EditMode;
  /**
   * Account balance fetched once at launch (and optionally refreshed
   * per-turn by the TUI). `null` or absent hides the balance cell
   * entirely — /user/balance failed or the user ran with `--no-config`.
   * The top-up warning fires below 1.0 unit of whatever currency
   * the endpoint reports so a Chinese user with CNY and a U.S. user
   * with USD both see "getting low."
   */
  balance?: { currency: string; total: number } | null;
  /**
   * Published npm version newer than VERSION. Rendered as a yellow
   * "· update: X" nudge in the panel header. `null` / `undefined`
   * hides the nudge (offline launch, already up to date, or check
   * still in flight).
   */
  updateAvailable?: string | null;
  /**
   * True when the loop is currently mid-turn — drives the wordmark's
   * "busy breathing" animation. Visual signal that the app is thinking,
   * visible at a glance from anywhere on screen.
   */
  busy?: boolean;
}

/**
 * Terminal width under which we switch from one-line metrics to a
 * stacked layout. Below 120 cols the wide version wraps mid-number
 * and the parens ("in $X · out $Y") get split across lines — which
 * looks broken. Stacking costs one row but stays readable on every
 * SSH / split-pane case we've hit.
 */
const NARROW_BREAKPOINT = 120;

/**
 * Cache-hit ratio is always zero on turn 1 (there's literally no cache
 * to hit yet). Showing that as red "0.0%" is a false alarm — new users
 * read it as "something is broken." We suppress the gradient until a
 * few turns have landed; by turn 4 the cache has had time to warm up.
 */
const COLD_START_TURNS = 3;

export function StatsPanel({
  summary,
  model,
  prefixHash,
  harvestOn,
  branchBudget,
  reasoningEffort,
  planMode,
  editMode,
  balance,
  updateAvailable,
  busy,
}: StatsPanelProps) {
  const branchOn = (branchBudget ?? 1) > 1;
  const ctxMax = DEEPSEEK_CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT_TOKENS;
  const ctxRatio = summary.lastPromptTokens / ctxMax;
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const narrow = columns < NARROW_BREAKPOINT;

  // Cold-start: first few turns render cache+cost muted so a 0.0% hit
  // rate on turn 1 doesn't look like an error. Once the cache has
  // actually had a chance to build, we flip to the live gradient.
  const coldStart = summary.turns <= COLD_START_TURNS;

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Header
        model={model}
        prefixHash={prefixHash}
        harvestOn={harvestOn}
        branchOn={branchOn}
        branchBudget={branchBudget ?? 1}
        reasoningEffort={reasoningEffort}
        planMode={planMode}
        editMode={editMode}
        turns={summary.turns}
        updateAvailable={updateAvailable}
        narrow={narrow}
        busy={busy ?? false}
      />
      {narrow ? (
        <StackedMetrics
          summary={summary}
          ctxRatio={ctxRatio}
          ctxMax={ctxMax}
          balance={balance}
          coldStart={coldStart}
        />
      ) : (
        <InlineMetrics
          summary={summary}
          ctxRatio={ctxRatio}
          ctxMax={ctxMax}
          balance={balance}
          coldStart={coldStart}
        />
      )}
    </Box>
  );
}

function Header({
  model,
  prefixHash,
  harvestOn,
  branchOn,
  branchBudget,
  reasoningEffort,
  planMode,
  editMode,
  turns,
  updateAvailable,
  narrow,
  busy,
}: {
  model: string;
  prefixHash: string;
  harvestOn?: boolean;
  branchOn: boolean;
  branchBudget: number;
  reasoningEffort?: "high" | "max";
  planMode?: boolean;
  editMode?: EditMode;
  turns: number;
  updateAvailable?: string | null;
  narrow: boolean;
  busy: boolean;
}) {
  return (
    <Box justifyContent="space-between">
      <Box>
        <Wordmark busy={busy} />
        <Text dimColor>{` v${VERSION}`}</Text>
        <Text dimColor> · </Text>
        <Text color="yellow">{model}</Text>
        {narrow ? null : (
          <>
            <Text dimColor> · </Text>
            <Text dimColor>{prefixHash}</Text>
          </>
        )}
        {harvestOn ? <Text color="magenta"> · harvest</Text> : null}
        {branchOn ? <Text color="blue"> · branch{branchBudget}</Text> : null}
        {reasoningEffort === "max" ? <Text color="green"> · max</Text> : null}
        {reasoningEffort === "high" ? <Text color="yellow"> · high</Text> : null}
        {planMode ? (
          <Text color="red" bold>
            {" · PLAN"}
          </Text>
        ) : null}
        {editMode ? (
          <Text color={editMode === "auto" ? "magenta" : "cyan"} bold>
            {editMode === "auto" ? " · AUTO" : " · review"}
          </Text>
        ) : null}
      </Box>
      <Text>
        {updateAvailable ? (
          <Text color="yellow" bold>{`update: ${updateAvailable} · `}</Text>
        ) : null}
        <Text dimColor>{narrow ? `turn ${turns}` : `turn ${turns} · /help`}</Text>
      </Text>
    </Box>
  );
}

/**
 * Wide-terminal layout (≥120 cols): single metrics row. Matches the
 * original panel, just with calmer spacing and the cold-start
 * treatment folded in.
 */
function InlineMetrics({
  summary,
  ctxRatio,
  ctxMax,
  balance,
  coldStart,
}: {
  summary: SessionSummary;
  ctxRatio: number;
  ctxMax: number;
  balance?: { currency: string; total: number } | null;
  coldStart: boolean;
}) {
  return (
    <Box marginTop={1} gap={3}>
      <ContextCell ratio={ctxRatio} promptTokens={summary.lastPromptTokens} ctxMax={ctxMax} />
      <CacheCell hitRatio={summary.cacheHitRatio} coldStart={coldStart} turns={summary.turns} />
      <CostCell summary={summary} coldStart={coldStart} />
      {balance ? <BalanceCell balance={balance} /> : null}
    </Box>
  );
}

/**
 * Narrow-terminal layout (<120 cols): one metric per line, in priority
 * order (ctx → balance → cache → cost). Order matters because users
 * scanning a cramped terminal want "am I about to hit a wall?" answered
 * first; dollars spent comes later.
 */
function StackedMetrics({
  summary,
  ctxRatio,
  ctxMax,
  balance,
  coldStart,
}: {
  summary: SessionSummary;
  ctxRatio: number;
  ctxMax: number;
  balance?: { currency: string; total: number } | null;
  coldStart: boolean;
}) {
  return (
    <Box marginTop={1} flexDirection="column">
      <ContextCell
        ratio={ctxRatio}
        promptTokens={summary.lastPromptTokens}
        ctxMax={ctxMax}
        showBar
      />
      {balance ? <BalanceCell balance={balance} /> : null}
      <CacheCell hitRatio={summary.cacheHitRatio} coldStart={coldStart} turns={summary.turns} />
      <CostCell summary={summary} coldStart={coldStart} />
    </Box>
  );
}

function ContextCell({
  ratio,
  promptTokens,
  ctxMax,
  showBar,
}: {
  ratio: number;
  promptTokens: number;
  ctxMax: number;
  showBar?: boolean;
}) {
  if (promptTokens === 0) {
    return (
      <Text>
        <Text dimColor>ctx </Text>
        <Text dimColor>— (no turns yet)</Text>
      </Text>
    );
  }
  const color = ratio >= 0.8 ? "red" : ratio >= 0.6 ? "yellow" : "green";
  const pct = Math.round(ratio * 100);
  return (
    <Text>
      <Text dimColor>ctx </Text>
      {showBar ? <Bar ratio={ratio} color={color} /> : null}
      {showBar ? <Text> </Text> : null}
      <Text color={color} bold>
        {formatTokens(promptTokens)}/{formatTokens(ctxMax)}
      </Text>
      <Text dimColor> ({pct}%)</Text>
      {ratio >= 0.8 ? (
        <Text color="red" bold>
          {"  ·  /compact"}
        </Text>
      ) : null}
    </Text>
  );
}

function CacheCell({
  hitRatio,
  coldStart,
  turns,
}: {
  hitRatio: number;
  coldStart: boolean;
  turns: number;
}) {
  const pct = (hitRatio * 100).toFixed(1);
  if (turns === 0) {
    return (
      <Text>
        <Text dimColor>cache </Text>
        <Text dimColor>—</Text>
      </Text>
    );
  }
  if (coldStart) {
    return (
      <Text>
        <Text dimColor>cache </Text>
        <Text dimColor>{pct}% </Text>
        <Text dimColor italic>
          (cold start)
        </Text>
      </Text>
    );
  }
  const color = hitRatio >= 0.7 ? "green" : hitRatio >= 0.4 ? "yellow" : "red";
  return (
    <Text>
      <Text dimColor>cache </Text>
      <Text color={color} bold>
        {pct}%
      </Text>
    </Text>
  );
}

function CostCell({
  summary,
  coldStart,
}: {
  summary: SessionSummary;
  coldStart: boolean;
}) {
  if (summary.turns === 0) {
    return (
      <Text>
        <Text dimColor>cost </Text>
        <Text dimColor>—</Text>
      </Text>
    );
  }
  // The first turn is unavoidably a cache-miss (nothing to hit),
  // so the dollar figure is front-loaded. Muting it during the
  // cold-start window keeps the "expensive first turn" from
  // reading as "something is wrong."
  const primaryColor = coldStart ? undefined : "green";
  return (
    <Text>
      <Text dimColor>cost </Text>
      <Text color={primaryColor} bold={!coldStart} dimColor={coldStart}>
        ${summary.totalCostUsd.toFixed(6)}
      </Text>
      <Text dimColor>
        {" (in "}${summary.totalInputCostUsd.toFixed(6)}
        {" · out "}${summary.totalOutputCostUsd.toFixed(6)}
        {")"}
      </Text>
    </Text>
  );
}

function BalanceCell({ balance }: { balance: { currency: string; total: number } }) {
  const color = balance.total < 1 ? "red" : balance.total < 5 ? "yellow" : "green";
  return (
    <Text>
      <Text dimColor>balance </Text>
      <Text color={color} bold>
        {balance.currency === "USD" ? "$" : ""}
        {balance.total.toFixed(2)}
        {balance.currency !== "USD" ? ` ${balance.currency}` : ""}
      </Text>
    </Text>
  );
}

/**
 * Unicode progress bar for the narrow layout's context cell. 10 cells
 * wide — narrow terminals are already cramped, and the bar is just a
 * visual cue for the percentage next to it, not the primary readout.
 */
function Bar({ ratio, color }: { ratio: number; color: "green" | "yellow" | "red" }) {
  const cells = 10;
  const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)));
  const bar = "█".repeat(filled) + "░".repeat(cells - filled);
  return <Text color={color}>{bar}</Text>;
}

/**
 * Compact token formatter using binary K (÷1024): 1234 → "1.2K",
 * 131072 → "128K". Matches DeepSeek's marketing label of "128K context
 * length" — showing "131k" confused users (the actual limit is
 * 128×1024 = 131,072 tokens, but the doc consistently says "128K").
 * Uppercase K signals binary-K to anyone who notices.
 */
function formatTokens(n: number): string {
  if (n < 1024) return String(n);
  const k = n / 1024;
  return k >= 100 ? `${k.toFixed(0)}K` : `${k.toFixed(1)}K`;
}
