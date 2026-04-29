import { eventLogPath } from "../../adapters/event-sink-jsonl.js";
import { readEventLogFile } from "../../adapters/event-source-jsonl.js";
import type { Event } from "../../core/events.js";
import { replay as replayReducers } from "../../core/reducers.js";

export interface EventsOptions {
  name: string;
  type?: string;
  since?: number;
  tail?: number;
  json?: boolean;
  projection?: boolean;
}

export function eventsCommand(opts: EventsOptions): void {
  const path = eventLogPath(opts.name);
  let events = readEventLogFile(path);

  if (events.length === 0) {
    console.error(`no events for session "${opts.name}"`);
    console.error(`looked at: ${path}`);
    console.error("(sessions auto-create the sidecar on first turn — has this session run yet?)");
    process.exit(1);
    return;
  }

  if (opts.type) events = events.filter((e) => e.type === opts.type);
  if (opts.since !== undefined && Number.isFinite(opts.since)) {
    events = events.filter((e) => e.id >= opts.since!);
  }
  if (opts.tail !== undefined && Number.isFinite(opts.tail) && opts.tail > 0) {
    events = events.slice(-opts.tail);
  }

  if (opts.projection) {
    const p = replayReducers(events);
    console.log(JSON.stringify(p, mapReplacer, 2));
    return;
  }

  if (opts.json) {
    for (const e of events) console.log(JSON.stringify(e));
    return;
  }

  console.log(`[events] ${opts.name}   ${events.length} event(s)   ${path}`);
  console.log("");
  for (const e of events) console.log(formatEvent(e));
}

function formatEvent(e: Event): string {
  const id = String(e.id).padStart(4);
  const turn = `t${e.turn}`.padEnd(4);
  const ts = e.ts.replace("T", " ").replace(/\.\d+Z$/, "");
  const type = e.type.padEnd(22);
  return `[${id}] ${turn} ${ts}  ${type}  ${detailsFor(e)}`;
}

function detailsFor(e: Event): string {
  switch (e.type) {
    case "user.message":
      return quote(e.text, 80);
    case "slash.invoked":
      return `/${e.name} ${e.args}`.trim();
    case "model.turn.started":
      return `model=${e.model} effort=${e.reasoningEffort} prefix=${e.prefixHash.slice(0, 8)}`;
    case "model.delta":
      return `${e.channel} ${quote(e.text, 60)}`;
    case "model.final": {
      const u = e.usage;
      const tokens = `in=${u.prompt_tokens ?? 0} out=${u.completion_tokens ?? 0}`;
      const tail = e.forcedSummary ? " [forcedSummary]" : "";
      return `cost=$${e.costUsd.toFixed(4)} ${tokens}${tail}`;
    }
    case "tool.intent":
      return `${e.callId} ${e.name} args=${truncate(e.args, 60)}`;
    case "tool.dispatched":
      return e.callId;
    case "tool.denied":
      return `${e.callId} reason=${e.reason}`;
    case "tool.result":
      return `${e.callId} ${e.ok ? "ok" : "err"} ${e.output.length}B${e.truncated ? " [trunc]" : ""}`;
    case "effect.file.touched":
      return `${e.mode} ${e.path} (${e.bytes}B)`;
    case "effect.memory.written":
      return `${e.scope}:${e.key}`;
    case "plan.submitted":
      return `${e.steps.length} step(s)`;
    case "plan.step.completed":
      return `${e.stepId}${e.title ? ` — ${e.title}` : ""}`;
    case "checkpoint.created":
      return `${e.checkpointId} "${e.name}" ${e.fileCount} file(s) ${e.bytes}B`;
    case "checkpoint.restored":
      return `${e.checkpointId} restored=${e.restored} removed=${e.removed} skipped=${e.skipped}`;
    case "hook.fired":
      return `${e.phase} ${e.hookName} → ${e.outcome}`;
    case "policy.budget.warning":
      return `$${e.spentUsd.toFixed(4)} / $${e.capUsd.toFixed(2)}`;
    case "policy.budget.blocked":
      return `$${e.spentUsd.toFixed(4)} / $${e.capUsd.toFixed(2)} BLOCKED`;
    case "policy.escalated":
      return `${e.fromModel} → ${e.toModel} (${e.reason})${e.rationale ? ` "${e.rationale}"` : ""}`;
    case "session.opened":
      return `${e.name} resumed-from-turn=${e.resumedFromTurn}`;
    case "session.compacted":
      return `${e.beforeMessages} → ${e.afterMessages} msgs (${e.reason})`;
    case "capability.registered":
      return `${e.name} ${e.permission}`;
    case "capability.removed":
      return e.name;
    case "status":
      return quote(e.text, 80);
    case "error":
      return `${e.recoverable ? "[recoverable] " : ""}${quote(e.message, 80)}`;
    default:
      return "";
  }
}

function quote(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? `"${flat}"` : `"${flat.slice(0, max - 1)}…"`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** WorkspaceView holds files in a Map; default JSON.stringify drops it. */
function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}
