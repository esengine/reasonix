import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import type { SessionSummary } from "../../telemetry.js";
import { COLOR, GRADIENT } from "./theme.js";

const NARROW_BREAKPOINT = 120;
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
  const cols = stdout?.columns ?? 80;
  const narrow = cols < NARROW_BREAKPOINT;
  const cold = props.summary.turns <= COLD_START_TURNS;
  const projectName = props.rootDir ? basename(props.rootDir) : null;
  const mode = pickModePill(props.planMode, props.preset);
  const proPill = props.escalated
    ? { label: "⇧ pro", color: COLOR.err }
    : props.proArmed
      ? { label: "⇧ pro", color: COLOR.warn }
      : null;
  const showCache = props.summary.turns > COLD_START_TURNS && !narrow;
  const showBalance = !!props.balance && !narrow;

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
            {!narrow && props.sessionName ? (
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

        {props.scrollRatio !== undefined && props.scrollRatio > 0 ? (
          <>
            <Text color={COLOR.accent} bold>
              {`[↑ ${Math.round(props.scrollRatio * 100)}%]`}
            </Text>
            <Text> </Text>
          </>
        ) : null}
        {props.updateAvailable ? (
          <>
            <Text color={COLOR.warn} bold>{`↑ ${props.updateAvailable}`}</Text>
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
        {showBalance ? (
          <>
            <Text> </Text>
            <BalancePill balance={props.balance!} />
          </>
        ) : null}
        {showCache ? (
          <>
            <Text> </Text>
            <CachePill ratio={props.summary.cacheHitRatio} />
          </>
        ) : null}
      </Box>
      <ChromeRule />
    </Box>
  );
}

function ChromeRule(): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const w = Math.max(20, cols - 2);
  return <Text dimColor>{"─".repeat(w)}</Text>;
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
  const { currency, total } = balance;
  const color = total < 1 ? COLOR.err : total < 5 ? COLOR.warn : COLOR.ok;
  const sym = currency === "USD" ? "$" : currency === "CNY" ? "¥" : "";
  const suf = sym ? "" : ` ${currency}`;
  return <Text color={color}>{`w ${sym}${total.toFixed(2)}${suf}`}</Text>;
}

function CachePill({ ratio }: { ratio: number }): React.ReactElement {
  const color = ratio >= 0.7 ? COLOR.ok : ratio >= 0.4 ? COLOR.warn : COLOR.err;
  const filled = Math.max(0, Math.min(CACHE_BAR_CELLS, Math.round(ratio * CACHE_BAR_CELLS)));
  const empty = CACHE_BAR_CELLS - filled;
  return (
    <>
      <Text color={COLOR.info} dimColor>
        {"cache "}
      </Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(empty)}</Text>
      <Text color={color} bold>
        {` ${Math.round(ratio * 100)}%`}
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
