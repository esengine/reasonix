/** Reasonix — DeepSeek-native agent framework. Library entry point. */

export { DeepSeekClient, Usage } from "./client.js";
export type { ChatResponse, StreamChunk, DeepSeekClientOptions } from "./client.js";

export {
  CacheFirstLoop,
  formatLoopError,
  healLoadedMessages,
  stripHallucinatedToolMarkup,
} from "./loop.js";
export type {
  CacheFirstLoopOptions,
  LoopEvent,
  EventRole,
  BranchSummary,
  BranchProgress,
  ReconfigurableOptions,
} from "./loop.js";

export { runBranches, defaultSelector, aggregateBranchUsage } from "./consistency.js";
export type {
  BranchOptions,
  BranchSample,
  BranchResult,
  BranchSelector,
} from "./consistency.js";

export { ImmutablePrefix, AppendOnlyLog, VolatileScratch } from "./memory.js";
export type { ImmutablePrefixOptions } from "./memory.js";

export {
  PROJECT_MEMORY_FILE,
  PROJECT_MEMORY_MAX_CHARS,
  applyProjectMemory,
  memoryEnabled,
  readProjectMemory,
} from "./project-memory.js";
export type { ProjectMemory } from "./project-memory.js";

export { ToolRegistry } from "./tools.js";
export type { ToolDefinition, ToolCallContext } from "./tools.js";
export { registerFilesystemTools } from "./tools/filesystem.js";
export type { FilesystemToolsOptions } from "./tools/filesystem.js";
export {
  NeedsConfirmationError,
  formatCommandResult,
  isAllowed,
  registerShellTools,
  runCommand,
  tokenizeCommand,
} from "./tools/shell.js";
export type { RunCommandResult, ShellToolsOptions } from "./tools/shell.js";
export {
  formatSearchResults,
  htmlToText,
  parseMojeekResults,
  registerWebTools,
  webFetch,
  webSearch,
} from "./tools/web.js";
export type {
  PageContent,
  SearchResult,
  WebFetchOptions,
  WebSearchOptions,
  WebToolsOptions,
} from "./tools/web.js";

export {
  SessionStats,
  costUsd,
  inputCostUsd,
  outputCostUsd,
  claudeEquivalentCost,
} from "./telemetry.js";
export type { TurnStats, SessionSummary } from "./telemetry.js";

export {
  ToolCallRepair,
  scavengeToolCalls,
  repairTruncatedJson,
  StormBreaker,
  analyzeSchema,
  flattenSchema,
  nestArguments,
} from "./repair/index.js";
export type {
  RepairReport,
  ToolCallRepairOptions,
  ScavengeOptions,
  ScavengeResult,
  TruncationRepairResult,
  FlattenDecision,
} from "./repair/index.js";

export { harvest, emptyPlanState, isPlanStateEmpty } from "./harvest.js";
export type { TypedPlanState, HarvestOptions } from "./harvest.js";

export {
  appendSessionMessage,
  deleteSession,
  listSessions,
  loadSessionMessages,
  sanitizeName as sanitizeSessionName,
  sessionPath,
  sessionsDir,
} from "./session.js";
export type { SessionInfo } from "./session.js";

export { loadDotenv } from "./env.js";

export {
  openTranscriptFile,
  parseTranscript,
  readTranscript,
  recordFromLoopEvent,
  writeMeta,
  writeRecord,
} from "./transcript.js";
export type { TranscriptRecord, TranscriptMeta, ReadTranscriptResult } from "./transcript.js";

export { computeReplayStats, replayFromFile } from "./replay.js";
export type { ReplayStats } from "./replay.js";

export {
  diffTranscripts,
  renderMarkdown as renderDiffMarkdown,
  renderSummaryTable as renderDiffSummary,
  similarity,
} from "./diff.js";
export type { DiffReport, DiffSide, TurnPair, RenderOptions as DiffRenderOptions } from "./diff.js";

// ---------- MCP (v0.3 foundation) ----------
export { McpClient } from "./mcp/client.js";
export type { McpClientOptions } from "./mcp/client.js";
export { StdioTransport } from "./mcp/stdio.js";
export type { McpTransport, StdioTransportOptions } from "./mcp/stdio.js";
export { SseTransport } from "./mcp/sse.js";
export type { SseTransportOptions } from "./mcp/sse.js";
export {
  DEFAULT_MAX_RESULT_CHARS,
  bridgeMcpTools,
  flattenMcpResult,
  truncateForModel,
} from "./mcp/registry.js";
export type { BridgeOptions, BridgeResult, FlattenOptions } from "./mcp/registry.js";
export { parseMcpSpec } from "./mcp/spec.js";
export type { McpSpec, StdioMcpSpec, SseMcpSpec } from "./mcp/spec.js";
export { inspectMcpServer } from "./mcp/inspect.js";
export type { InspectionReport, SectionResult } from "./mcp/inspect.js";

// ---------- code mode (v0.3 — `reasonix code`) ----------
export {
  parseEditBlocks,
  applyEditBlock,
  applyEditBlocks,
  snapshotBeforeEdits,
  restoreSnapshots,
} from "./code/edit-blocks.js";
export type {
  EditBlock,
  ApplyResult,
  ApplyStatus,
  EditSnapshot,
} from "./code/edit-blocks.js";
export { CODE_SYSTEM_PROMPT, codeSystemPrompt } from "./code/prompt.js";
export {
  MCP_PROTOCOL_VERSION,
  isJsonRpcError,
} from "./mcp/types.js";
export type {
  McpTool,
  McpToolSchema,
  CallToolResult,
  ListToolsResult,
  McpContentBlock,
  InitializeResult,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcMessage,
  McpResource,
  McpResourceContents,
  McpResourceContentsText,
  McpResourceContentsBlob,
  ListResourcesResult,
  ReadResourceResult,
  McpPrompt,
  McpPromptArgument,
  McpPromptMessage,
  McpPromptResourceBlock,
  ListPromptsResult,
  GetPromptResult,
  McpProgressHandler,
  McpProgressInfo,
  ProgressNotificationParams,
} from "./mcp/types.js";

export { fetchWithRetry } from "./retry.js";
export type { RetryOptions, RetryInfo } from "./retry.js";

export {
  defaultConfigPath,
  isPlausibleKey,
  loadApiKey,
  readConfig,
  redactKey,
  saveApiKey,
  writeConfig,
} from "./config.js";
export type { ReasonixConfig } from "./config.js";

export type {
  ChatMessage,
  ToolCall,
  ToolSpec,
  ToolFunctionSpec,
  Role,
  JSONSchema,
} from "./types.js";

export const VERSION = "0.4.17";
