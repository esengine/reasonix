import { basename } from "node:path";
import { Box, Text, useStdout } from "ink";
import React from "react";
import type { EditMode } from "../../config.js";
import { DEEPSEEK_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS } from "../../telemetry.js";
import type { SessionSummary } from "../../telemetry.js";
import { VERSION } from "../../version.js";
import { COLOR, GRADIENT } from "./theme.js";

const WORDMARK_LETTERS: ReadonlyArray<string> = ["R", "E", "A", "S", "O", "N", "I", "X"];

/**
 * Gradient-flowing wordmark. Every tick the gradient shifts one
 * position so the colors visibly travel across the letters — like
 * a neon sign. Brand mark `◈` rides the same flow but also pulses
 * bold on/off (slow when idle, fast when busy) so a glance at the
 * top of the screen tells you whether the app is thinking.
 *
 * Tick is ~120 ms. `rotateEvery=4` ticks → one shift every ~480 ms
 * idle, ~240 ms when busy. Slow enough to be ambient, fast enough
 * to feel alive. Truecolor terminals get the smooth flow; 8-color
 * fallbacks just see all-cyan, which is still legible.
 */
function Wordmark({
  busy: _busy,
  animate: _animate,
}: {
  busy: boolean;
  animate: boolean;
}) {
  // Static gradient. The brand sweep teal → fuchsia is precomputed
  // once per render — no useTick subscription, no per-tick
  // re-render. Earlier versions flowed the colors over time, but
  // the per-tick re-render interleaved badly with terminal resize
  // (Ink's eraseLines misjudges row count when bars / wide text
  // wrap, ghost frames stack). Keeping this static eliminates the
  // multiplier; resize artifacts at most leave a single stale
  // frame instead of N.
  return (
    <Text>
      <Text color={GRADIENT[0]} bold>
        ◈
      </Text>
      <Text> </Text>
      {WORDMARK_LETTERS.map((letter, i) => (
        <Text key={letter} color={GRADIENT[i % GRADIENT.length]} bold>
          {letter}
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
  /**
   * /pro is queued — the next turn will run on v4-pro regardless of
   * `model`. Rendered as a yellow `⇧ pro armed` pill in the header so
   * the user has a clear "this turn will be expensive" signal before
   * submitting their message.
   */
  proArmed?: boolean;
  /**
   * The CURRENT turn is running on v4-pro because the failure-
   * escalation threshold fired mid-turn. Rendered as a red `⇧ pro
   * escalated` pill. Clears at turn end.
   */
  escalated?: boolean;
  /**
   * Active session USD budget cap, or `null` when the user hasn't set
   * one. When present the panel renders a `$X.XX / $Y.YY (Z%)` row
   * that turns amber past 80% and red past 100% — the same thresholds
   * the loop uses to warn / refuse. Hidden when null so the default
   * (no-cap) install doesn't have a confusing "no budget" line.
   */
  budgetUsd?: number | null;
  /**
   * Workspace root directory. The chrome surfaces just the basename
   * (project folder name) — full paths waste status-row real estate
   * and the user already knows where they ran `reasonix code`. Absent
   * outside `reasonix code` (chat mode renders without a project crumb).
   */
  rootDir?: string;
  /**
   * Active session name (e.g. "code-myproject"). Shown alongside the
   * project crumb so users with multiple sessions per project can tell
   * them apart at a glance. Absent → ephemeral session, no crumb shown.
   */
  sessionName?: string | null;
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
  proArmed,
  escalated,
  budgetUsd,
  rootDir,
  sessionName,
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

  // Top status header — exactly one row, with brand wordmark + project
  // crumb on the LEFT and pills (mode / cost / cache) right-aligned via
  // a flex spacer. A faint horizontal rule below separates the chrome
  // from the conversation log so the eye reads it as a header bar, not
  // another log entry. Matches design/tui-redesign-ink.html topbar.
  //
  // Removed from the persistent panel (now via /status slash on demand):
  //   · model name, harvest / branch / effort flags
  //   · ctx pill (still in /status; chrome shows budget/cache only)
  //   · turn counter, update nudge, dashboard URL
  // Showing all of those every frame burned vertical space the
  // conversation needed.
  return (
    <Box flexDirection="column" paddingX={1}>
      <ChromeRow
        editMode={editMode}
        planMode={planMode}
        proArmed={proArmed ?? false}
        escalated={escalated ?? false}
        summary={summary}
        coldStart={coldStart}
        rootDir={rootDir}
        sessionName={sessionName ?? null}
        updateAvailable={updateAvailable}
        balance={balance ?? null}
        narrow={narrow}
      />
      <ChromeRule />
      {budgetUsd !== null && budgetUsd !== undefined ? (
        <BudgetRow spent={summary.totalCostUsd} cap={budgetUsd} />
      ) : null}
    </Box>
  );
}

/** Faint horizontal rule under the chrome. Visually separates the
 *  status header from the conversation log so the eye treats the row
 *  above as chrome, not as another log entry. */
function ChromeRule() {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const w = Math.max(20, cols - 2);
  return <Text dimColor>{"─".repeat(w)}</Text>;
}

/**
 * Single-row chrome: `◈ reasonix · <project> › <session>` on the left,
 * pills `[mode]  [cost]  [cache <bar> N%]` right-aligned via a flex
 * spacer. Narrow terminals collapse the project crumb to just the
 * basename + drop the session.
 */
function ChromeRow({
  editMode,
  planMode,
  proArmed,
  escalated,
  summary,
  coldStart,
  rootDir,
  sessionName,
  updateAvailable,
  balance,
  narrow,
}: {
  editMode?: EditMode;
  planMode?: boolean;
  proArmed: boolean;
  escalated: boolean;
  summary: SessionSummary;
  coldStart: boolean;
  rootDir?: string;
  sessionName?: string | null;
  updateAvailable?: string | null;
  balance?: { currency: string; total: number } | null;
  narrow: boolean;
}) {
  const modePill = pickModePill(planMode, editMode);
  const proPill = escalated
    ? { label: "⇧ pro", color: COLOR.err }
    : proArmed
      ? { label: "⇧ pro", color: COLOR.warn }
      : null;
  const projectName = rootDir ? basename(rootDir) : null;
  const cachePct = Math.round(summary.cacheHitRatio * 100);
  const cacheColor =
    summary.cacheHitRatio >= 0.7 ? COLOR.ok : summary.cacheHitRatio >= 0.4 ? COLOR.warn : COLOR.err;

  return (
    <Box>
      {/* LEFT: brand wordmark + project crumb */}
      <Text bold color={GRADIENT[0]}>
        {"◈ "}
      </Text>
      <Text color={COLOR.brand} bold>
        reasonix
      </Text>
      {projectName ? (
        <>
          <Text color={COLOR.info} dimColor>
            {"  ·  "}
          </Text>
          <Text>{projectName}</Text>
          {!narrow && sessionName ? (
            <>
              <Text color={COLOR.info} dimColor>
                {"  ›  "}
              </Text>
              <Text color={COLOR.info}>{sessionName}</Text>
            </>
          ) : null}
        </>
      ) : null}

      {/* SPACER pushes pills to the right edge */}
      <Box flexGrow={1} />

      {/* RIGHT: pills */}
      {updateAvailable ? (
        <>
          <Text color={COLOR.warn} bold>
            {`↑ ${updateAvailable}`}
          </Text>
          <Text>{"  "}</Text>
        </>
      ) : null}
      {modePill ? (
        <>
          <Text color={modePill.color} bold>
            {`[${modePill.label}]`}
          </Text>
          <Text>{"  "}</Text>
        </>
      ) : null}
      {proPill ? (
        <>
          <Text color={proPill.color} bold>
            {`[${proPill.label}]`}
          </Text>
          <Text>{"  "}</Text>
        </>
      ) : null}
      {/* Cost — always shown. */}
      <Text
        color={
          summary.turns === 0 || coldStart ? COLOR.info : sessionCostColor(summary.totalCostUsd)
        }
        bold={summary.turns > 0 && !coldStart}
        dimColor={summary.turns === 0 || coldStart}
      >
        {`[$${summary.totalCostUsd.toFixed(4)}]`}
      </Text>
      {/* Balance pill — wallet remaining at the API. Threshold colors:
          red <1, amber <5, ok ≥5. Drops first when the chrome
          overflows since the user can hit /status for the same data. */}
      {balance && !narrow ? (
        <>
          <Text>{"  "}</Text>
          <Text color={balance.total < 1 ? COLOR.err : balance.total < 5 ? COLOR.warn : COLOR.ok}>
            {`[w ${balance.currency === "USD" ? "$" : ""}${balance.total.toFixed(2)}${balance.currency !== "USD" ? ` ${balance.currency}` : ""}]`}
          </Text>
        </>
      ) : null}
      {summary.turns > 3 && !narrow ? (
        <>
          <Text>{"  "}</Text>
          <Text dimColor>{"["}</Text>
          <Text dimColor>{"c "}</Text>
          <Bar ratio={summary.cacheHitRatio} color={cacheColor} cells={6} />
          <Text> </Text>
          <Text color={cacheColor}>{`${cachePct}%`}</Text>
          <Text dimColor>{"]"}</Text>
        </>
      ) : null}
    </Box>
  );
}

/** Map (planMode, editMode) → mode pill. PLAN trumps everything. */
function pickModePill(
  planMode: boolean | undefined,
  editMode: EditMode | undefined,
): { label: string; color: string } | null {
  if (planMode) return { label: "PLAN", color: COLOR.err };
  if (editMode === "yolo") return { label: "yolo", color: COLOR.err };
  if (editMode === "auto") return { label: "auto", color: COLOR.primary };
  if (editMode === "review") return { label: "review", color: COLOR.info };
  return null;
}

/**
 * One-row spend-vs-cap indicator. Hidden when no budget is set so
 * the no-cap default doesn't clutter the panel. Color thresholds
 * match the loop's: amber at 80% (warn fired), red at 100% (next
 * turn refused).
 */
function BudgetRow({ spent, cap }: { spent: number; cap: number }) {
  const pct = Math.max(0, (spent / cap) * 100);
  const color = pct >= 100 ? "#f87171" : pct >= 80 ? "#fbbf24" : "#94a3b8";
  return (
    <Box>
      <Text dimColor>{"  budget  "}</Text>
      <Text color={color}>
        {`$${spent.toFixed(4)} / $${cap.toFixed(2)}`}
        <Text dimColor>{`  (${pct.toFixed(0)}%)`}</Text>
      </Text>
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
  proArmed,
  escalated,
  animate,
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
  proArmed: boolean;
  escalated: boolean;
  /** When false, suppress optional pills + animation to avoid wraps. */
  animate: boolean;
}) {
  // Mode pill — pick the most informative one to surface in the
  // header. PLAN beats AUTO/review beats nothing. Pro armed/escalated
  // gets its own pill alongside.
  const modePill = planMode
    ? { label: "PLAN", bg: "red" as const }
    : editMode === "auto"
      ? { label: "AUTO", bg: "magenta" as const }
      : editMode === "review"
        ? { label: "REVIEW", bg: "cyan" as const }
        : null;
  const proPill = escalated
    ? { label: "⇧ PRO", bg: "red" as const }
    : proArmed
      ? { label: "⇧ PRO", bg: "yellow" as const }
      : null;
  // Narrow / non-animate mode hides the secondary pills (harvest,
  // branch, reasoning effort) so the header always fits on one
  // visual row. Wrapping the header is the main amplifier of the
  // eraseLines miscount that produces the "screen flashing" effect.
  const showSecondary = animate && !narrow;
  return (
    <Box justifyContent="space-between">
      <Box>
        <Wordmark busy={busy} animate={animate} />
        <Text dimColor>{`  ${VERSION}`}</Text>
        <Text dimColor>{"   "}</Text>
        <Text color="yellow" bold>
          {model.replace(/^deepseek-/, "")}
        </Text>
        {modePill ? (
          <>
            <Text>{"  "}</Text>
            <Pill label={modePill.label} bg={modePill.bg} />
          </>
        ) : null}
        {proPill ? (
          <>
            <Text>{"  "}</Text>
            <Pill label={proPill.label} bg={proPill.bg} />
          </>
        ) : null}
        {showSecondary && harvestOn ? (
          <Text dimColor>
            <Text>{"  "}</Text>
            <Text color="magenta">harvest</Text>
          </Text>
        ) : null}
        {showSecondary && branchOn ? (
          <Text dimColor>
            <Text>{"  "}</Text>
            <Text color="blue">{`branch×${branchBudget}`}</Text>
          </Text>
        ) : null}
        {showSecondary && reasoningEffort === "max" ? (
          <>
            <Text>{"  "}</Text>
            <Text color="green" dimColor>
              max
            </Text>
          </>
        ) : null}
        {showSecondary && reasoningEffort === "high" ? (
          <>
            <Text>{"  "}</Text>
            <Text color="yellow" dimColor>
              high
            </Text>
          </>
        ) : null}
      </Box>
      <Text>
        {updateAvailable ? <Text color="yellow" bold>{`↑ ${updateAvailable}   `}</Text> : null}
        <Text dimColor>{narrow ? `t${turns}` : `turn ${turns} · /help`}</Text>
      </Text>
    </Box>
  );
}

/** Solid-background tag, used for primary mode + pro indicators. */
function Pill({ label, bg }: { label: string; bg: "red" | "magenta" | "cyan" | "yellow" }) {
  return (
    <Text backgroundColor={bg} color="white" bold>
      {` ${label} `}
    </Text>
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
        <Text color={COLOR.info} dimColor>
          {"▣ ctx "}
        </Text>
        <Text dimColor>— (no turns yet)</Text>
      </Text>
    );
  }
  const color = ratio >= 0.8 ? COLOR.err : ratio >= 0.6 ? COLOR.warn : COLOR.ok;
  const pct = Math.round(ratio * 100);
  return (
    <Text>
      <Text color={COLOR.info}>{"▣ ctx  "}</Text>
      <Bar ratio={ratio} color={color} cells={showBar ? 14 : 10} />
      <Text> </Text>
      <Text color={color} bold>
        {formatTokens(promptTokens)}/{formatTokens(ctxMax)}
      </Text>
      <Text dimColor> ({pct}%)</Text>
      {ratio >= 0.8 ? (
        <Text color={COLOR.err} bold>
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
        <Text color={COLOR.info} dimColor>
          {"⌬ cache "}
        </Text>
        <Text dimColor>—</Text>
      </Text>
    );
  }
  if (coldStart) {
    return (
      <Text>
        <Text color={COLOR.info} dimColor>
          {"⌬ cache "}
        </Text>
        <Text dimColor>{pct}% </Text>
        <Text dimColor italic>
          (cold start)
        </Text>
      </Text>
    );
  }
  const color = hitRatio >= 0.7 ? COLOR.ok : hitRatio >= 0.4 ? COLOR.warn : COLOR.err;
  return (
    <Text>
      <Text color={COLOR.info}>{"⌬ cache  "}</Text>
      <Text color={color} bold>
        {pct}%
      </Text>
    </Text>
  );
}

/**
 * Color thresholds. Per-turn and session cumulative scale roughly 10×
 * apart — a $0.20 single turn should feel just as warn-worthy as a $2
 * session total. Values are rough "notice this" points, not hard caps.
 */
function turnCostColor(cost: number): string | undefined {
  if (cost <= 0) return undefined;
  if (cost >= 0.2) return COLOR.err;
  if (cost >= 0.05) return COLOR.warn;
  return COLOR.ok;
}
function sessionCostColor(cost: number): string | undefined {
  if (cost <= 0) return undefined;
  if (cost >= 5) return COLOR.err;
  if (cost >= 0.5) return COLOR.warn;
  return COLOR.ok;
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
        <Text color={COLOR.info} dimColor>
          {"◴ cost "}
        </Text>
        <Text dimColor>—</Text>
      </Text>
    );
  }
  // The first turn is unavoidably a cache-miss (nothing to hit),
  // so the dollar figure is front-loaded. Muting it during the
  // cold-start window keeps the "expensive first turn" from
  // reading as "something is wrong."
  const turnColor = coldStart ? undefined : turnCostColor(summary.lastTurnCostUsd);
  const sessionColor = coldStart ? undefined : sessionCostColor(summary.totalCostUsd);
  return (
    <Text>
      <Text color={COLOR.info}>{"◴ turn  "}</Text>
      <Text color={turnColor} bold={!coldStart} dimColor={coldStart}>
        ${summary.lastTurnCostUsd.toFixed(4)}
      </Text>
      <Text dimColor>{" · session "}</Text>
      <Text color={sessionColor} bold={!coldStart} dimColor={coldStart}>
        ${summary.totalCostUsd.toFixed(4)}
      </Text>
    </Text>
  );
}

function BalanceCell({ balance }: { balance: { currency: string; total: number } }) {
  const color = balance.total < 1 ? COLOR.err : balance.total < 5 ? COLOR.warn : COLOR.ok;
  return (
    <Text>
      <Text color={COLOR.info}>{"◐ balance  "}</Text>
      <Text color={color} bold>
        {balance.currency === "USD" ? "$" : ""}
        {balance.total.toFixed(2)}
        {balance.currency !== "USD" ? ` ${balance.currency}` : ""}
      </Text>
    </Text>
  );
}

/**
 * Truecolor progress bar. Filled cells use the threshold color (green
 * → amber → rose) so the bar communicates pressure at a glance;
 * empty cells use a dim shade so the empty portion is visible
 * without dominating. ▰/▱ have distinct shapes (filled vs hollow)
 * so the boundary is clear even when colors snap to 8-color slots
 * on legacy terminals.
 */
function Bar({
  ratio,
  color,
  cells = 14,
}: {
  ratio: number;
  color: string;
  cells?: number;
}) {
  const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)));
  return (
    <Text>
      <Text color={color}>{"▰".repeat(filled)}</Text>
      <Text dimColor>{"▱".repeat(cells - filled)}</Text>
    </Text>
  );
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
