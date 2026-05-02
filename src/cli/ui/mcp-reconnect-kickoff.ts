/** Shared async-fire-and-forget reconnect trigger — called by both `/mcp reconnect` and the McpBrowser `r` keybind. */

import { reconnectMcpServer } from "../../mcp/reconnect.js";
import type { McpTool } from "../../mcp/types.js";
import { formatMcpLifecycleEvent } from "./mcp-lifecycle.js";
import type { McpServerSummary } from "./slash/types.js";

/** Applies append-drift mid-session: registers each new MCP tool in the registry + prefix. */
export type ApplyAppend = (target: McpServerSummary, addedTools: McpTool[]) => void;

/** Kicks off async reconnect; returns the start-line, schedules result via postInfo. */
export function kickOffMcpReconnect(
  target: McpServerSummary,
  postInfo: (text: string) => void,
  applyAppend?: ApplyAppend,
): string {
  const beforeTools = target.report.tools.supported ? target.report.tools.items : [];
  // Only opt into "append" when the caller wired an applyAppend handler;
  // otherwise the reconnect refuses append-drift with a "restart" message.
  const accept = applyAppend ? (["identity", "append"] as const) : (["identity"] as const);
  void (async () => {
    try {
      const result = await reconnectMcpServer({
        host: target.host,
        spec: target.spec,
        beforeTools,
        accept,
      });
      if (result.ok) {
        if (result.kind === "append" && applyAppend) {
          applyAppend(target, result.addedTools);
        }
        postInfo(
          formatMcpLifecycleEvent({
            state: "connected",
            name: target.label,
            tools: result.afterTools.length,
            ms: result.ms,
          }),
        );
        if (result.kind === "append") {
          const names = result.addedTools.map((t) => t.name).join(", ");
          postInfo(`▸ ${target.label}: added ${result.addedTools.length} tool(s) — ${names}`);
        }
      } else {
        postInfo(
          formatMcpLifecycleEvent({
            state: "failed",
            name: target.label,
            reason: `${result.reason} · ${result.message}`,
          }),
        );
      }
    } catch (err) {
      postInfo(
        formatMcpLifecycleEvent({
          state: "failed",
          name: target.label,
          reason: (err as Error).message,
        }),
      );
    }
  })();
  return formatMcpLifecycleEvent({ state: "reconnect", name: target.label });
}
