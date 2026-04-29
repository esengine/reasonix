/**
 * Translator: LoopEvent stream → typed Event stream.
 *
 * Holds the small amount of state needed to make the conversion
 * deterministic and correlated:
 *   - monotonic event id seq (kernel invariant)
 *   - last turn seen (synthesizes `model.turn.started` on transition)
 *   - per-tool-call id seq (correlates `tool.intent` → `tool.dispatched`
 *     → `tool.result` chains; the LoopEvent stream doesn't surface
 *     `call.id` on `tool_start`, so we mint our own)
 *
 * Pure data — no I/O. Caller (App.tsx) wires Eventizer into the loop's
 * `for await` consumer and forwards each output Event to an EventSink.
 */

import type { LoopEvent } from "../loop.js";
import type { ChatMessage, RawUsage, ToolCall } from "../types.js";
import type {
  Event,
  ErrorEvent as KernelErrorEvent,
  ModelDeltaEvent,
  ModelFinalEvent,
  ModelTurnStartedEvent,
  SessionCompactedEvent,
  SessionOpenedEvent,
  SlashInvokedEvent,
  StatusEvent,
  ToolDispatchedEvent,
  ToolIntentEvent,
  ToolResultEvent,
  UserMessageEvent,
} from "./events.js";

export interface EventizeContext {
  model: string;
  prefixHash: string;
  reasoningEffort: "high" | "max";
}

export class Eventizer {
  private nextId = 0;
  private lastTurn = -1;
  private nextToolSeq = 0;
  /** Stack so parallel-batch dispatches still pair start ↔ result. */
  private pendingCallIds: string[] = [];

  consume(ev: LoopEvent, ctx: EventizeContext): Event[] {
    const out: Event[] = [];
    if (ev.turn !== this.lastTurn) {
      this.lastTurn = ev.turn;
      out.push(this.turnStartedEvent(ev.turn, ctx));
    }
    switch (ev.role) {
      case "assistant_delta":
        if (ev.content) out.push(this.deltaEvent(ev.turn, "content", ev.content));
        if (ev.reasoningDelta) out.push(this.deltaEvent(ev.turn, "reasoning", ev.reasoningDelta));
        break;
      case "tool_call_delta":
        // No delta text on this LoopEvent — it's a progress signal
        // (cumulative arg-char count + ready count). Skip; the real
        // intent + args land on tool_start.
        break;
      case "assistant_final":
        out.push(this.finalEvent(ev));
        break;
      case "tool_start": {
        const callId = `tc-${++this.nextToolSeq}`;
        this.pendingCallIds.push(callId);
        out.push(this.toolIntentEvent(ev.turn, callId, ev.toolName ?? "", ev.toolArgs ?? ""));
        out.push(this.toolDispatchedEvent(ev.turn, callId));
        break;
      }
      case "tool": {
        const callId = this.pendingCallIds.shift() ?? `tc-orphan-${++this.nextToolSeq}`;
        const ok = !looksLikeToolError(ev.content, ev.toolName);
        out.push(this.toolResultEvent(ev.turn, callId, ok, ev.content, 0));
        break;
      }
      case "warning":
        out.push(this.classifyWarning(ev));
        break;
      case "error":
        out.push(this.errorEvent(ev.turn, ev.error ?? ev.content, false));
        break;
      case "status":
        out.push(this.statusEvent(ev.turn, ev.content));
        break;
      // `done` is a stream-control marker; no kernel event.
      // `branch_*` is consistency.ts; not modeled (feature is a candidate
      //  for retirement, and emitting partial branch state without proper
      //  reducer support would be misleading).
      default:
        break;
    }
    return out;
  }

  emitUserMessage(turn: number, text: string): UserMessageEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "user.message",
      text,
    };
  }

  emitSlashInvoked(turn: number, name: string, args: string): SlashInvokedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "slash.invoked",
      name,
      args,
    };
  }

  emitSessionOpened(turn: number, name: string, resumedFromTurn: number): SessionOpenedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "session.opened",
      name,
      resumedFromTurn,
    };
  }

  emitSessionCompacted(
    turn: number,
    before: number,
    after: number,
    reason: "user" | "auto-context-pressure",
    replacementMessages: ReadonlyArray<ChatMessage>,
  ): SessionCompactedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "session.compacted",
      beforeMessages: before,
      afterMessages: after,
      reason,
      replacementMessages,
    };
  }

  private turnStartedEvent(turn: number, ctx: EventizeContext): ModelTurnStartedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "model.turn.started",
      model: ctx.model,
      reasoningEffort: ctx.reasoningEffort,
      prefixHash: ctx.prefixHash,
    };
  }

  private deltaEvent(
    turn: number,
    channel: "content" | "reasoning" | "tool_args",
    text: string,
  ): ModelDeltaEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "model.delta",
      channel,
      text,
    };
  }

  private finalEvent(ev: LoopEvent): ModelFinalEvent {
    const usage: RawUsage = ev.stats
      ? {
          prompt_tokens: ev.stats.usage.promptTokens,
          completion_tokens: ev.stats.usage.completionTokens,
          total_tokens: ev.stats.usage.totalTokens,
          prompt_cache_hit_tokens: ev.stats.usage.promptCacheHitTokens,
          prompt_cache_miss_tokens: ev.stats.usage.promptCacheMissTokens,
        }
      : {};
    const costUsd = ev.stats?.cost ?? 0;
    const out: ModelFinalEvent = {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn: ev.turn,
      type: "model.final",
      content: ev.content,
      // LoopEvent.assistant_final doesn't carry toolCalls — they're
      // surfaced one-by-one via tool_start later in the iter loop. For
      // the kernel record we leave the array empty here; the
      // tool.intent events emitted on tool_start carry the actual calls.
      toolCalls: [] as ReadonlyArray<ToolCall>,
      usage,
      costUsd,
    };
    if (ev.forcedSummary) out.forcedSummary = true;
    return out;
  }

  private toolIntentEvent(
    turn: number,
    callId: string,
    name: string,
    args: string,
  ): ToolIntentEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.intent",
      callId,
      name,
      args,
    };
  }

  private toolDispatchedEvent(turn: number, callId: string): ToolDispatchedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.dispatched",
      callId,
    };
  }

  private toolResultEvent(
    turn: number,
    callId: string,
    ok: boolean,
    output: string,
    durationMs: number,
  ): ToolResultEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.result",
      callId,
      ok,
      output,
      durationMs,
    };
  }

  private statusEvent(turn: number, text: string): StatusEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "status",
      text,
    };
  }

  private errorEvent(turn: number, message: string, recoverable: boolean): KernelErrorEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "error",
      message,
      recoverable,
    };
  }

  /**
   * Best-effort categorization. The loop yields plain `warning` events
   * with content strings; we pattern-match to distinguish budget warnings
   * (policy.budget.*) from escalation notices (policy.escalated) from
   * everything else (recoverable error). Refining this is a follow-up —
   * hard-typing warning shapes in LoopEvent would let the mapping
   * be exact, but that's a loop.ts edit we're keeping out of scope.
   */
  private classifyWarning(ev: LoopEvent): Event {
    const c = ev.content;
    if (/\bauto-escalating to\b|\barmed\b.*pro|NEEDS_PRO/.test(c)) {
      return {
        id: ++this.nextId,
        ts: new Date().toISOString(),
        turn: ev.turn,
        type: "policy.escalated",
        fromModel: "",
        toModel: "",
        reason: c.includes("armed") ? "user-request" : "self-report",
      };
    }
    if (/budget\b.*\$|\$\d.*\/\s*\$\d/.test(c)) {
      const blocked = /blocked|exceeded|refus/i.test(c);
      return {
        id: ++this.nextId,
        ts: new Date().toISOString(),
        turn: ev.turn,
        type: blocked ? "policy.budget.blocked" : "policy.budget.warning",
        spentUsd: 0,
        capUsd: 0,
      };
    }
    return this.errorEvent(ev.turn, c, true);
  }
}

function looksLikeToolError(content: string, _toolName: string | undefined): boolean {
  // The loop / tool dispatcher serializes thrown errors to a string
  // tool result. Two common shapes: a JSON-stringified `{error: "..."}`,
  // and a plain-text `[hook block] ...` / `... Error: ...` line.
  if (!content) return false;
  if (content.startsWith("ERROR:")) return true;
  if (content.startsWith("[hook block]")) return true;
  if (/^\{"error"\s*:/.test(content)) return true;
  if (/\bConfirmationError:|\bNeedsConfirmationError\b/.test(content)) return true;
  return false;
}
