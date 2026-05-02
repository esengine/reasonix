import type { ToolCall } from "../types.js";

/** Mutating calls clear prior read-only entries so a post-edit re-read isn't flagged as repeat. */
export type IsMutating = (call: ToolCall) => boolean;

interface RecentEntry {
  name: string;
  args: string;
  readOnly: boolean;
}

/** Tracks (name, args) repeats; mutating calls clear prior read-only entries while still counting amongst themselves. */
export class StormBreaker {
  private readonly windowSize: number;
  private readonly threshold: number;
  private readonly isMutating: IsMutating | undefined;
  private readonly recent: RecentEntry[] = [];

  constructor(windowSize = 6, threshold = 3, isMutating?: IsMutating) {
    this.windowSize = windowSize;
    this.threshold = threshold;
    this.isMutating = isMutating;
  }

  inspect(call: ToolCall): { suppress: boolean; reason?: string } {
    const name = call.function?.name;
    if (!name) return { suppress: false };
    const args = call.function?.arguments ?? "";
    const mutating = this.isMutating ? this.isMutating(call) : false;
    const readOnly = !mutating;

    if (mutating) {
      // Drop prior read-only entries — the file/shell state just
      // changed, so a verify-read after this should start with a
      // clean slate. Keep mutator entries: 3 identical edits in a row
      // is still a storm (model in a loop).
      for (let i = this.recent.length - 1; i >= 0; i--) {
        if (this.recent[i]!.readOnly) this.recent.splice(i, 1);
      }
    }

    const count = this.recent.reduce((n, e) => (e.name === name && e.args === args ? n + 1 : n), 0);
    if (count >= this.threshold - 1) {
      return {
        suppress: true,
        reason: `${name} called with identical args ${count + 1} times — repeat-loop guard tripped`,
      };
    }
    this.recent.push({ name, args, readOnly });
    while (this.recent.length > this.windowSize) this.recent.shift();
    return { suppress: false };
  }

  reset(): void {
    this.recent.length = 0;
  }
}
