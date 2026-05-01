/** Bundled GET — avoids 6 round-trips per 2s poll; runtime fields null in standalone mode. */

import { readConfig } from "../../config.js";
import { indexExists } from "../../index/semantic/builder.js";
import { VERSION } from "../../version.js";
import type { DashboardContext, DashboardStats } from "../context.js";
import type { ApiResult } from "../router.js";
import { type CockpitData, computeCockpit } from "./cockpit.js";

export interface OverviewResponse {
  /** Reasonix version string (drives the "vs latest" comparison in the SPA). */
  version: string;
  /** Current runtime mode — drives whether the SPA hides "live-only" controls. */
  mode: "standalone" | "attached";
  /** Latest published version, or null when the background fetch hasn't resolved. */
  latestVersion: string | null;
  session: string | null;
  cwd: string | null;
  model: string | null;
  editMode: string | null;
  planMode: boolean | null;
  pendingEdits: number | null;
  /** When attached, count of MCP servers currently bridged. */
  mcpServerCount: number | null;
  /** Total registered tools (builtin + MCP-bridged + skill tools). */
  toolCount: number | null;
  preset: string;
  /** Persisted reasoning_effort (high / max). Same rationale as preset. */
  reasoningEffort: string;
  /** Live session stats — null in standalone mode. */
  stats: DashboardStats | null;
  semanticIndexExists: boolean | null;
  cockpit: CockpitData;
}

export async function handleOverview(
  method: string,
  _rest: string[],
  _body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  if (method !== "GET") {
    return { status: 405, body: { error: "GET only" } };
  }
  const cfg = readConfig(ctx.configPath);
  const cwd = ctx.getCurrentCwd?.() ?? null;
  const semanticIndexExists = cwd ? await indexExists(cwd).catch(() => false) : null;
  const overview: OverviewResponse = {
    version: VERSION,
    mode: ctx.mode,
    latestVersion: ctx.getLatestVersion?.() ?? null,
    session: ctx.getSessionName?.() ?? null,
    cwd,
    model: ctx.loop?.model ?? null,
    editMode: ctx.getEditMode?.() ?? null,
    planMode: ctx.getPlanMode?.() ?? null,
    pendingEdits: ctx.getPendingEditCount?.() ?? null,
    mcpServerCount: ctx.mcpServers?.length ?? null,
    toolCount: ctx.tools ? ctx.tools.size : null,
    preset: cfg.preset ?? "auto",
    reasoningEffort: cfg.reasoningEffort ?? "max",
    stats: ctx.getStats?.() ?? null,
    semanticIndexExists,
    cockpit: computeCockpit(ctx),
  };
  return { status: 200, body: overview };
}
