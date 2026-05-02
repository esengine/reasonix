/** `/mcp reconnect` — open a fresh client, accept identity drift only, refuse the rest cleanly. */

import { McpClient } from "./client.js";
import { classifyToolListDrift } from "./drift.js";
import type { McpClientHost } from "./registry.js";
import { type McpSpec, parseMcpSpec } from "./spec.js";
import { SseTransport } from "./sse.js";
import { type McpTransport, StdioTransport } from "./stdio.js";
import { StreamableHttpTransport } from "./streamable-http.js";
import type { McpTool } from "./types.js";

export interface ReconnectArgs {
  /** Live host whose `client` will be swapped on success. */
  host: McpClientHost;
  /** Original `--mcp` spec string the server was launched with. Re-parsed to rebuild transport. */
  spec: string;
  /** The current tool list, used as the drift baseline. */
  beforeTools: readonly McpTool[];
}

export type ReconnectResult =
  | { ok: true; afterTools: McpTool[]; ms: number }
  | {
      ok: false;
      reason:
        | "spec_parse"
        | "handshake"
        | "drift_added"
        | "drift_edited"
        | "drift_reordered"
        | "drift_removed";
      message: string;
      ms: number;
    };

export async function reconnectMcpServer(args: ReconnectArgs): Promise<ReconnectResult> {
  const t0 = Date.now();
  let parsed: McpSpec;
  try {
    parsed = parseMcpSpec(args.spec);
  } catch (err) {
    return {
      ok: false,
      reason: "spec_parse",
      message: (err as Error).message,
      ms: Date.now() - t0,
    };
  }
  const transport: McpTransport =
    parsed.transport === "sse"
      ? new SseTransport({ url: parsed.url })
      : parsed.transport === "streamable-http"
        ? new StreamableHttpTransport({ url: parsed.url })
        : new StdioTransport({ command: parsed.command, args: parsed.args });
  const next = new McpClient({ transport });
  try {
    await next.initialize();
    const listed = await next.listTools();
    const drift = classifyToolListDrift(toolsToSpecs(args.beforeTools), toolsToSpecs(listed.tools));
    if (drift.kind !== "identity") {
      // The new client is fine but its tool surface differs — accepting it
      // would either mutate the registry/prefix (we don't do that yet) or
      // silently break the cache invariant. Close the new handle and leave
      // the old one in place untouched.
      await next.close().catch(() => {});
      return {
        ok: false,
        reason: driftReason(drift.kind),
        message: driftMessage(drift),
        ms: Date.now() - t0,
      };
    }
    // Identity drift — safe to swap.
    const old = args.host.client;
    args.host.client = next;
    await old.close().catch(() => {});
    return { ok: true, afterTools: listed.tools, ms: Date.now() - t0 };
  } catch (err) {
    await next.close().catch(() => {});
    return {
      ok: false,
      reason: "handshake",
      message: (err as Error).message,
      ms: Date.now() - t0,
    };
  }
}

function driftReason(
  kind: Exclude<ReturnType<typeof classifyToolListDrift>["kind"], "identity">,
): "drift_added" | "drift_edited" | "drift_reordered" | "drift_removed" {
  if (kind === "append") return "drift_added";
  if (kind === "edit") return "drift_edited";
  if (kind === "reorder") return "drift_reordered";
  return "drift_removed";
}

function driftMessage(drift: ReturnType<typeof classifyToolListDrift>): string {
  if (drift.kind === "append") {
    return `tool list grew (${drift.added.length} added: ${drift.added.join(", ")}). Restart Reasonix to bridge the new tool(s).`;
  }
  if (drift.kind === "edit") {
    return `tool description/schema changed for ${drift.edited.join(", ")}. Restart Reasonix to apply.`;
  }
  if (drift.kind === "remove") {
    return `tool(s) removed: ${drift.removed.join(", ")}. Restart Reasonix to drop them from the registry.`;
  }
  return "tool list reordered or restructured — cache prefix would be invalidated. Restart Reasonix.";
}

function toolsToSpecs(tools: readonly McpTool[]): import("../types.js").ToolSpec[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema as unknown as import("../types.js").JSONSchema,
    },
  }));
}
