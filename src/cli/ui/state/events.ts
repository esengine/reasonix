import { z } from "zod";

const cardId = z.string().min(1);
const ts = z.number().int().nonnegative();

const userSubmit = z.object({
  type: z.literal("user.submit"),
  text: z.string(),
});

const turnStart = z.object({
  type: z.literal("turn.start"),
  turnId: z.string().min(1),
});

const turnThinking = z.object({
  type: z.literal("turn.thinking"),
});

const reasoningStart = z.object({
  type: z.literal("reasoning.start"),
  id: cardId,
});

const reasoningChunk = z.object({
  type: z.literal("reasoning.chunk"),
  id: cardId,
  text: z.string(),
});

const reasoningEnd = z.object({
  type: z.literal("reasoning.end"),
  id: cardId,
  paragraphs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  aborted: z.boolean().optional(),
});

const streamingStart = z.object({
  type: z.literal("streaming.start"),
  id: cardId,
});

const streamingChunk = z.object({
  type: z.literal("streaming.chunk"),
  id: cardId,
  text: z.string(),
});

const streamingEnd = z.object({
  type: z.literal("streaming.end"),
  id: cardId,
  aborted: z.boolean().optional(),
});

const toolStart = z.object({
  type: z.literal("tool.start"),
  id: cardId,
  name: z.string(),
  args: z.unknown(),
});

const toolChunk = z.object({
  type: z.literal("tool.chunk"),
  id: cardId,
  text: z.string(),
});

const toolEnd = z.object({
  type: z.literal("tool.end"),
  id: cardId,
  output: z.string().optional(),
  exitCode: z.number().int().optional(),
  elapsedMs: z.number().nonnegative(),
  aborted: z.boolean().optional(),
});

const toolRetry = z.object({
  type: z.literal("tool.retry"),
  id: cardId,
  attempt: z.number().int().positive(),
  max: z.number().int().positive(),
});

const turnAbort = z.object({
  type: z.literal("turn.abort"),
});

const turnEnd = z.object({
  type: z.literal("turn.end"),
  usage: z.object({
    prompt: z.number().int().nonnegative(),
    reason: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheHit: z.number().min(0).max(1),
    cost: z.number().nonnegative(),
  }),
  /** Model context window — drives the prompt-bar denominator on the auto-emitted UsageCard. */
  promptCap: z.number().int().positive().optional(),
  elapsedMs: z.number().nonnegative().optional(),
});

const modeChange = z.object({
  type: z.literal("mode.change"),
  mode: z.enum(["auto", "ask", "plan", "edit"]),
});

const networkChange = z.object({
  type: z.literal("network.change"),
  state: z.enum(["online", "slow", "disconnected", "reconnecting"]),
  detail: z.string().optional(),
});

const sessionUpdate = z.object({
  type: z.literal("session.update"),
  patch: z.object({
    cost: z.number().optional(),
    sessionCost: z.number().optional(),
    balance: z.number().optional(),
    cacheHit: z.number().optional(),
  }),
});

const focusMove = z.object({
  type: z.literal("focus.move"),
  direction: z.enum(["next", "prev", "first", "last"]),
});

const focusSet = z.object({
  type: z.literal("focus.set"),
  cardId: cardId.nullable(),
});

const cardToggle = z.object({
  type: z.literal("card.toggle"),
  cardId: cardId,
});

const composerInput = z.object({
  type: z.literal("composer.input"),
  value: z.string(),
});

const composerCursor = z.object({
  type: z.literal("composer.cursor"),
  index: z.number().int().nonnegative(),
});

const composerHistory = z.object({
  type: z.literal("composer.history"),
  direction: z.enum(["older", "newer"]),
});

const pickerOpen = z.object({
  type: z.literal("picker.open"),
  kind: z.enum(["slash", "mention", "history", "slasharg"]),
});

const pickerClose = z.object({
  type: z.literal("picker.close"),
});

const toastShow = z.object({
  type: z.literal("toast.show"),
  tone: z.enum(["ok", "info", "warn", "err"]),
  title: z.string(),
  detail: z.string().optional(),
  ttlMs: z.number().int().positive().default(3000),
});

const toastHide = z.object({
  type: z.literal("toast.hide"),
  id: z.string(),
});

const sessionReset = z.object({
  type: z.literal("session.reset"),
});

const languageChange = z.object({
  type: z.literal("language.change"),
  lang: z.string(),
});

const planShow = z.object({
  type: z.literal("plan.show"),
  id: cardId,
  title: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(["queued", "running", "done", "failed", "blocked", "skipped"]),
    }),
  ),
  variant: z.enum(["active", "resumed", "replay"]),
});

const planStepComplete = z.object({
  type: z.literal("plan.step.complete"),
  stepId: z.string(),
});

const planDrop = z.object({
  type: z.literal("plan.drop"),
});

const branchStart = z.object({
  type: z.literal("branch.start"),
  id: cardId,
  total: z.number().int().positive(),
});

const branchProgress = z.object({
  type: z.literal("branch.progress"),
  id: cardId,
  completed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  latestIndex: z.number().int().nonnegative(),
  latestTemperature: z.number(),
  latestUncertainties: z.number().int().nonnegative(),
});

const branchEnd = z.object({
  type: z.literal("branch.end"),
  id: cardId,
  aborted: z.boolean().optional(),
});

const usageShow = z.object({
  type: z.literal("usage.show"),
  id: cardId,
  turn: z.number().int().nonnegative(),
  tokens: z.object({
    prompt: z.number().int().nonnegative(),
    reason: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    promptCap: z.number().int().nonnegative(),
  }),
  cacheHit: z.number().min(0).max(1),
  cost: z.number().nonnegative(),
  sessionCost: z.number().nonnegative(),
  balance: z.number().optional(),
  elapsedMs: z.number().nonnegative().optional(),
});

const doctorShow = z.object({
  type: z.literal("doctor.show"),
  id: cardId,
  checks: z.array(
    z.object({
      label: z.string(),
      level: z.enum(["ok", "warn", "fail"]),
      detail: z.string(),
    }),
  ),
});

const ctxShow = z.object({
  type: z.literal("ctx.show"),
  id: cardId,
  text: z.string(),
  systemTokens: z.number().int().nonnegative(),
  toolsTokens: z.number().int().nonnegative(),
  logTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  ctxMax: z.number().int().positive(),
  toolsCount: z.number().int().nonnegative(),
  logMessages: z.number().int().nonnegative(),
  topTools: z.array(
    z.object({
      name: z.string(),
      tokens: z.number().int().nonnegative(),
      turn: z.number().int().nonnegative(),
    }),
  ),
});

const liveShow = z.object({
  type: z.literal("live.show"),
  id: cardId,
  ts: ts,
  variant: z.enum([
    "thinking",
    "undo",
    "ctxPressure",
    "aborted",
    "retry",
    "checkpoint",
    "stepProgress",
    "mcpEvent",
    "sessionOp",
  ]),
  tone: z.enum(["ok", "warn", "err", "info", "brand", "accent", "ghost"]),
  text: z.string(),
  meta: z.string().optional(),
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  userSubmit,
  turnStart,
  turnThinking,
  reasoningStart,
  reasoningChunk,
  reasoningEnd,
  streamingStart,
  streamingChunk,
  streamingEnd,
  toolStart,
  toolChunk,
  toolEnd,
  toolRetry,
  turnAbort,
  turnEnd,
  modeChange,
  networkChange,
  languageChange,
  sessionUpdate,
  focusMove,
  focusSet,
  cardToggle,
  composerInput,
  composerCursor,
  composerHistory,
  pickerOpen,
  pickerClose,
  toastShow,
  toastHide,
  liveShow,
  sessionReset,
  planShow,
  planStepComplete,
  planDrop,
  ctxShow,
  doctorShow,
  usageShow,
  branchStart,
  branchProgress,
  branchEnd,
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

export function parseEvent(raw: unknown): AgentEvent | null {
  const result = AgentEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}
