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
 * at time of writing). Reasonix models the subset it consumes: tools
 * list/call, resources list/read, prompts list/get, plus the init
 * handshake. Sampling and progress notifications remain deferred.
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
  /** Advertised when the client can consume `resources/list` + `resources/read`. */
  resources?: Record<string, never>;
  /** Advertised when the client can consume `prompts/list` + `prompts/get`. */
  prompts?: Record<string, never>;
  // sampling would go here — deferred.
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
  /**
   * MCP's `_meta` envelope carries out-of-band protocol metadata.
   * Setting `progressToken` here tells the server "send me progress
   * notifications back using this token"; the server must then emit
   * `notifications/progress` frames until the response arrives.
   */
  _meta?: { progressToken?: string | number };
}

/**
 * Server → client notification emitted during a long-running request
 * that the client subscribed to via `_meta.progressToken`. `progress`
 * and `total` are typically matched units (files scanned, bytes
 * processed, etc.); `total` may be missing when the server can't
 * estimate the upper bound up front.
 */
export interface ProgressNotificationParams {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

/** Values a `ProgressHandler` receives — `progressToken` is already matched away. */
export interface McpProgressInfo {
  progress: number;
  total?: number;
  message?: string;
}

export type McpProgressHandler = (info: McpProgressInfo) => void;

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

// ---------- MCP resources ----------

/**
 * A resource the server can expose — think "file the model can read."
 * The URI is opaque to the client: servers may use `file://`, custom
 * schemes, or bare strings. Reasonix doesn't interpret them.
 */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  /** Hint for the content type (e.g. "text/markdown"). Purely informational. */
  mimeType?: string;
}

export interface ListResourcesParams {
  /** Pagination cursor from a previous listResources response. */
  cursor?: string;
}

export interface ListResourcesResult {
  resources: McpResource[];
  nextCursor?: string;
}

export interface ReadResourceParams {
  uri: string;
}

/**
 * One resource can return multiple content blobs (e.g. the file + a
 * side-car). `text` is the common case for UTF-8 content; `blob` is
 * base64-encoded bytes for binary content. Servers populate exactly
 * one of the two for each entry.
 */
export interface McpResourceContentsText {
  uri: string;
  mimeType?: string;
  text: string;
}

export interface McpResourceContentsBlob {
  uri: string;
  mimeType?: string;
  blob: string;
}

export type McpResourceContents = McpResourceContentsText | McpResourceContentsBlob;

export interface ReadResourceResult {
  contents: McpResourceContents[];
}

// ---------- MCP prompts ----------

/**
 * A parameterizable prompt template the server exposes. Clients fetch
 * it with `prompts/get` and pass the result to the model as-is.
 */
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface ListPromptsParams {
  cursor?: string;
}

export interface ListPromptsResult {
  prompts: McpPrompt[];
  nextCursor?: string;
}

export interface GetPromptParams {
  name: string;
  arguments?: Record<string, string>;
}

/**
 * MCP prompt messages are modeled after chat completions: role + content.
 * Content can be a text block OR (per the spec) a resource/image block;
 * Reasonix cares about text in v1, but surfaces the raw array so callers
 * can render other kinds if they need to.
 */
export interface McpPromptMessage {
  role: "user" | "assistant";
  content: McpContentBlock | McpPromptResourceBlock;
}

export interface McpPromptResourceBlock {
  type: "resource";
  resource: McpResourceContents;
}

export interface GetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

// ---------- convenience ----------

/** Current MCP protocol version Reasonix is coded against. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Type guard — success vs error response. */
export function isJsonRpcError(msg: JsonRpcResponse): msg is JsonRpcError {
  return "error" in msg;
}
