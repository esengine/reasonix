/**
 * Bridge: register an MCP server's tools into a Reasonix ToolRegistry.
 *
 * This is the integration surface. Once done, `CacheFirstLoop` sees the
 * MCP tools as if they were native — they inherit Cache-First + repair
 * (scavenge / truncation / storm) automatically. That's the payoff: any
 * MCP ecosystem tool, wrapped in Reasonix's Pillar 1 + Pillar 3 benefits.
 */

import { ToolRegistry } from "../tools.js";
import type { JSONSchema } from "../types.js";
import type { McpClient } from "./client.js";
import type { CallToolResult, McpContentBlock } from "./types.js";

export interface BridgeOptions {
  /**
   * Prefix prepended to every MCP tool name when registered. Defaults to
   * empty (no prefix). Useful when bridging multiple servers into one
   * registry and names collide — e.g. `fs` + `gh` both exposing `search`.
   */
  namePrefix?: string;
  /** Registry to populate. Creates a fresh one if omitted. */
  registry?: ToolRegistry;
  /** Auto-flatten deep schemas (Pillar 3). Defaults to the registry's own default (true). */
  autoFlatten?: boolean;
}

export interface BridgeResult {
  registry: ToolRegistry;
  /** Names actually registered (may differ from MCP names when a prefix is applied). */
  registeredNames: string[];
  /** Names the server listed but the bridge skipped (e.g. invalid schemas). */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Walk a connected `McpClient`'s tools/list result, register each into a
 * Reasonix `ToolRegistry`. Each registered `fn` proxies through the
 * client's tools/call. Tool results are flattened into a string (joining
 * text blocks with newlines, prefixing image blocks as placeholders) so
 * they fit Reasonix's existing tool-dispatch contract.
 */
export async function bridgeMcpTools(
  client: McpClient,
  opts: BridgeOptions = {},
): Promise<BridgeResult> {
  const registry = opts.registry ?? new ToolRegistry({ autoFlatten: opts.autoFlatten });
  const prefix = opts.namePrefix ?? "";
  const result: BridgeResult = { registry, registeredNames: [], skipped: [] };

  const listed = await client.listTools();
  for (const mcpTool of listed.tools) {
    if (!mcpTool.name) {
      result.skipped.push({ name: "?", reason: "empty tool name" });
      continue;
    }
    const registeredName = `${prefix}${mcpTool.name}`;
    registry.register({
      name: registeredName,
      description: mcpTool.description ?? "",
      parameters: mcpTool.inputSchema as JSONSchema,
      fn: async (args: Record<string, unknown>) => {
        const toolResult = await client.callTool(mcpTool.name, args);
        return flattenMcpResult(toolResult);
      },
    });
    result.registeredNames.push(registeredName);
  }
  return result;
}

/**
 * Turn an MCP CallToolResult into a string — the contract Reasonix's
 * ToolRegistry.dispatch returns. We:
 *   - join text blocks with newlines (most common case)
 *   - stringify image blocks as placeholders (LLM can't use bytes anyway
 *     in Reasonix's current surface; image support comes with multimodal
 *     prompts later)
 *   - prefix error results with "ERROR: " so the calling model sees the
 *     failure clearly even through JSON mode
 */
export function flattenMcpResult(result: CallToolResult): string {
  const parts = result.content.map(blockToString);
  const joined = parts.join("\n").trim();
  if (result.isError) {
    return `ERROR: ${joined || "(no error message from server)"}`;
  }
  return joined;
}

function blockToString(block: McpContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") return `[image ${block.mimeType}, ${block.data.length} chars base64]`;
  // Unknown block type — preserve for diagnostics.
  return `[unknown block: ${JSON.stringify(block)}]`;
}
