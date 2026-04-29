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
        // Progress signal only; intent + args land on tool_start.
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
      // `done` / `branch_*` intentionally drop — no kernel-level event.
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
      // toolCalls land later via tool_start → tool.intent — not in this event.
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

  /** Pattern-match warning text since LoopEvent doesn't carry a typed kind. */
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
  if (!content) return false;
  if (content.startsWith("ERROR:")) return true;
  if (content.startsWith("[hook block]")) return true;
  if (/^\{"error"\s*:/.test(content)) return true;
  if (/\bConfirmationError:|\bNeedsConfirmationError\b/.test(content)) return true;
  return false;
}
