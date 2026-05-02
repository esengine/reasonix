/** Applies an MCP append-drift mid-session: registers each new tool in the loop's registry + prefix, and updates the summary's report. */

import type { CacheFirstLoop } from "../../loop.js";
import { registerSingleMcpTool } from "../../mcp/registry.js";
import type { McpTool } from "../../mcp/types.js";
import type { JSONSchema, ToolSpec } from "../../types.js";
import type { McpServerSummary } from "./slash/types.js";

export function applyMcpAppend(
  loop: CacheFirstLoop,
  target: McpServerSummary,
  addedTools: McpTool[],
): void {
  const accepted: McpTool[] = [];
  for (const mcpTool of addedTools) {
    if (!mcpTool.name) continue;
    const registeredName = registerSingleMcpTool(mcpTool, target.bridgeEnv);
    if (!registeredName) continue;
    const spec: ToolSpec = {
      type: "function",
      function: {
        name: registeredName,
        description: mcpTool.description ?? "",
        parameters: mcpTool.inputSchema as unknown as JSONSchema,
      },
    };
    loop.prefix.addTool(spec);
    accepted.push(mcpTool);
  }
  if (accepted.length === 0) return;
  // Refresh the summary's snapshot so `/mcp` and the browser modal show the
  // new shape on their next render.
  if (target.report.tools.supported) {
    const merged = [...target.report.tools.items, ...accepted];
    // biome-ignore lint/suspicious/noExplicitAny: report is a typed snapshot we mutate in place; deeper refactor isn't worth it here
    (target.report.tools as any).items = merged;
    // biome-ignore lint/suspicious/noExplicitAny: same — toolCount mirrors items.length post-append
    (target as any).toolCount = merged.length;
  }
}
