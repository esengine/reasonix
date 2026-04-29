/** Port: capability dispatch. Tools / MCP / skills all flow through here. */

export interface CapabilityDescriptor {
  name: string;
  description?: string;
  readOnly: boolean;
  permission: "ask" | "allow" | "deny";
}

export interface ToolDispatchIntent {
  callId: string;
  name: string;
  /** JSON string exactly as the model emitted it. */
  args: string;
}

export type ToolDispatchOutcome =
  | {
      kind: "result";
      callId: string;
      ok: boolean;
      output: string;
      truncated?: boolean;
      durationMs: number;
    }
  | {
      kind: "denied";
      callId: string;
      reason: "permission" | "budget" | "policy" | "hook";
    };

export interface ToolHost {
  list(): ReadonlyArray<CapabilityDescriptor>;
  dispatch(intent: ToolDispatchIntent, signal?: AbortSignal): Promise<ToolDispatchOutcome>;
}
