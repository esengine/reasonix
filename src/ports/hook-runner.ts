/** Port: hook dispatch (PreToolUse / PostToolUse / UserPromptSubmit / Stop). */

import type { HookEvent, HookOutcome, HookPayload, ResolvedHook } from "../hooks.js";

export interface HookRunner {
  fire(
    event: HookEvent,
    payload: HookPayload,
    hooks: ReadonlyArray<ResolvedHook>,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<HookOutcome>>;
}
