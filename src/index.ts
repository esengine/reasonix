/** Reasonix — DeepSeek-native agent framework. Library entry point. */

export { DeepSeekClient, Usage } from "./client.js";
export type { ChatResponse, StreamChunk, DeepSeekClientOptions } from "./client.js";

export {
  CacheFirstLoop,
  formatLoopError,
  fixToolCallPairing,
  healLoadedMessages,
  healLoadedMessagesByTokens,
  stripHallucinatedToolMarkup,
} from "./loop.js";
export {
  AT_MENTION_PATTERN,
  AT_PICKER_PREFIX,
  DEFAULT_AT_MENTION_MAX_BYTES,
  DEFAULT_PICKER_IGNORE_DIRS,
  detectAtPicker,
  expandAtMentions,
  listFilesSync,
  listFilesWithStatsAsync,
  listFilesWithStatsSync,
  rankPickerCandidates,
} from "./at-mentions.js";
export type {
  AtMentionExpansion,
  AtMentionOptions,
  FileWithStats,
  ListFilesOptions,
  PickerCandidate,
  RankPickerOptions,
} from "./at-mentions.js";
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

export { ImmutablePrefix, AppendOnlyLog, VolatileScratch } from "./memory/runtime.js";
export type { ImmutablePrefixOptions } from "./memory/runtime.js";

export {
  PROJECT_MEMORY_FILE,
  PROJECT_MEMORY_MAX_CHARS,
  applyProjectMemory,
  memoryEnabled,
  readProjectMemory,
} from "./memory/project.js";
export type { ProjectMemory } from "./memory/project.js";

export {
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_MAX_CHARS,
  MemoryStore,
  USER_MEMORY_DIR,
  applyMemoryStack,
  applyUserMemory,
  projectHash,
  sanitizeMemoryName,
} from "./memory/user.js";
export type {
  MemoryEntry,
  MemoryScope,
  MemoryStoreOptions,
  MemoryType,
  WriteInput as MemoryWriteInput,
} from "./memory/user.js";

export { ToolRegistry } from "./tools.js";
export type { ToolDefinition, ToolCallContext } from "./tools.js";
export { registerFilesystemTools } from "./tools/filesystem.js";
export type { FilesystemToolsOptions } from "./tools/filesystem.js";
export { registerMemoryTools } from "./tools/memory.js";
export type { MemoryToolsOptions } from "./tools/memory.js";
export { ChoiceRequestedError, registerChoiceTool } from "./tools/choice.js";
export type { ChoiceOption, ChoiceToolOptions } from "./tools/choice.js";
export {
  PlanCheckpointError,
  PlanProposedError,
  PlanRevisionProposedError,
  registerPlanTool,
} from "./tools/plan.js";
export type { PlanStep, PlanStepRisk, PlanToolOptions, StepCompletion } from "./tools/plan.js";
export { forkRegistryExcluding, registerSubagentTool } from "./tools/subagent.js";
export type {
  SubagentEvent,
  SubagentSink,
  SubagentToolOptions,
} from "./tools/subagent.js";
export {
  NeedsConfirmationError,
  detectShellOperator,
  formatCommandResult,
  injectPowerShellUtf8,
  isAllowed,
  prepareSpawn,
  quoteForCmdExe,
  registerShellTools,
  resolveExecutable,
  runCommand,
  tokenizeCommand,
  withUtf8Codepage,
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
} from "./telemetry/stats.js";
export type { TurnStats, SessionSummary } from "./telemetry/stats.js";

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
} from "./memory/session.js";
export type { SessionInfo } from "./memory/session.js";

export { loadDotenv } from "./env.js";

export {
  openTranscriptFile,
  parseTranscript,
  readTranscript,
  recordFromLoopEvent,
  writeMeta,
  writeRecord,
} from "./transcript/log.js";
export type { TranscriptRecord, TranscriptMeta, ReadTranscriptResult } from "./transcript/log.js";

export { computeReplayStats, replayFromFile } from "./transcript/replay.js";
export type { ReplayStats } from "./transcript/replay.js";

export {
  diffTranscripts,
  renderMarkdown as renderDiffMarkdown,
  renderSummaryTable as renderDiffSummary,
  similarity,
} from "./transcript/diff.js";
export type {
  DiffReport,
  DiffSide,
  TurnPair,
  RenderOptions as DiffRenderOptions,
} from "./transcript/diff.js";

export { McpClient } from "./mcp/client.js";
export type { McpClientOptions } from "./mcp/client.js";
export { StdioTransport } from "./mcp/stdio.js";
export type { McpTransport, StdioTransportOptions } from "./mcp/stdio.js";
export { SseTransport } from "./mcp/sse.js";
export type { SseTransportOptions } from "./mcp/sse.js";
export { StreamableHttpTransport } from "./mcp/streamable-http.js";
export type { StreamableHttpTransportOptions } from "./mcp/streamable-http.js";
export {
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_MAX_RESULT_TOKENS,
  bridgeMcpTools,
  flattenMcpResult,
  truncateForModel,
  truncateForModelByTokens,
} from "./mcp/registry.js";
export type { BridgeOptions, BridgeResult, FlattenOptions } from "./mcp/registry.js";
export { parseMcpSpec } from "./mcp/spec.js";
export type {
  McpSpec,
  SseMcpSpec,
  StdioMcpSpec,
  StreamableHttpMcpSpec,
} from "./mcp/spec.js";
export { inspectMcpServer } from "./mcp/inspect.js";
export type { InspectionReport, SectionResult } from "./mcp/inspect.js";

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
export type { CodeSystemPromptOptions } from "./code/prompt.js";
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

export {
  LATEST_CACHE_TTL_MS,
  LATEST_FETCH_TIMEOUT_MS,
  VERSION,
  compareVersions,
  getLatestVersion,
  isNpxInstall,
} from "./version.js";
export type { GetLatestVersionOptions } from "./version.js";

export {
  HOOK_EVENTS,
  HOOK_SETTINGS_DIRNAME,
  HOOK_SETTINGS_FILENAME,
  decideOutcome,
  formatHookOutcomeMessage,
  globalSettingsPath,
  loadHooks,
  matchesTool,
  projectSettingsPath,
  runHooks,
} from "./hooks.js";
export {
  aggregateUsage,
  appendUsage,
  bucketCacheHitRatio,
  bucketSavingsFraction,
  defaultUsageLogPath,
  formatLogSize,
  readUsageLog,
} from "./telemetry/usage.js";
export type {
  AggregateOptions,
  AppendUsageInput,
  UsageAggregate,
  UsageBucket,
  UsageRecord,
} from "./telemetry/usage.js";
export type {
  HookConfig,
  HookEvent,
  HookOutcome,
  HookPayload,
  HookReport,
  HookScope,
  HookSettings,
  HookSpawner,
  HookSpawnInput,
  HookSpawnResult,
  LoadHookSettingsOptions,
  ResolvedHook,
  RunHooksOptions,
} from "./hooks.js";
