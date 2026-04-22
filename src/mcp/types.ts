/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Hand-rolled rather than importing @modelcontextprotocol/sdk because:
 *   - Reasonix's value-add isn't reimplementing the protocol, but *caching*
 *     it. Owning the types lets us tune them for our integration (strip
 *     fields we don't use, add the ones we do like Reasonix's prefixHash).
 *   - Zero dependencies — consistent with how we wrote the DeepSeek client.
 *   - If Anthropic bumps the SDK and introduces a breaking change, we're
 *     insulated as long as we keep up with the spec itself.
 *
 * Spec reference: https://spec.modelcontextprotocol.io/ (2024-11-05 draft
 * at time of writing). Only the subset Reasonix consumes is modeled here —
 * tools list/call + init handshake. Resources and prompts are deferred.
 *
 * Transport note: the wire format for stdio MCP is **newline-delimited
 * JSON** (NDJSON), not the LSP-style Content-Length header framing that
 * some readers might expect. One JSON-RPC message per line.
 */

// ---------- JSON-RPC 2.0 base ----------

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    /** JSON-RPC standard codes: -32700 parse, -32600 invalid request, -32601 method not found, -32602 invalid params, -32603 internal. MCP also defines its own range. */
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

// ---------- MCP initialize ----------

export interface McpClientInfo {
  name: string;
  version: string;
}

export interface McpClientCapabilities {
  /** Empty object advertises support without any optional sub-features. */
  tools?: Record<string, never>;
  // resources / prompts / sampling would go here — deferred.
}

export interface InitializeParams {
  protocolVersion: string;
  capabilities: McpClientCapabilities;
  clientInfo: McpClientInfo;
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: unknown;
    prompts?: unknown;
  };
  instructions?: string;
}

// ---------- MCP tools ----------

export interface McpToolSchema {
  /** JSON Schema — compatible with Reasonix's tools.ts JSONSchema shape. */
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [extra: string]: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  /** MCP calls this `inputSchema`. Reasonix's `parameters` field is the same concept. */
  inputSchema: McpToolSchema;
}

export interface ListToolsResult {
  tools: McpTool[];
  nextCursor?: string;
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpContentBlockText {
  type: "text";
  text: string;
}

export interface McpContentBlockImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** MCP result content is an array of typed blocks. Reasonix consumes only text for now — image blocks get stringified with a placeholder. */
export type McpContentBlock = McpContentBlockText | McpContentBlockImage;

export interface CallToolResult {
  content: McpContentBlock[];
  /** True = tool raised an error; the content describes it. */
  isError?: boolean;
}

// ---------- convenience ----------

/** Current MCP protocol version Reasonix is coded against. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Type guard — success vs error response. */
export function isJsonRpcError(msg: JsonRpcResponse): msg is JsonRpcError {
  return "error" in msg;
}
