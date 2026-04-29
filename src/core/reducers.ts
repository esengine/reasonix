/**
 * Pure projection reducers over the Event log. No I/O. No mutation.
 * Each reducer must be deterministic: same (view, ev) → same view.
 */

import type { ChatMessage } from "../types.js";
import type {
  BudgetView,
  CapabilityView,
  ConversationView,
  Event,
  PlanStepView,
  PlanView,
  ProjectionSet,
  Reducer,
  SessionMetaView,
  StatusView,
  WorkspaceView,
} from "./events.js";

export function emptyConversation(): ConversationView {
  return { messages: [], pendingToolCalls: [] };
}

export function emptyBudget(capUsd: number | null = null): BudgetView {
  return {
    spentUsd: 0,
    capUsd,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    warned: false,
    blocked: false,
  };
}

export function emptyPlan(): PlanView {
  return { steps: [], body: null, submittedTurn: null };
}

export function emptyWorkspace(): WorkspaceView {
  return { filesTouched: new Map(), lastCheckpointId: null };
}

export function emptyCapabilities(): CapabilityView {
  return { tools: [] };
}

export function emptyStatus(): StatusView {
  return { current: null };
}

export function emptySessionMeta(): SessionMetaView {
  return {
    name: null,
    openedAt: null,
    resumedFromTurn: null,
    currentTurn: 0,
    lastError: null,
  };
}

export function emptyProjections(capUsd: number | null = null): ProjectionSet {
  return {
    conversation: emptyConversation(),
    budget: emptyBudget(capUsd),
    plan: emptyPlan(),
    workspace: emptyWorkspace(),
    capabilities: emptyCapabilities(),
    status: emptyStatus(),
    session: emptySessionMeta(),
  };
}

export const conversation: Reducer<ConversationView> = (v, ev) => {
  switch (ev.type) {
    case "user.message": {
      const msg: ChatMessage = { role: "user", content: ev.text };
      return { ...v, messages: [...v.messages, msg] };
    }
    case "model.final": {
      const msg: ChatMessage = { role: "assistant", content: ev.content };
      if (ev.toolCalls.length > 0) msg.tool_calls = [...ev.toolCalls];
      if (ev.reasoningContent !== undefined) msg.reasoning_content = ev.reasoningContent;
      return { ...v, messages: [...v.messages, msg] };
    }
    case "tool.intent":
      return {
        ...v,
        pendingToolCalls: [...v.pendingToolCalls, { callId: ev.callId, name: ev.name }],
      };
    case "tool.result": {
      const msg: ChatMessage = { role: "tool", content: ev.output, tool_call_id: ev.callId };
      return {
        messages: [...v.messages, msg],
        pendingToolCalls: v.pendingToolCalls.filter((c) => c.callId !== ev.callId),
      };
    }
    case "tool.denied": {
      const msg: ChatMessage = {
        role: "tool",
        content: `denied: ${ev.reason}`,
        tool_call_id: ev.callId,
      };
      return {
        messages: [...v.messages, msg],
        pendingToolCalls: v.pendingToolCalls.filter((c) => c.callId !== ev.callId),
      };
    }
    case "session.compacted":
      return { messages: [...ev.replacementMessages], pendingToolCalls: [] };
    default:
      return v;
  }
};

export const budget: Reducer<BudgetView> = (v, ev) => {
  switch (ev.type) {
    case "model.final": {
      const u = ev.usage;
      return {
        ...v,
        spentUsd: v.spentUsd + ev.costUsd,
        promptTokens: v.promptTokens + (u.prompt_tokens ?? 0),
        completionTokens: v.completionTokens + (u.completion_tokens ?? 0),
        cacheHitTokens: v.cacheHitTokens + (u.prompt_cache_hit_tokens ?? 0),
        cacheMissTokens: v.cacheMissTokens + (u.prompt_cache_miss_tokens ?? 0),
      };
    }
    case "policy.budget.warning":
      return { ...v, warned: true };
    case "policy.budget.blocked":
      return { ...v, blocked: true };
    default:
      return v;
  }
};

export const plan: Reducer<PlanView> = (v, ev) => {
  switch (ev.type) {
    case "plan.submitted": {
      const steps: PlanStepView[] = ev.steps.map((s) => ({
        id: s.id,
        title: s.title,
        action: s.action,
        risk: s.risk,
        completed: false,
      }));
      return { steps, body: ev.body, submittedTurn: ev.turn };
    }
    case "plan.step.completed": {
      if (!v.steps.some((s) => s.id === ev.stepId)) return v;
      return {
        ...v,
        steps: v.steps.map((s) =>
          s.id === ev.stepId ? { ...s, completed: true, notes: ev.notes } : s,
        ),
      };
    }
    default:
      return v;
  }
};

export const workspace: Reducer<WorkspaceView> = (v, ev) => {
  switch (ev.type) {
    case "effect.file.touched": {
      const next = new Map(v.filesTouched);
      next.set(ev.path, ev.mode);
      return { ...v, filesTouched: next };
    }
    case "checkpoint.created":
      return { ...v, lastCheckpointId: ev.checkpointId };
    default:
      return v;
  }
};

export const capabilities: Reducer<CapabilityView> = (v, ev) => {
  switch (ev.type) {
    case "capability.registered": {
      const filtered = v.tools.filter((t) => t.name !== ev.name);
      return { tools: [...filtered, { name: ev.name, permission: ev.permission }] };
    }
    case "capability.removed":
      return { tools: v.tools.filter((t) => t.name !== ev.name) };
    default:
      return v;
  }
};

const STATUS_CLEARING: ReadonlySet<Event["type"]> = new Set([
  "model.delta",
  "model.final",
  "tool.dispatched",
  "tool.result",
  "tool.denied",
  "error",
]);

export const status: Reducer<StatusView> = (v, ev) => {
  if (ev.type === "status") return { current: ev.text };
  if (STATUS_CLEARING.has(ev.type) && v.current !== null) return { current: null };
  return v;
};

export const sessionMeta: Reducer<SessionMetaView> = (v, ev) => {
  let next = v;
  if (ev.turn > next.currentTurn) next = { ...next, currentTurn: ev.turn };
  switch (ev.type) {
    case "session.opened":
      return {
        ...next,
        name: ev.name,
        openedAt: ev.ts,
        resumedFromTurn: ev.resumedFromTurn,
      };
    case "error":
      return { ...next, lastError: ev.message };
    default:
      return next;
  }
};

export function apply(state: ProjectionSet, ev: Event): ProjectionSet {
  return {
    conversation: conversation(state.conversation, ev),
    budget: budget(state.budget, ev),
    plan: plan(state.plan, ev),
    workspace: workspace(state.workspace, ev),
    capabilities: capabilities(state.capabilities, ev),
    status: status(state.status, ev),
    session: sessionMeta(state.session, ev),
  };
}

export function replay(events: Iterable<Event>, capUsd: number | null = null): ProjectionSet {
  let s = emptyProjections(capUsd);
  for (const ev of events) s = apply(s, ev);
  return s;
}
