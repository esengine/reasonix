/** Naive baseline — deliberately breaks prefix cache (fresh timestamp + shuffled tool keys + full-rebuild log) so the comparison vs CacheFirstLoop isolates Pillar 1. */

import {
  type ChatMessage,
  type DeepSeekClient,
  SessionStats,
  type ToolCall,
  type ToolDefinition,
  ToolRegistry,
  type ToolSpec,
  type Usage,
} from "../../src/index.js";
import type { Turn } from "./types.js";

export interface BaselineRunnerOptions {
  client: DeepSeekClient;
  systemPrompt: string;
  tools: ToolDefinition[];
  model?: string;
  maxToolIters?: number;
}

export interface BaselineSubCall {
  /** Assistant text from this sub-call (often empty when the response is tool-calls-only). */
  content: string;
  /** Usage for this single client.chat() call. */
  usage: Usage;
  /** Tools the model chose to call on the back of this response. */
  toolCalls: { name: string; args: string; result: string }[];
}

export interface BaselineTurnResult {
  assistantMessage: string;
  toolCallsExecuted: { name: string; args: string; result: string }[];
  /** Per-sub-call breakdown so bench transcripts match Reasonix loop-event granularity. */
  subCalls: BaselineSubCall[];
  /** Turn number (1-based) assigned by the agent. */
  turnNo: number;
}

export class BaselineAgent {
  readonly client: DeepSeekClient;
  readonly stats = new SessionStats();
  private readonly systemPrompt: string;
  private readonly registry: ToolRegistry;
  private readonly model: string;
  private readonly maxToolIters: number;
  /** Previous-turn messages — kept, but the prefix rebuilds around them every turn so cache churns. */
  private history: ChatMessage[] = [];
  private turnNo = 0;

  constructor(opts: BaselineRunnerOptions) {
    this.client = opts.client;
    this.systemPrompt = opts.systemPrompt;
    this.model = opts.model ?? "deepseek-chat";
    this.maxToolIters = opts.maxToolIters ?? 6;
    this.registry = new ToolRegistry({ autoFlatten: false });
    for (const t of opts.tools) this.registry.register(t);
  }

  /** Run one user-turn — intentionally non-cache-friendly (fresh ts + shuffled tool specs every turn). */
  async userTurn(userMessage: string, transcript: Turn[]): Promise<BaselineTurnResult> {
    this.turnNo++;

    // Naive pattern #1: current-time placeholder in the system prompt.
    const churnedSystem = `${this.systemPrompt}\nCurrent time: ${new Date().toISOString()}`;

    // Naive pattern #2: shuffle tool spec order each turn (simulates
    // frameworks that materialize tools from Python dicts / maps).
    const shuffledTools = shuffle(this.registry.specs(), this.turnNo);

    this.history.push({ role: "user", content: userMessage });

    const toolExecutions: { name: string; args: string; result: string }[] = [];
    const subCalls: BaselineSubCall[] = [];

    for (let iter = 0; iter < this.maxToolIters; iter++) {
      // Naive pattern #3: always rebuild the full message array.
      const messages: ChatMessage[] = [{ role: "system", content: churnedSystem }, ...this.history];

      const resp = await this.client.chat({
        model: this.model,
        messages,
        tools: shuffledTools,
      });
      this.stats.record(this.turnNo, this.model, resp.usage);

      const assistantMessage: ChatMessage = { role: "assistant", content: resp.content };
      if (resp.toolCalls.length > 0) assistantMessage.tool_calls = resp.toolCalls;
      this.history.push(assistantMessage);

      if (resp.toolCalls.length === 0) {
        subCalls.push({ content: resp.content, usage: resp.usage, toolCalls: [] });
        return {
          assistantMessage: resp.content,
          toolCallsExecuted: toolExecutions,
          subCalls,
          turnNo: this.turnNo,
        };
      }

      const subToolCalls: { name: string; args: string; result: string }[] = [];
      for (const tc of resp.toolCalls) {
        const name = tc.function?.name ?? "";
        const args = tc.function?.arguments ?? "{}";
        const result = await this.registry.dispatch(name, args);
        toolExecutions.push({ name, args, result });
        subToolCalls.push({ name, args, result });
        this.history.push({
          role: "tool",
          tool_call_id: tc.id ?? "",
          name,
          content: result,
        });
      }
      subCalls.push({ content: resp.content, usage: resp.usage, toolCalls: subToolCalls });
    }

    const lastAssistant = [...this.history].reverse().find((m) => m.role === "assistant");
    return {
      assistantMessage: lastAssistant?.content ?? "[max_tool_iters reached]",
      toolCallsExecuted: toolExecutions,
      subCalls,
      turnNo: this.turnNo,
    };
  }
}

/**
 * Deterministic Fisher–Yates seeded by turn-number — reproducible runs, cache-hostile orderings.
 */
function shuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed * 9301 + 49297;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Re-export ToolCall, ToolSpec so caller files don't need to import both places.
export type { ToolCall, ToolSpec };
