import { countTokens } from "../tokenizer.js";
import { ToolRegistry } from "../tools.js";
import type { JSONSchema } from "../types.js";
import type { McpClient } from "./client.js";
import { LatencyTracker, type SlowEvent } from "./latency.js";
import type { CallToolResult, McpContentBlock } from "./types.js";

export interface BridgeOptions {
  /** Prefix for tool names — disambiguates collisions when bridging multiple servers. */
  namePrefix?: string;
  /** Registry to populate. Creates a fresh one if omitted. */
  registry?: ToolRegistry;
  /** Auto-flatten deep schemas (Pillar 3). Defaults to the registry's own default (true). */
  autoFlatten?: boolean;
  /** Cap on tool result chars; head+tail truncation. Floor against context-poisoning oversized reads. */
  maxResultChars?: number;
  /** Absent → no `_meta.progressToken` sent and server won't emit progress. */
  onProgress?: (info: {
    toolName: string;
    progress: number;
    total?: number;
    message?: string;
  }) => void;
  /** Server name used to tag latency samples + slow events. Falls through to namePrefix without trailing `_`. */
  serverName?: string;
  /** p95 cutoff in ms before a slow event fires — defaults to 4000. */
  slowThresholdMs?: number;
  /** Fired exactly when the per-server p95 transitions over `slowThresholdMs`. */
  onSlow?: (ev: SlowEvent) => void;
  /** Indirection so reconnect can swap the underlying client without re-registering tools. */
  host?: McpClientHost;
}

/** Mutable holder so `/mcp reconnect` can swap the underlying client without re-bridging tools. */
export interface McpClientHost {
  client: McpClient;
}

export const DEFAULT_MAX_RESULT_CHARS = 32_000;

/** ~6% of DeepSeek V3 context. Char cap alone fails on CJK (~1 char/token). */
export const DEFAULT_MAX_RESULT_TOKENS = 8_000;

export interface BridgeResult {
  registry: ToolRegistry;
  /** Names actually registered (may differ from MCP names when a prefix is applied). */
  registeredNames: string[];
  /** Names the server listed but the bridge skipped (e.g. invalid schemas). */
  skipped: Array<{ name: string; reason: string }>;
}

/** Resolved bridge environment that `registerSingleMcpTool` needs. Stored on summaries so reconnect can append new tools later. */
export interface BridgeEnv {
  registry: ToolRegistry;
  host: McpClientHost;
  prefix: string;
  maxResultChars: number;
  tracker: LatencyTracker | null;
  onProgress?: BridgeOptions["onProgress"];
}

/** Register one MCP tool's bridged closure into the registry. Returns the registered name (or "" if skipped). */
export function registerSingleMcpTool(
  mcpTool: import("./types.js").McpTool,
  env: BridgeEnv,
): string {
  if (!mcpTool.name) return "";
  const registeredName = `${env.prefix}${mcpTool.name}`;
  env.registry.register({
    name: registeredName,
    description: mcpTool.description ?? "",
    parameters: mcpTool.inputSchema as JSONSchema,
    fn: async (args: Record<string, unknown>, ctx) => {
      const t0 = env.tracker ? Date.now() : 0;
      // Resolve client at call time via the host indirection so `/mcp reconnect`
      // can swap a fresh client in without re-bridging tools.
      const live = env.host.client;
      const toolResult = await live.callTool(mcpTool.name, args, {
        onProgress: env.onProgress
          ? (info) => env.onProgress!({ toolName: registeredName, ...info })
          : undefined,
        signal: ctx?.signal,
      });
      if (env.tracker) env.tracker.record(Date.now() - t0);
      return flattenMcpResult(toolResult, { maxChars: env.maxResultChars });
    },
  });
  return registeredName;
}

export async function bridgeMcpTools(
  client: McpClient,
  opts: BridgeOptions = {},
): Promise<BridgeResult & { env: BridgeEnv }> {
  const registry = opts.registry ?? new ToolRegistry({ autoFlatten: opts.autoFlatten });
  const prefix = opts.namePrefix ?? "";
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const result: BridgeResult = { registry, registeredNames: [], skipped: [] };

  const serverName = opts.serverName ?? prefix.replace(/_$/, "") ?? "anon";
  const tracker = opts.onSlow
    ? new LatencyTracker(serverName, { thresholdMs: opts.slowThresholdMs, onSlow: opts.onSlow })
    : null;
  // Synthesize a host on the fly when the caller didn't provide one. Older
  // callers (tests, single-shot non-reconnectable bridges) get the live
  // `client` reference frozen in; reconnect-aware callers pass their own
  // mutable host.
  const host: McpClientHost = opts.host ?? { client };
  const env: BridgeEnv = {
    registry,
    host,
    prefix,
    maxResultChars,
    tracker,
    onProgress: opts.onProgress,
  };
  const listed = await client.listTools();
  for (const mcpTool of listed.tools) {
    if (!mcpTool.name) {
      result.skipped.push({ name: "?", reason: "empty tool name" });
      continue;
    }
    const registeredName = registerSingleMcpTool(mcpTool, env);
    if (registeredName) result.registeredNames.push(registeredName);
  }
  return { ...result, env };
}

export interface FlattenOptions {
  /** Cap the flattened string at this many characters. Default: no cap. */
  maxChars?: number;
}

export function flattenMcpResult(result: CallToolResult, opts: FlattenOptions = {}): string {
  const parts = result.content.map(blockToString);
  const joined = parts.join("\n").trim();
  const prefixed = result.isError ? `ERROR: ${joined || "(no error message from server)"}` : joined;
  return opts.maxChars ? truncateForModel(prefixed, opts.maxChars) : prefixed;
}

/** Head + 1KB tail so error messages at end of stack traces aren't lost. */
export function truncateForModel(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const tailBudget = Math.min(1024, Math.floor(maxChars * 0.1));
  const headBudget = Math.max(0, maxChars - tailBudget);
  const head = s.slice(0, headBudget);
  const tail = s.slice(-tailBudget);
  const dropped = s.length - head.length - tail.length;
  return `${head}\n\n[…truncated ${dropped} chars — raise BridgeOptions.maxResultChars, or call the tool with a narrower scope (filter, head, pagination)…]\n\n${tail}`;
}

/** Never tokenizes full input — pathological repetitive text (`AAAA…`) costs 30s+ on the pure-TS BPE port. */
export function truncateForModelByTokens(s: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  // Every token is ≥1 char — if length ≤ budget, tokens ≤ budget.
  if (s.length <= maxTokens) return s;
  // Small enough to tokenize-check without pathological cost: confirm
  // whether we're actually over budget. (Threshold is the char-bound
  // worst case for English/code — ~4 chars/token.)
  if (s.length <= maxTokens * 4) {
    const tokens = countTokens(s);
    if (tokens <= maxTokens) return s;
  }

  const markerOverhead = 48; // rough token cost of the truncation marker
  const contentBudget = Math.max(0, maxTokens - markerOverhead);
  const tailBudget = Math.min(256, Math.floor(contentBudget * 0.1));
  const headBudget = Math.max(0, contentBudget - tailBudget);

  const head = sizePrefixToTokens(s, headBudget);
  const tail = sizeSuffixToTokens(s, tailBudget);
  const droppedChars = s.length - head.length - tail.length;
  // Estimate dropped tokens from the per-slice char/token ratio we
  // already measured, rather than paying another full-string tokenize.
  // The marker says "~N tokens" so the ≤10% slop is visible to readers.
  const headTokens = head ? countTokens(head) : 0;
  const tailTokens = tail ? countTokens(tail) : 0;
  const sampleChars = head.length + tail.length;
  const sampleTokens = headTokens + tailTokens;
  const ratio = sampleChars > 0 ? sampleTokens / sampleChars : 0.3;
  const estTotalTokens = Math.ceil(s.length * ratio);
  const droppedTokens = Math.max(0, estTotalTokens - sampleTokens);
  return `${head}\n\n[…truncated ~${droppedTokens} tokens (${droppedChars} chars) — raise BridgeOptions.maxResultTokens, or call the tool with a narrower scope (filter, head, pagination)…]\n\n${tail}`;
}

function sizePrefixToTokens(s: string, budget: number): string {
  if (budget <= 0 || s.length === 0) return "";
  // Optimistic starting size: assume ~4 chars/token (English/code
  // average). If the content is denser (CJK ~1 char/token), the first
  // tokenize will show we're over and we shrink.
  let size = Math.min(s.length, budget * 4);
  for (let iter = 0; iter < 6; iter++) {
    if (size <= 0) return "";
    const slice = s.slice(0, size);
    const count = countTokens(slice);
    if (count <= budget) return slice;
    // Shrink by the overshoot fraction plus a small safety margin.
    const next = Math.floor(size * (budget / count) * 0.95);
    if (next >= size) return s.slice(0, Math.max(0, size - 1));
    size = next;
  }
  return s.slice(0, Math.max(0, size));
}

/** Slice `s` from the end to the largest suffix that fits `budget` tokens. */
function sizeSuffixToTokens(s: string, budget: number): string {
  if (budget <= 0 || s.length === 0) return "";
  let size = Math.min(s.length, budget * 4);
  for (let iter = 0; iter < 6; iter++) {
    if (size <= 0) return "";
    const slice = s.slice(-size);
    const count = countTokens(slice);
    if (count <= budget) return slice;
    const next = Math.floor(size * (budget / count) * 0.95);
    if (next >= size) return s.slice(-Math.max(0, size - 1));
    size = next;
  }
  return s.slice(-Math.max(0, size));
}

function blockToString(block: McpContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") return `[image ${block.mimeType}, ${block.data.length} chars base64]`;
  // Unknown block type — preserve for diagnostics.
  return `[unknown block: ${JSON.stringify(block)}]`;
}
