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
  /**
   * Per-tool-call result cap, in characters. If a tool returns more than
   * this, the result is truncated and a `[…truncated N chars…]` marker is
   * appended before the last KB so the model still sees a useful tail.
   * Defaults to {@link DEFAULT_MAX_RESULT_CHARS}.
   *
   * Why this exists: DeepSeek V3's context is 131,072 tokens. A single
   * `read_file` against a big source file can return >3 MB of text
   * (~900k tokens) and permanently poison the session — every subsequent
   * turn rebuilds the history and 400s. This cap is a floor. Users who
   * legitimately want bigger payloads can raise it explicitly.
   */
  maxResultChars?: number;
  /**
   * Callback fired for every `notifications/progress` frame the server
   * emits during any bridged tool call. Includes the registered
   * (prefix-applied) tool name so a multi-server UI can attribute
   * progress correctly. Absent → no `_meta.progressToken` is sent and
   * the server won't emit progress for these calls.
   */
  onProgress?: (info: {
    toolName: string;
    progress: number;
    total?: number;
    message?: string;
  }) => void;
}

/**
 * 32,000 chars ≈ 8k English tokens, or ~16k CJK tokens. Small enough to
 * fit comfortably in history even across 5–10 tool calls, large enough
 * that most file reads and directory listings fit un-truncated.
 */
export const DEFAULT_MAX_RESULT_CHARS = 32_000;

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
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
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
        const toolResult = await client.callTool(mcpTool.name, args, {
          // Forward server-side progress frames to the bridge caller,
          // tagged with the registered name so multi-server UIs can
          // disambiguate. No-op when `onProgress` isn't configured —
          // the client then also omits the _meta.progressToken and
          // the server won't emit progress.
          onProgress: opts.onProgress
            ? (info) => opts.onProgress!({ toolName: registeredName, ...info })
            : undefined,
        });
        return flattenMcpResult(toolResult, { maxChars: maxResultChars });
      },
    });
    result.registeredNames.push(registeredName);
  }
  return result;
}

export interface FlattenOptions {
  /** Cap the flattened string at this many characters. Default: no cap. */
  maxChars?: number;
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
 *   - optionally truncate to `maxChars` so a single oversized tool result
 *     (e.g. a big `read_file`) can't poison the session by blowing past
 *     the model's context window
 */
export function flattenMcpResult(result: CallToolResult, opts: FlattenOptions = {}): string {
  const parts = result.content.map(blockToString);
  const joined = parts.join("\n").trim();
  const prefixed = result.isError ? `ERROR: ${joined || "(no error message from server)"}` : joined;
  return opts.maxChars ? truncateForModel(prefixed, opts.maxChars) : prefixed;
}

/**
 * Keep the head AND a short tail so the model sees both "what the tool
 * started returning" and "how it ended". Head-only loses file endings
 * (e.g. an error message appended at the bottom of a stack trace); the
 * 1KB tail window covers that while costing almost nothing. Exported for
 * tests and reuse by non-MCP tool adapters that want the same policy.
 */
export function truncateForModel(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const tailBudget = Math.min(1024, Math.floor(maxChars * 0.1));
  const headBudget = Math.max(0, maxChars - tailBudget);
  const head = s.slice(0, headBudget);
  const tail = s.slice(-tailBudget);
  const dropped = s.length - head.length - tail.length;
  return `${head}\n\n[…truncated ${dropped} chars — raise BridgeOptions.maxResultChars, or call the tool with a narrower scope (filter, head, pagination)…]\n\n${tail}`;
}

function blockToString(block: McpContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") return `[image ${block.mimeType}, ${block.data.length} chars base64]`;
  // Unknown block type — preserve for diagnostics.
  return `[unknown block: ${JSON.stringify(block)}]`;
}
