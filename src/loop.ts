import type { DeepSeekClient } from "./client.js";
import { type TypedPlanState, harvest } from "./harvest.js";
import { AppendOnlyLog, type ImmutablePrefix, VolatileScratch } from "./memory.js";
import { type RepairReport, ToolCallRepair } from "./repair/index.js";
import { SessionStats, type TurnStats } from "./telemetry.js";
import { ToolRegistry } from "./tools.js";
import type { ChatMessage, ToolCall } from "./types.js";

export type EventRole = "assistant_delta" | "assistant_final" | "tool" | "done" | "error";

export interface LoopEvent {
  turn: number;
  role: EventRole;
  content: string;
  reasoningDelta?: string;
  toolName?: string;
  stats?: TurnStats;
  planState?: TypedPlanState;
  repair?: RepairReport;
  error?: string;
}

export interface CacheFirstLoopOptions {
  client: DeepSeekClient;
  prefix: ImmutablePrefix;
  tools?: ToolRegistry;
  model?: string;
  maxToolIters?: number;
  stream?: boolean;
}

/**
 * Pillar 1 — Cache-First Loop.
 *
 * - prefix is immutable (cache target)
 * - log is append-only (preserves prior-turn prefix)
 * - scratch is per-turn volatile (never sent upstream)
 *
 * Yields a stream of events so a TUI can render progressively.
 */
export class CacheFirstLoop {
  readonly client: DeepSeekClient;
  readonly prefix: ImmutablePrefix;
  readonly tools: ToolRegistry;
  readonly model: string;
  readonly maxToolIters: number;
  readonly stream: boolean;
  readonly log = new AppendOnlyLog();
  readonly scratch = new VolatileScratch();
  readonly stats = new SessionStats();
  readonly repair: ToolCallRepair;
  private _turn = 0;

  constructor(opts: CacheFirstLoopOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix;
    this.tools = opts.tools ?? new ToolRegistry();
    this.model = opts.model ?? "deepseek-chat";
    this.maxToolIters = opts.maxToolIters ?? 8;
    this.stream = opts.stream ?? true;
    const allowedNames = new Set([...this.prefix.toolSpecs.map((s) => s.function.name)]);
    this.repair = new ToolCallRepair({ allowedToolNames: allowedNames });
  }

  private buildMessages(pendingUser: string | null): ChatMessage[] {
    const msgs: ChatMessage[] = [...this.prefix.toMessages(), ...this.log.toMessages()];
    if (pendingUser !== null) msgs.push({ role: "user", content: pendingUser });
    return msgs;
  }

  async *step(userInput: string): AsyncGenerator<LoopEvent> {
    this._turn++;
    this.scratch.reset();
    let pendingUser: string | null = userInput;
    const toolSpecs = this.prefix.tools();

    for (let iter = 0; iter < this.maxToolIters; iter++) {
      const messages = this.buildMessages(pendingUser);

      let assistantContent = "";
      let reasoningContent = "";
      let toolCalls: ToolCall[] = [];
      let usage: TurnStats["usage"] | null = null;

      try {
        if (this.stream) {
          const callBuf: Map<number, ToolCall> = new Map();
          for await (const chunk of this.client.stream({
            model: this.model,
            messages,
            tools: toolSpecs.length ? toolSpecs : undefined,
          })) {
            if (chunk.contentDelta) {
              assistantContent += chunk.contentDelta;
              yield {
                turn: this._turn,
                role: "assistant_delta",
                content: chunk.contentDelta,
              };
            }
            if (chunk.reasoningDelta) {
              reasoningContent += chunk.reasoningDelta;
              yield {
                turn: this._turn,
                role: "assistant_delta",
                content: "",
                reasoningDelta: chunk.reasoningDelta,
              };
            }
            if (chunk.toolCallDelta) {
              const d = chunk.toolCallDelta;
              const cur = callBuf.get(d.index) ?? {
                id: d.id,
                type: "function" as const,
                function: { name: "", arguments: "" },
              };
              if (d.id) cur.id = d.id;
              if (d.name) cur.function.name = (cur.function.name ?? "") + d.name;
              if (d.argumentsDelta)
                cur.function.arguments = (cur.function.arguments ?? "") + d.argumentsDelta;
              callBuf.set(d.index, cur);
            }
            if (chunk.usage) usage = chunk.usage;
          }
          toolCalls = [...callBuf.values()];
        } else {
          const resp = await this.client.chat({
            model: this.model,
            messages,
            tools: toolSpecs.length ? toolSpecs : undefined,
          });
          assistantContent = resp.content;
          reasoningContent = resp.reasoningContent ?? "";
          toolCalls = resp.toolCalls;
          usage = resp.usage;
        }
      } catch (err) {
        yield {
          turn: this._turn,
          role: "error",
          content: "",
          error: (err as Error).message,
        };
        return;
      }

      const turnStats = this.stats.record(
        this._turn,
        this.model,
        usage ?? new (await import("./client.js")).Usage(),
      );

      // Commit the user turn to the log only on success of the first round-trip.
      if (pendingUser !== null) {
        this.log.append({ role: "user", content: pendingUser });
        pendingUser = null;
      }

      this.scratch.reasoning = reasoningContent || null;
      const planState = await harvest(reasoningContent || null);

      const { calls: repairedCalls, report } = this.repair.process(
        toolCalls,
        reasoningContent || null,
      );

      this.log.append(this.assistantMessage(assistantContent, repairedCalls));

      yield {
        turn: this._turn,
        role: "assistant_final",
        content: assistantContent,
        stats: turnStats,
        planState,
        repair: report,
      };

      if (repairedCalls.length === 0) {
        yield { turn: this._turn, role: "done", content: assistantContent };
        return;
      }

      for (const call of repairedCalls) {
        const name = call.function?.name ?? "";
        const args = call.function?.arguments ?? "{}";
        const result = await this.tools.dispatch(name, args);
        this.log.append({
          role: "tool",
          tool_call_id: call.id ?? "",
          name,
          content: result,
        });
        yield { turn: this._turn, role: "tool", content: result, toolName: name };
      }
    }

    yield { turn: this._turn, role: "done", content: "[max_tool_iters reached]" };
  }

  async run(userInput: string, onEvent?: (ev: LoopEvent) => void): Promise<string> {
    let final = "";
    for await (const ev of this.step(userInput)) {
      onEvent?.(ev);
      if (ev.role === "assistant_final") final = ev.content;
      if (ev.role === "done") break;
    }
    return final;
  }

  private assistantMessage(content: string, toolCalls: ToolCall[]): ChatMessage {
    const msg: ChatMessage = { role: "assistant", content };
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    return msg;
  }
}
