import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import stringWidth from "string-width";
import type { SessionSummary } from "../../telemetry.js";
import { ChromeRule } from "./primitives.js";
import { COLOR, GRADIENT } from "./theme.js";

const COLD_START_TURNS = 3;
const CACHE_BAR_CELLS = 10;

export type Preset = "auto" | "flash" | "pro";

export interface ChromeBarProps {
  summary: SessionSummary;
  rootDir?: string;
  sessionName?: string | null;
  preset?: Preset;
  planMode?: boolean;
  proArmed?: boolean;
  escalated?: boolean;
  updateAvailable?: string | null;
  balance?: { currency: string; total: number } | null;
  budgetUsd?: number | null;
  /** Scroll progress: 0 = at latest, 1 = at oldest. Hides the pill at 0. */
  scrollRatio?: number;
}

export function ChromeBar(props: ChromeBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = (stdout?.columns ?? 80) - 2; // subtract paddingX={1} on both sides
  const cold = props.summary.turns <= COLD_START_TURNS;
  const projectName = props.rootDir ? basename(props.rootDir) : null;
  const mode = pickModePill(props.planMode, props.preset);
  const proPill = props.escalated
    ? { label: "⇧ pro", color: COLOR.err }
    : props.proArmed
      ? { label: "⇧ pro", color: COLOR.warn }
      : null;

  // Greedy width-aware fit. Layout (each gap is exactly ONE space — single
  // suffix on update/mode/pro/scroll, single prefix on balance/cache):
  //   [brand][·project][›session]<spacer>[scroll][update][mode][pro]$cost  w bal cache █▓▓▓
  // Always-shown carve out the budget first; optional pieces are dropped
  // by priority — balance > cache > session > update — until the row fits.
  // (`flexGrow` spacer can shrink to 0, so no minimum reserve.) Cache is
  // shown unconditionally now: pre-turn-4 it renders dim with a "—" so
  // it's "default on" instead of materializing only after a few turns.
  const SEP = 3; // " · " / " › "
  const GAP = 1;
  const scrollLabel =
    props.scrollRatio !== undefined && props.scrollRatio > 0
      ? `[↑ ${Math.round(props.scrollRatio * 100)}%]`
      : "";
  const updateLabel = props.updateAvailable ? `↑ ${props.updateAvailable}` : "";
  const balanceLabel = props.balance ? formatBalanceLabel(props.balance) : "";
  const cachePct = Math.round(props.summary.cacheHitRatio * 100);
  // Use the worst-case rendered cache string (3-digit pct, full bar) so the
  // shed decision doesn't oscillate as the percentage changes turn-to-turn.
  const cacheLabel = `cache ${"█".repeat(CACHE_BAR_CELLS)} 100%`;
  const costLabel = `$${props.summary.totalCostUsd.toFixed(4)}${
    props.budgetUsd && props.budgetUsd > 0 ? ` / $${props.budgetUsd.toFixed(2)}` : ""
  }`;

  const brandW = stringWidth("◈ reasonix");
  const projectW = projectName ? SEP + stringWidth(projectName) : 0;
  const fixedLeft = brandW + projectW;
  const scrollW = scrollLabel ? stringWidth(scrollLabel) + GAP : 0;
  const modeW = mode ? stringWidth(`[${mode.label}]`) + GAP : 0;
  const proW = proPill ? stringWidth(`[${proPill.label}]`) + GAP : 0;
  const costW = stringWidth(costLabel);
  const fixedRight = scrollW + modeW + proW + costW;
  let budget = cols - fixedLeft - fixedRight;

  const balanceOptW = balanceLabel ? GAP + stringWidth(balanceLabel) : 0;
  const cacheOptW = GAP + stringWidth(cacheLabel);
  const sessionOptW = props.sessionName ? SEP + stringWidth(props.sessionName) : 0;
  const updateOptW = updateLabel ? stringWidth(updateLabel) + GAP : 0;

  const showBalance = balanceOptW > 0 && budget >= balanceOptW;
  if (showBalance) budget -= balanceOptW;
  const showCache = budget >= cacheOptW;
  if (showCache) budget -= cacheOptW;
  const showSession = sessionOptW > 0 && budget >= sessionOptW;
  if (showSession) budget -= sessionOptW;
  const showUpdate = updateOptW > 0 && budget >= updateOptW;
  if (showUpdate) budget -= updateOptW;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color={GRADIENT[0]}>
          {"◈ "}
        </Text>
        <Text color={COLOR.brand} bold>
          reasonix
        </Text>
        {projectName ? (
          <>
            <Text color={COLOR.info} dimColor>
              {" · "}
            </Text>
            <Text>{projectName}</Text>
            {showSession && props.sessionName ? (
              <>
                <Text color={COLOR.info} dimColor>
                  {" › "}
                </Text>
                <Text color={COLOR.info}>{props.sessionName}</Text>
              </>
            ) : null}
          </>
        ) : null}

        <Box flexGrow={1} />

        {scrollLabel ? (
          <>
            <Text color={COLOR.accent} bold>
              {scrollLabel}
            </Text>
            <Text> </Text>
          </>
        ) : null}
        {showUpdate ? (
          <>
            <Text color={COLOR.warn} bold>
              {updateLabel}
            </Text>
            <Text> </Text>
          </>
        ) : null}
        {mode ? (
          <>
            <Text color={mode.color} bold>
              {`[${mode.label}]`}
            </Text>
            <Text> </Text>
          </>
        ) : null}
        {proPill ? (
          <>
            <Text color={proPill.color} bold>
              {`[${proPill.label}]`}
            </Text>
            <Text> </Text>
          </>
        ) : null}
        <CostPill summary={props.summary} cold={cold} budgetUsd={props.budgetUsd} />
        {showBalance && props.balance ? (
          <>
            <Text> </Text>
            <BalancePill balance={props.balance} />
          </>
        ) : null}
        {showCache ? (
          <>
            <Text> </Text>
            <CachePill ratio={props.summary.cacheHitRatio} cold={cold} pct={cachePct} />
          </>
        ) : null}
      </Box>
      <ChromeRule />
    </Box>
  );
}

function formatBalanceLabel(balance: { currency: string; total: number }): string {
  const sym = balance.currency === "USD" ? "$" : balance.currency === "CNY" ? "¥" : "";
  const suf = sym ? "" : ` ${balance.currency}`;
  return `w ${sym}${balance.total.toFixed(2)}${suf}`;
}

function CostPill({
  summary,
  cold,
  budgetUsd,
}: {
  summary: SessionSummary;
  cold: boolean;
  budgetUsd?: number | null;
}): React.ReactElement {
  const cost = summary.totalCostUsd;
  const color = cold ? COLOR.info : sessionCostColor(cost);
  return (
    <>
      <Text color={color} bold={!cold} dimColor={cold}>
        {`$${cost.toFixed(4)}`}
      </Text>
      {budgetUsd && budgetUsd > 0 ? (
        <Text color={COLOR.info} dimColor>
          {` / $${budgetUsd.toFixed(2)}`}
        </Text>
      ) : null}
    </>
  );
}

function BalancePill({
  balance,
}: {
  balance: { currency: string; total: number };
}): React.ReactElement {
  const { total } = balance;
  const color = total < 1 ? COLOR.err : total < 5 ? COLOR.warn : COLOR.ok;
  return <Text color={color}>{formatBalanceLabel(balance)}</Text>;
}

function CachePill({
  ratio,
  cold,
  pct,
}: {
  ratio: number;
  cold: boolean;
  pct: number;
}): React.ReactElement {
  const color = ratio >= 0.7 ? COLOR.ok : ratio >= 0.4 ? COLOR.warn : COLOR.err;
  const filled = Math.max(0, Math.min(CACHE_BAR_CELLS, Math.round(ratio * CACHE_BAR_CELLS)));
  const empty = CACHE_BAR_CELLS - filled;
  return (
    <>
      <Text color={COLOR.info} dimColor>
        {"cache "}
      </Text>
      <Text color={cold ? COLOR.info : color} dimColor={cold}>
        {"█".repeat(filled)}
      </Text>
      <Text dimColor>{"░".repeat(empty)}</Text>
      <Text color={cold ? undefined : color} bold={!cold} dimColor={cold}>
        {cold && pct === 0 ? " —" : ` ${pct}%`}
      </Text>
    </>
  );
}

function pickModePill(
  planMode: boolean | undefined,
  preset: Preset | undefined,
): { label: string; color: string } | null {
  if (planMode) return { label: "PLAN", color: COLOR.err };
  if (!preset) return null;
  if (preset === "pro") return { label: "pro", color: COLOR.accent };
  if (preset === "flash") return { label: "flash", color: COLOR.info };
  return { label: "auto", color: COLOR.primary };
}

function sessionCostColor(cost: number): string | undefined {
  if (cost <= 0) return undefined;
  if (cost >= 5) return COLOR.err;
  if (cost >= 0.5) return COLOR.warn;
  return COLOR.ok;
}

function basename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i === -1 ? norm : norm.slice(i + 1);
}
