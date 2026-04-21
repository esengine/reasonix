/**
 * Scavenge tool calls leaked into reasoning_content.
 *
 * R1 sometimes emits tool-call JSON inside <think>…</think> and then forgets
 * to surface it in `tool_calls`. This pass extracts plausible calls and
 * proposes them to the loop, which decides whether to merge them with the
 * declared calls.
 */

import type { ToolCall } from "../types.js";

export interface ScavengeOptions {
  /** Names of tools the model may legitimately call. Other names are ignored. */
  allowedNames: ReadonlySet<string>;
  /** Maximum number of calls to scavenge per pass (defence against runaway). */
  maxCalls?: number;
}

export interface ScavengeResult {
  calls: ToolCall[];
  notes: string[];
}

export function scavengeToolCalls(
  reasoningContent: string | null | undefined,
  opts: ScavengeOptions,
): ScavengeResult {
  if (!reasoningContent) return { calls: [], notes: [] };
  const max = opts.maxCalls ?? 4;
  const notes: string[] = [];
  const out: ToolCall[] = [];

  for (const candidate of iterateJsonObjects(reasoningContent)) {
    if (out.length >= max) break;
    const call = coerceToToolCall(candidate, opts.allowedNames);
    if (call) {
      out.push(call);
      notes.push(`scavenged call: ${call.function.name}`);
    }
  }
  return { calls: out, notes };
}

/** Yield every top-level JSON object substring in `text`. */
function* iterateJsonObjects(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (c === "\\") {
          escaped = true;
          continue;
        }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          yield text.slice(i, j + 1);
          i = j;
          break;
        }
      }
    }
  }
}

function coerceToToolCall(
  candidateJson: string,
  allowedNames: ReadonlySet<string>,
): ToolCall | null {
  let parsed: any;
  try {
    parsed = JSON.parse(candidateJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  // Pattern 1: { name, arguments }
  if (typeof parsed.name === "string" && allowedNames.has(parsed.name)) {
    const args = parsed.arguments;
    return {
      function: {
        name: parsed.name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    };
  }

  // Pattern 2: OpenAI-style { type: "function", function: { name, arguments } }
  if (
    parsed.type === "function" &&
    parsed.function &&
    typeof parsed.function.name === "string" &&
    allowedNames.has(parsed.function.name)
  ) {
    const args = parsed.function.arguments;
    return {
      type: "function",
      function: {
        name: parsed.function.name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    };
  }

  // Pattern 3: { tool_name, tool_args } (R1 free-form variant)
  if (typeof parsed.tool_name === "string" && allowedNames.has(parsed.tool_name)) {
    return {
      function: {
        name: parsed.tool_name,
        arguments: JSON.stringify(parsed.tool_args ?? {}),
      },
    };
  }

  return null;
}
