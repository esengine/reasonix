/** Single allocator for vertical viewport rows; consumers claim per-zone via useReserveRows. */

import { useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React, { createContext, useContext, useEffect, useMemo, useReducer } from "react";

export type ZoneId = "modal" | "plan-card" | "status" | "input" | "stream" | "safety";

/** Higher number = claims rows first. */
const ZONE_PRIORITY: Record<ZoneId, number> = {
  modal: 100,
  "plan-card": 80,
  status: 60,
  input: 50,
  stream: 10,
  safety: 5,
};

export interface ClaimSpec {
  /** Smallest acceptable allocation. May exceed total rows on tiny terminals. */
  min: number;
  /** Hard ceiling. `Number.POSITIVE_INFINITY` = "soak whatever's left". */
  max: number;
}

interface InternalClaim extends ClaimSpec {
  zone: ZoneId;
  priority: number;
}

/** Pure allocator — used by the provider and tested in isolation. */
export function allocateRows(
  claims: ReadonlyArray<InternalClaim>,
  totalRows: number,
): ReadonlyMap<ZoneId, number> {
  const sorted = [...claims].sort((a, b) => b.priority - a.priority);
  const out = new Map<ZoneId, number>();
  let remaining = Math.max(0, totalRows);
  for (const c of sorted) {
    const want = Math.min(c.max, Math.max(c.min, remaining));
    out.set(c.zone, want);
    remaining = Math.max(0, remaining - want);
  }
  return out;
}

interface BudgetState {
  /** Active claims keyed by zone — one consumer per zone. */
  claims: ReadonlyMap<ZoneId, ClaimSpec>;
  totalRows: number;
}

type BudgetAction =
  | { type: "claim"; zone: ZoneId; spec: ClaimSpec }
  | { type: "release"; zone: ZoneId }
  | { type: "resize"; rows: number };

function reducer(state: BudgetState, action: BudgetAction): BudgetState {
  switch (action.type) {
    case "claim": {
      const next = new Map(state.claims);
      next.set(action.zone, action.spec);
      return { ...state, claims: next };
    }
    case "release": {
      if (!state.claims.has(action.zone)) return state;
      const next = new Map(state.claims);
      next.delete(action.zone);
      return { ...state, claims: next };
    }
    case "resize":
      if (action.rows === state.totalRows) return state;
      return { ...state, totalRows: action.rows };
  }
}

interface BudgetContextValue {
  totalRows: number;
  allocations: ReadonlyMap<ZoneId, number>;
  claims: ReadonlyMap<ZoneId, ClaimSpec>;
  dispatch: React.Dispatch<BudgetAction>;
}

const BudgetContext = createContext<BudgetContextValue | null>(null);

export interface ViewportBudgetProviderProps {
  children: React.ReactNode;
  /** Test seam — bypasses useStdout. */
  initialRows?: number;
}

export function ViewportBudgetProvider({
  children,
  initialRows,
}: ViewportBudgetProviderProps): React.ReactElement {
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    claims: new Map<ZoneId, ClaimSpec>(),
    totalRows: initialRows ?? stdout?.rows ?? 40,
  }));

  // Single resize listener — children read totalRows from context.
  useEffect(() => {
    if (initialRows !== undefined) return undefined;
    if (!stdout) return undefined;
    const onResize = () => dispatch({ type: "resize", rows: stdout.rows ?? 40 });
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, initialRows]);

  const allocations = useMemo(() => {
    const list: InternalClaim[] = [];
    for (const [zone, spec] of state.claims) {
      list.push({ zone, priority: ZONE_PRIORITY[zone], ...spec });
    }
    return allocateRows(list, state.totalRows);
  }, [state.claims, state.totalRows]);

  const value = useMemo<BudgetContextValue>(
    () => ({
      totalRows: state.totalRows,
      allocations,
      claims: state.claims,
      dispatch,
    }),
    [state.totalRows, allocations, state.claims],
  );

  return <BudgetContext.Provider value={value}>{children}</BudgetContext.Provider>;
}

/** Returns actual allocation; falls back to spec.max when no provider is mounted. */
export function useReserveRows(zone: ZoneId, spec: ClaimSpec): number {
  const ctx = useContext(BudgetContext);
  // Deps key off dispatch (stable) + primitives — whole ctx changes every claim and would loop.
  const dispatch = ctx?.dispatch;

  useEffect(() => {
    if (!dispatch) return undefined;
    dispatch({ type: "claim", zone, spec: { min: spec.min, max: spec.max } });
    return () => {
      dispatch({ type: "release", zone });
    };
  }, [dispatch, zone, spec.min, spec.max]);

  if (!ctx) return Number.isFinite(spec.max) ? spec.max : 40;
  const allocated = ctx.allocations.get(zone);
  if (allocated !== undefined) return allocated;
  // Optimistic max for pre-effect first render.
  return Number.isFinite(spec.max) ? spec.max : ctx.totalRows;
}

/** Total terminal rows from the provider; falls back to useStdout if unmounted. */
export function useTotalRows(): number {
  const ctx = useContext(BudgetContext);
  const { stdout } = useStdout();
  return ctx?.totalRows ?? stdout?.rows ?? 40;
}

/** True when any modal-priority zone is claimed. Replaces the long !pendingShell && !pendingEdit && ... chains. */
export function useIsModalActive(): boolean {
  const ctx = useContext(BudgetContext);
  return ctx?.claims.has("modal") ?? false;
}
