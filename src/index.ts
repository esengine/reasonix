/** Reasonix — DeepSeek-native agent framework. Library entry point. */

export { DeepSeekClient, Usage } from "./client.js";
export type { ChatResponse, StreamChunk, DeepSeekClientOptions } from "./client.js";

export { CacheFirstLoop } from "./loop.js";
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

export { ToolRegistry } from "./tools.js";
export type { ToolDefinition } from "./tools.js";

export { SessionStats, costUsd, claudeEquivalentCost } from "./telemetry.js";
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

export const VERSION = "0.2.0";
