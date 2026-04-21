import { type EventSourceMessage, createParser } from "eventsource-parser";
import type { ChatMessage, ChatRequestOptions, RawUsage, ToolCall, ToolSpec } from "./types.js";

export class Usage {
  constructor(
    public promptTokens = 0,
    public completionTokens = 0,
    public totalTokens = 0,
    public promptCacheHitTokens = 0,
    public promptCacheMissTokens = 0,
  ) {}

  get cacheHitRatio(): number {
    const denom = this.promptCacheHitTokens + this.promptCacheMissTokens;
    return denom > 0 ? this.promptCacheHitTokens / denom : 0;
  }

  static fromApi(raw: RawUsage | undefined | null): Usage {
    const u = raw ?? {};
    return new Usage(
      u.prompt_tokens ?? 0,
      u.completion_tokens ?? 0,
      u.total_tokens ?? 0,
      u.prompt_cache_hit_tokens ?? 0,
      u.prompt_cache_miss_tokens ?? 0,
    );
  }
}

export interface ChatResponse {
  content: string;
  reasoningContent: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  raw: unknown;
}

export interface StreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: { index: number; id?: string; name?: string; argumentsDelta?: string };
  usage?: Usage;
  finishReason?: string;
  raw: any;
}

export interface DeepSeekClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class DeepSeekClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly _fetch: typeof fetch;

  constructor(opts: DeepSeekClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY is not set. Put it in .env or pass apiKey to DeepSeekClient.",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (
      opts.baseUrl ??
      process.env.DEEPSEEK_BASE_URL ??
      "https://api.deepseek.com"
    ).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private buildPayload(opts: ChatRequestOptions, stream: boolean) {
    const payload: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream,
    };
    if (opts.tools?.length) payload.tools = opts.tools;
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) payload.max_tokens = opts.maxTokens;
    return payload;
  }

  async chat(opts: ChatRequestOptions): Promise<ChatResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const signal = opts.signal ?? ctrl.signal;

    try {
      const resp = await this._fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.buildPayload(opts, false)),
        signal,
      });
      if (!resp.ok) {
        throw new Error(`DeepSeek ${resp.status}: ${await resp.text()}`);
      }
      const data: any = await resp.json();
      const choice = data.choices?.[0]?.message ?? {};
      return {
        content: choice.content ?? "",
        reasoningContent: choice.reasoning_content ?? null,
        toolCalls: choice.tool_calls ?? [],
        usage: Usage.fromApi(data.usage),
        raw: data,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(opts: ChatRequestOptions): AsyncGenerator<StreamChunk> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const signal = opts.signal ?? ctrl.signal;

    let resp: Response;
    try {
      resp = await this._fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(this.buildPayload(opts, true)),
        signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    if (!resp.ok || !resp.body) {
      clearTimeout(timer);
      throw new Error(`DeepSeek ${resp.status}: ${await resp.text().catch(() => "")}`);
    }

    const queue: StreamChunk[] = [];
    let done = false;
    const parser = createParser({
      onEvent: (ev: EventSourceMessage) => {
        if (!ev.data || ev.data === "[DONE]") {
          done = true;
          return;
        }
        try {
          const json = JSON.parse(ev.data);
          const delta = json.choices?.[0]?.delta ?? {};
          const finishReason = json.choices?.[0]?.finish_reason ?? undefined;
          const chunk: StreamChunk = { raw: json, finishReason };
          if (typeof delta.content === "string" && delta.content.length > 0) {
            chunk.contentDelta = delta.content;
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            chunk.reasoningDelta = delta.reasoning_content;
          }
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            const tc = delta.tool_calls[0];
            chunk.toolCallDelta = {
              index: tc.index ?? 0,
              id: tc.id,
              name: tc.function?.name,
              argumentsDelta: tc.function?.arguments,
            };
          }
          if (json.usage) {
            chunk.usage = Usage.fromApi(json.usage);
          }
          queue.push(chunk);
        } catch {
          /* skip malformed sse frame */
        }
      },
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      while (queue.length > 0) yield queue.shift()!;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }
}

export type { ChatMessage, ToolCall, ToolSpec };
