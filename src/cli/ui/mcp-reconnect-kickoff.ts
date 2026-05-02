/** Shared async-fire-and-forget reconnect trigger — called by both `/mcp reconnect` and the McpBrowser `r` keybind. */

import { reconnectMcpServer } from "../../mcp/reconnect.js";
import { formatMcpLifecycleEvent } from "./mcp-lifecycle.js";
import type { McpServerSummary } from "./slash/types.js";

/** Kicks off async reconnect; returns the start-line, schedules result via postInfo. */
export function kickOffMcpReconnect(
  target: McpServerSummary,
  postInfo: (text: string) => void,
): string {
  const beforeTools = target.report.tools.supported ? target.report.tools.items : [];
  void (async () => {
    try {
      const result = await reconnectMcpServer({
        host: target.host,
        spec: target.spec,
        beforeTools,
      });
      if (result.ok) {
        postInfo(
          formatMcpLifecycleEvent({
            state: "connected",
            name: target.label,
            tools: beforeTools.length,
            ms: result.ms,
          }),
        );
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
