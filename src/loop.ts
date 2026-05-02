import { type DeepSeekClient, Usage } from "./client.js";
import {
  type BranchOptions,
  type BranchSample,
  aggregateBranchUsage,
  runBranches,
} from "./consistency.js";
import { type HarvestOptions, type TypedPlanState, emptyPlanState, harvest } from "./harvest.js";
import {
  type HookOutcome,
  type HookPayload,
  type ResolvedHook,
  formatHookOutcomeMessage,
  runHooks,
} from "./hooks.js";
import {
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_MAX_RESULT_TOKENS,
  truncateForModel,
  truncateForModelByTokens,
} from "./mcp/registry.js";

const ARGS_COMPACT_THRESHOLD_TOKENS = 800;
/** Per-turn cap on tool RESULTS — 3k is enough head+tail to cite, model can re-read for detail. */
const TURN_END_RESULT_CAP_TOKENS = 3000;

const FAILURE_ESCALATION_THRESHOLD = 3;
const ESCALATION_MODEL = "deepseek-v4-pro";
/** Accepts `<<<NEEDS_PRO>>>` or `<<<NEEDS_PRO: reason>>>` (reason trimmed, may be empty). */
const NEEDS_PRO_MARKER_PREFIX = "<<<NEEDS_PRO";
const NEEDS_PRO_MARKER_RE = /^<<<NEEDS_PRO(?::\s*([^>]*))?>>>/;
/** Buffer cap before flushing — must fit `<<<NEEDS_PRO: reason>>>` without premature flush. */
const NEEDS_PRO_BUFFER_CHARS = 256;
import { AppendOnlyLog, type ImmutablePrefix, VolatileScratch } from "./memory/runtime.js";
import { appendSessionMessage, loadSessionMessages, rewriteSession } from "./memory/session.js";
import { type RepairReport, ToolCallRepair } from "./repair/index.js";
import {
  DEEPSEEK_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  SessionStats,
  type TurnStats,
} from "./telemetry/stats.js";
import { countTokens, estimateRequestTokens } from "./tokenizer.js";
import { ToolRegistry } from "./tools.js";
import type { ChatMessage, ToolCall } from "./types.js";

export type EventRole =
  | "assistant_delta"
  | "assistant_final"
  /** Only liveness signal during a large-args tool call (no content/reasoning bytes). */
  | "tool_call_delta"
  /** Pre-dispatch ping so the TUI can show a spinner during long tool awaits. */
  | "tool_start"
  | "tool"
  | "done"
  | "error"
  | "warning"
  /** Transient indicator for silent phases; UI clears on next primary event. */
  | "status"
  | "branch_start"
  | "branch_progress"
  | "branch_done";

export interface BranchSummary {
  budget: number;
  chosenIndex: number;
  uncertainties: number[]; // per-sample uncertainty counts
  temperatures: number[];
}

export interface BranchProgress {
  completed: number;
  total: number;
  latestIndex: number;
  latestTemperature: number;
  latestUncertainties: number;
}

export interface LoopEvent {
  turn: number;
  role: EventRole;
  content: string;
  reasoningDelta?: string;
  toolName?: string;
  /** Raw args JSON — needed by `reasonix diff` to explain why a tool was called. */
  toolArgs?: string;
  /** Cumulative arguments-string length for `role === "tool_call_delta"`. */
  toolCallArgsChars?: number;
  /** Zero-based index of the tool call this delta belongs to (multi-tool progress). */
  toolCallIndex?: number;
  /** Count of tool calls whose args have parsed as valid JSON (UI progress, not dispatch gate). */
  toolCallReadyCount?: number;
  stats?: TurnStats;
  planState?: TypedPlanState;
  repair?: RepairReport;
  branch?: BranchSummary;
  branchProgress?: BranchProgress;
  error?: string;
  /** Display-only — code-mode applier MUST skip SEARCH/REPLACE in forced-summary text. */
  forcedSummary?: boolean;
}

export interface CacheFirstLoopOptions {
  client: DeepSeekClient;
  prefix: ImmutablePrefix;
  tools?: ToolRegistry;
  model?: string;
  maxToolIters?: number;
  stream?: boolean;
  harvest?: boolean | HarvestOptions;
  /** Branching disables streaming (need all samples) and force-enables harvest (selector input). */
  branch?: number | BranchOptions;
  reasoningEffort?: "high" | "max";
  autoEscalate?: boolean;
  /** Soft USD cap — warns at 80%, refuses next turn at 100%. Opt-in (default no cap). */
  budgetUsd?: number;
  session?: string;
  /** PreToolUse + PostToolUse only — UserPromptSubmit / Stop live at the App boundary. */
  hooks?: ResolvedHook[];
  /** `cwd` reported to hooks; `reasonix code` sets this to the sandbox root, not shell home. */
  hookCwd?: string;
}

export interface ReconfigurableOptions {
  model?: string;
  harvest?: boolean | HarvestOptions;
  branch?: number | BranchOptions;
  stream?: boolean;
  /** V4 thinking mode only; deepseek-chat ignores. */
  reasoningEffort?: "high" | "max";
  /** `false` pins to `model` — kills both NEEDS_PRO marker scavenge and failure-count threshold. */
  autoEscalate?: boolean;
}

export class CacheFirstLoop {
  readonly client: DeepSeekClient;
  readonly prefix: ImmutablePrefix;
  readonly tools: ToolRegistry;
  readonly maxToolIters: number;
  readonly log = new AppendOnlyLog();
  readonly scratch = new VolatileScratch();
  readonly stats = new SessionStats();
  readonly repair: ToolCallRepair;

  // Mutable via configure() — slash commands in the TUI / library callers tweak
  // these mid-session so users don't have to restart to try harvest or branch.
  model: string;
  stream: boolean;
  harvestEnabled: boolean;
  harvestOptions: HarvestOptions;
  branchEnabled: boolean;
  branchOptions: BranchOptions;
  reasoningEffort: "high" | "max";
  autoEscalate = true;
  budgetUsd: number | null;
  /** One-shot 80% warning latch — cleared by setBudget so a bump re-arms at the new boundary. */
  private _budgetWarned = false;
  sessionName: string | null;

  hooks: ResolvedHook[];
  hookCwd: string;

  /** Number of messages that were pre-loaded from the session file. */
  readonly resumedMessageCount: number;

  private _turn = 0;
  private _streamPreference: boolean;
  /** Threaded through HTTP + every tool dispatch so Esc cancels in-flight work, not after. */
  private _turnAbort: AbortController = new AbortController();

  private _proArmedForNextTurn = false;
  private _escalateThisTurn = false;
  private _turnFailureCount = 0;
  private _turnFailureTypes: Record<string, number> = {};
  private _turnSelfCorrected = false;

  constructor(opts: CacheFirstLoopOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix;
    this.tools = opts.tools ?? new ToolRegistry();
    this.model = opts.model ?? "deepseek-v4-flash";
    this.reasoningEffort = opts.reasoningEffort ?? "max";
    if (opts.autoEscalate !== undefined) this.autoEscalate = opts.autoEscalate;
    this.budgetUsd =
      typeof opts.budgetUsd === "number" && opts.budgetUsd > 0 ? opts.budgetUsd : null;
    // Last-resort backstop — primary stop is the token-context guard inside step().
    this.maxToolIters = opts.maxToolIters ?? 64;
    this.hooks = opts.hooks ?? [];
    this.hookCwd = opts.hookCwd ?? process.cwd();

    // Resolve branch config first (since it forces harvest on).
    if (typeof opts.branch === "number") {
      this.branchOptions = { budget: opts.branch };
    } else if (opts.branch && typeof opts.branch === "object") {
      this.branchOptions = opts.branch;
    } else {
      this.branchOptions = {};
    }
    this.branchEnabled = (this.branchOptions.budget ?? 1) > 1;

    // Branching requires harvest for its default selector to work.
    const harvestForced = this.branchEnabled;
    this.harvestEnabled =
      harvestForced ||
      opts.harvest === true ||
      (typeof opts.harvest === "object" && opts.harvest !== null);
    this.harvestOptions =
      typeof opts.harvest === "object" && opts.harvest !== null
        ? opts.harvest
        : (this.branchOptions.harvestOptions ?? {});

    // Streaming is incompatible with branching (need all samples to select).
    this._streamPreference = opts.stream ?? true;
    this.stream = this.branchEnabled ? false : this._streamPreference;

    const allowedNames = new Set([...this.prefix.toolSpecs.map((s) => s.function.name)]);
    // Storm breaker clears its window on mutating calls so read → edit → verify isn't a storm.
    const registry = this.tools;
    const isMutating = (call: ToolCall): boolean => {
      const name = call.function?.name;
      if (!name) return false;
      const def = registry.get(name);
      if (!def) return false;
      if (def.readOnlyCheck) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function?.arguments ?? "{}") ?? {};
        } catch {
          // Malformed args → fall through to the static flag below; the
          // dynamic check would've thrown anyway.
        }
        try {
          if (def.readOnlyCheck(args as never)) return false;
        } catch {
          /* ignore — fall through */
        }
      }
      return def.readOnly !== true;
    };
    this.repair = new ToolCallRepair({
      allowedToolNames: allowedNames,
      isMutating,
      stormThreshold: parsePositiveIntEnv(process.env.REASONIX_STORM_THRESHOLD),
      stormWindow: parsePositiveIntEnv(process.env.REASONIX_STORM_WINDOW),
    });

    // Heal-on-load: oversized tool results would 400 the next call before the user types.
    this.sessionName = opts.session ?? null;
    if (this.sessionName) {
      const prior = loadSessionMessages(this.sessionName);
      const shrunk = healLoadedMessagesByTokens(prior, DEFAULT_MAX_RESULT_TOKENS);
      // Thinking-mode sessions: API 400s if any historical assistant turn lacks reasoning_content.
      const stamped = stampMissingReasoningForThinkingMode(shrunk.messages, this.model);
      const messages = stamped.messages;
      const healedCount = shrunk.healedCount + stamped.stampedCount;
      const tokensSaved = shrunk.tokensSaved;
      for (const msg of messages) this.log.append(msg);
      this.resumedMessageCount = messages.length;
      if (healedCount > 0) {
        // Persist healed log so the same break isn't re-noticed every restart.
        try {
          rewriteSession(this.sessionName, messages);
        } catch {
          /* disk full / perms — skip, in-memory heal still applies */
        }
        process.stderr.write(
          `▸ session "${this.sessionName}": healed ${healedCount} entr${healedCount === 1 ? "y" : "ies"}${tokensSaved > 0 ? ` (shrunk ${tokensSaved.toLocaleString()} tokens of oversized tool output)` : " (dropped dangling tool_calls tail)"}. Rewrote session file.\n`,
        );
      }
    } else {
      this.resumedMessageCount = 0;
    }
  }

  /** Shrink huge edit_file/write_file args post-dispatch — tool result already explains. */
  private compactToolCallArgsAfterResponse(): void {
    const before = this.log.toMessages();
    const { messages, healedCount } = shrinkOversizedToolCallArgsByTokens(
      before,
      ARGS_COMPACT_THRESHOLD_TOKENS,
    );
    if (healedCount === 0) return;
    this.log.compactInPlace(messages);
    if (this.sessionName) {
      try {
        rewriteSession(this.sessionName, messages);
      } catch {
        /* disk full / perms — in-memory compaction still helps this session */
      }
    }
  }

  /** Preventive end-of-turn shrink — trim big results before they ride into the next prompt. */
  private autoCompactToolResultsOnTurnEnd(): void {
    const before = this.log.toMessages();
    const shrunk = shrinkOversizedToolResultsByTokens(before, TURN_END_RESULT_CAP_TOKENS);
    if (shrunk.healedCount === 0) return;
    this.log.compactInPlace(shrunk.messages);
    if (this.sessionName) {
      try {
        rewriteSession(this.sessionName, shrunk.messages);
      } catch {
        /* disk full / perms — in-memory compaction still helps this session */
      }
    }
  }

  compact(maxTokens = 4000): {
    healedCount: number;
    tokensSaved: number;
    charsSaved: number;
  } {
    const before = this.log.toMessages();
    // Two-pass results+args. NOT healLoadedMessages — would strip an in-flight tool_calls tail.
    const resultsPass = shrinkOversizedToolResultsByTokens(before, maxTokens);
    const argsPass = shrinkOversizedToolCallArgsByTokens(resultsPass.messages, maxTokens);
    const messages = argsPass.messages;
    const healedCount = resultsPass.healedCount + argsPass.healedCount;
    const tokensSaved = resultsPass.tokensSaved + argsPass.tokensSaved;
    const charsSaved = resultsPass.charsSaved + argsPass.charsSaved;
    if (healedCount > 0) {
      this.log.compactInPlace(messages);
      if (this.sessionName) {
        try {
          rewriteSession(this.sessionName, messages);
        } catch {
          /* disk full or perms — compaction still applies in-memory */
        }
      }
    }
    return { healedCount, tokensSaved, charsSaved };
  }

  appendAndPersist(message: ChatMessage): void {
    this.log.append(message);
    if (this.sessionName) {
      try {
        appendSessionMessage(this.sessionName, message);
      } catch {
        /* disk full or permission denied shouldn't kill the chat */
      }
    }
  }

  /** Swap the just-appended assistant entry — used by self-correction to restore the original tool_calls without dropping reasoning_content. */
  private replaceTailAssistantMessage(message: ChatMessage): void {
    const entries = this.log.entries;
    const tail = entries[entries.length - 1];
    if (!tail || tail.role !== "assistant") return;
    const kept = entries.slice(0, -1);
    kept.push(message);
    this.log.compactInPlace(kept);
    if (this.sessionName) {
      try {
        rewriteSession(this.sessionName, kept);
      } catch {
        /* disk issue shouldn't block the in-memory swap */
      }
    }
  }

  /** "New chat" — drops messages but keeps session + immutable prefix (cache-first invariant). */
  clearLog(): { dropped: number } {
    const dropped = this.log.length;
    this.log.compactInPlace([]);
    if (this.sessionName) {
      try {
        rewriteSession(this.sessionName, []);
      } catch {
        /* disk issue shouldn't block the in-memory clear */
      }
    }
    this.scratch.reset();
    return { dropped };
  }

  configure(opts: ReconfigurableOptions): void {
    if (opts.model !== undefined) this.model = opts.model;
    if (opts.stream !== undefined) this._streamPreference = opts.stream;
    if (opts.reasoningEffort !== undefined) this.reasoningEffort = opts.reasoningEffort;
    if (opts.autoEscalate !== undefined) this.autoEscalate = opts.autoEscalate;

    if (opts.branch !== undefined) {
      if (typeof opts.branch === "number") {
        this.branchOptions = { budget: opts.branch };
      } else if (opts.branch && typeof opts.branch === "object") {
        this.branchOptions = opts.branch;
      } else {
        this.branchOptions = {};
      }
      this.branchEnabled = (this.branchOptions.budget ?? 1) > 1;
    }

    if (opts.harvest !== undefined) {
      const want =
        opts.harvest === true || (typeof opts.harvest === "object" && opts.harvest !== null);
      this.harvestEnabled = want || this.branchEnabled;
      if (typeof opts.harvest === "object" && opts.harvest !== null) {
        this.harvestOptions = opts.harvest;
      }
    } else if (this.branchEnabled) {
      // branch turned on without explicit harvest → force it on
      this.harvestEnabled = true;
    }

    // Branching always forces non-streaming; otherwise honor preference.
    this.stream = this.branchEnabled ? false : this._streamPreference;
  }

  /** `null` disables the cap; any change re-arms the 80% warning. */
  setBudget(usd: number | null): void {
    this.budgetUsd = typeof usd === "number" && usd > 0 ? usd : null;
    this._budgetWarned = false;
  }

  /** Single-turn upgrade consumed at next step() — distinct from `/preset max` (persistent). */
  armProForNextTurn(): void {
    this._proArmedForNextTurn = true;
  }
  /** Cancel `/pro` arming before the next turn starts. */
  disarmPro(): void {
    this._proArmedForNextTurn = false;
  }
  /** UI surface — true while `/pro` is queued but hasn't fired yet. */
  get proArmed(): boolean {
    return this._proArmedForNextTurn;
  }
  /** UI surface — true while the current turn is running on pro (armed or auto-escalated). */
  get escalatedThisTurn(): boolean {
    return this._escalateThisTurn;
  }

  private modelForCurrentCall(): string {
    return this._escalateThisTurn ? ESCALATION_MODEL : this.model;
  }

  /** Anchored to lead — mid-text matches are normal content (user asking about the marker). */
  private parseEscalationMarker(content: string): { matched: boolean; reason?: string } {
    const m = NEEDS_PRO_MARKER_RE.exec(content.trimStart());
    if (!m) return { matched: false };
    const reason = m[1]?.trim();
    return { matched: true, reason: reason || undefined };
  }

  /** Convenience boolean — same gate the streaming path used to call. */
  private isEscalationRequest(content: string): boolean {
    return this.parseEscalationMarker(content).matched;
  }

  /** Drives streaming flush — while plausibly partial, keep accumulating; else flush. */
  private looksLikePartialEscalationMarker(buf: string): boolean {
    const t = buf.trimStart();
    if (t.length === 0) return true;
    if (t.length <= NEEDS_PRO_MARKER_PREFIX.length) {
      return NEEDS_PRO_MARKER_PREFIX.startsWith(t);
    }
    if (!t.startsWith(NEEDS_PRO_MARKER_PREFIX)) return false;
    const rest = t.slice(NEEDS_PRO_MARKER_PREFIX.length);
    // Only `>` (close) or `:` (reason) are valid after the prefix.
    if (rest[0] !== ">" && rest[0] !== ":") return false;
    return true;
  }

  /** Returns true ONLY on the tipping call — caller surfaces a one-shot warning. */
  private noteToolFailureSignal(resultJson: string, repair?: RepairReport): boolean {
    let bumped = false;
    const bump = (kind: string, by = 1): void => {
      this._turnFailureCount += by;
      this._turnFailureTypes[kind] = (this._turnFailureTypes[kind] ?? 0) + by;
      bumped = true;
    };
    // edit_file / write_file SEARCH mismatch → `{"error":"Error: search text not found…"}`
    if (resultJson.includes('"error"') && resultJson.includes("search text not found")) {
      bump("search-mismatch");
    }
    // Per-flavor tagging so the warning can say "3× truncated" not "3 repair signals".
    if (repair) {
      if (repair.scavenged > 0) bump("scavenged", repair.scavenged);
      if (repair.truncationsFixed > 0) bump("truncated", repair.truncationsFixed);
      if (repair.stormsBroken > 0) bump("repeat-loop", repair.stormsBroken);
    }
    if (
      bumped &&
      !this._escalateThisTurn &&
      this.autoEscalate &&
      this._turnFailureCount >= FAILURE_ESCALATION_THRESHOLD
    ) {
      this._escalateThisTurn = true;
      return true;
    }
    return false;
  }

  private formatFailureBreakdown(): string {
    const parts = Object.entries(this._turnFailureTypes)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => `${n}× ${kind}`);
    return parts.length > 0 ? parts.join(", ") : `${this._turnFailureCount} repair/error signal(s)`;
  }

  private buildMessages(pendingUser: string | null): ChatMessage[] {
    // DeepSeek 400s on either unpaired tool_calls or stray tool entries — heal before sending.
    const healed = healLoadedMessages(this.log.toMessages(), DEFAULT_MAX_RESULT_CHARS);
    const msgs: ChatMessage[] = [...this.prefix.toMessages(), ...healed.messages];
    if (pendingUser !== null) msgs.push({ role: "user", content: pendingUser });
    return msgs;
  }

  abort(): void {
    this._turnAbort.abort();
  }

  /** Drop the last user message + everything after; caller re-sends. Persists to session file. */
  retryLastUser(): string | null {
    const entries = this.log.entries;
    let lastUserIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return null;
    const raw = entries[lastUserIdx]!.content;
    const userText = typeof raw === "string" ? raw : "";
    const preserved = entries.slice(0, lastUserIdx).map((m) => ({ ...m }));
    this.log.compactInPlace(preserved);
    if (this.sessionName) {
      try {
        rewriteSession(this.sessionName, preserved);
      } catch {
        /* disk-full / perms — in-memory compaction still applies */
      }
    }
    return userText;
  }

  async *step(userInput: string): AsyncGenerator<LoopEvent> {
    // Budget gate runs FIRST, before any per-turn state mutation, so a
    // refusal leaves the loop unchanged and the user can correct the
    // cap and re-issue. Default `null` short-circuits the whole check
    // so the no-budget path is one comparison, no behavior delta.
    if (this.budgetUsd !== null) {
      const spent = this.stats.totalCost;
      if (spent >= this.budgetUsd) {
        yield {
          turn: this._turn,
          role: "error",
          content: "",
          error: `session budget exhausted — spent $${spent.toFixed(4)} ≥ cap $${this.budgetUsd.toFixed(2)}. Bump the cap with /budget <usd>, clear it with /budget off, or end the session.`,
        };
        return;
      }
      if (!this._budgetWarned && spent >= this.budgetUsd * 0.8) {
        this._budgetWarned = true;
        yield {
          turn: this._turn,
          role: "warning",
          content: `▲ budget 80% used — $${spent.toFixed(4)} of $${this.budgetUsd.toFixed(2)}. Next turn or two likely trips the cap.`,
        };
      }
    }
    this._turn++;
    this.scratch.reset();
    // A fresh user turn is a new intent — don't let StormBreaker's
    // old sliding window of (name, args) signatures keep blocking
    // calls that are now legitimately on-task. The window repopulates
    // naturally as this turn's tool calls flow through.
    this.repair.resetStorm();
    // Per-turn escalation state: reset both flags at turn start, then
    // consume the /pro armed flag into `_escalateThisTurn` (so the
    // armed intent is one-shot — next turn starts fresh on flash
    // unless the user re-arms or mid-turn escalation triggers).
    this._turnFailureCount = 0;
    this._turnFailureTypes = {};
    this._turnSelfCorrected = false;
    this._escalateThisTurn = false;
    let armedConsumed = false;
    if (this._proArmedForNextTurn) {
      this._escalateThisTurn = true;
      this._proArmedForNextTurn = false;
      armedConsumed = true;
    }
    // Fresh controller for this turn: the prior step's signal has
    // already fired (or stayed clean); either way we don't want its
    // state to bleed into the new turn.
    //
    // Edge case — `loop.abort()` may have been called BEFORE step()
    // ran (race: caller fires abort during async setup, but step()
    // hadn't been awaited yet). Naively reassigning _turnAbort would
    // silently drop that abort. Forward the prior aborted state into
    // the fresh controller so the iter-0 check still bails out. This
    // is load-bearing for subagents: the parent's onParentAbort
    // listener calls childLoop.abort(), which can fire before
    // childLoop.step() has reached the `for await` line below.
    const carryAbort = this._turnAbort.signal.aborted;
    this._turnAbort = new AbortController();
    if (carryAbort) this._turnAbort.abort();
    const signal = this._turnAbort.signal;
    if (armedConsumed) {
      yield {
        turn: this._turn,
        role: "warning",
        content: "⇧ /pro armed — this turn runs on deepseek-v4-pro (one-shot · disarms after turn)",
      };
    }
    let pendingUser: string | null = userInput;
    const toolSpecs = this.prefix.tools();
    // 70% of the iter budget is the "you're getting close" threshold. We
    // only warn once per step so the user sees a single signal, not a
    // string of identical yellow lines stacked up.
    const warnAt = Math.max(1, Math.floor(this.maxToolIters * 0.7));
    let warnedForIterBudget = false;

    for (let iter = 0; iter < this.maxToolIters; iter++) {
      if (signal.aborted) {
        // Esc means "stop now" — not "stop and force another 30-90s
        // reasoner call to produce a summary I didn't ask for". The
        // user's mental model of cancel is immediate. We emit a
        // synthetic assistant_final (tagged forcedSummary so the
        // code-mode applier ignores it) with a short stopped
        // message, then done. The prior tool outputs are still in
        // the log if the user wants to continue — asking again
        // will hit a warm cache and be cheap.
        //
        // Budget / context-guard still call forceSummaryAfterIterLimit
        // because there the USER didn't choose to stop — we did —
        // and leaving them staring at nothing is worse than one extra
        // call.
        yield {
          turn: this._turn,
          role: "warning",
          content: `aborted at iter ${iter}/${this.maxToolIters} — stopped without producing a summary (press ↑ + Enter or /retry to resume)`,
        };
        const stoppedMsg =
          "[aborted by user (Esc) — no summary produced. Ask again or /retry when ready; prior tool output is still in the log.]";
        // Synthetic assistant turn — no real model output exists. For
        // reasoner sessions R1 still demands `reasoning_content` on
        // every assistant message, so we attach an empty-string
        // placeholder to satisfy the validator without inventing
        // reasoning we don't have. V3 gets a plain message as before.
        this.appendAndPersist(this.syntheticAssistantMessage(stoppedMsg));
        yield {
          turn: this._turn,
          role: "assistant_final",
          content: stoppedMsg,
          forcedSummary: true,
        };
        this.autoCompactToolResultsOnTurnEnd();
        yield { turn: this._turn, role: "done", content: stoppedMsg };
        // Reset to a fresh, non-aborted controller before returning.
        // Without this the carry-abort logic above sees the still-
        // aborted controller on the NEXT step() entry and immediately
        // re-aborts at iter 0, locking the session: every subsequent
        // user message produces "stopped without producing a summary"
        // before any work happens. A user-initiated Esc is a discrete
        // event tied to ONE turn; it must not bleed into the next.
        // (The race scenario the carry-abort handles — abort fired in
        // the async window before step() entry — still works: a fresh
        // abort() between turns aborts the new controller below.)
        this._turnAbort = new AbortController();
        return;
      }
      // Bridge the silence between the PREVIOUS iter's tool result and
      // THIS iter's first streaming byte. R1 can spend 20-90s reasoning
      // about tool output before the first delta lands, and prior to
      // this hint the UI had nothing to render. Only emit on iter > 0
      // because iter 0's "thinking" phase is already covered by the
      // streaming row / StreamingAssistant's placeholder.
      //
      // Wording is explicit about the two things happening: the tool
      // result IS being uploaded (it's now part of the next prompt) and
      // the model IS thinking. Users were reading "thinking about the
      // tool result" as the model-only phase, but the wait also covers
      // the upload round-trip.
      if (iter > 0) {
        yield {
          turn: this._turn,
          role: "status",
          content: "tool result uploaded · model thinking before next response…",
        };
      }
      if (!warnedForIterBudget && iter >= warnAt) {
        warnedForIterBudget = true;
        yield {
          turn: this._turn,
          role: "warning",
          content: `${iter}/${this.maxToolIters} tool calls used — approaching budget. Press Esc to force a summary now.`,
        };
      }
      let messages = this.buildMessages(pendingUser);

      // Preflight context check. Reactive auto-compact at 60%/80%
      // keys off the PREVIOUS turn's server-reported prompt_tokens,
      // so a single new oversized tool result (or a fresh resumed
      // session) can push this turn's request straight past 131,072
      // tokens before we ever see a usage number — DeepSeek 400s with
      // "maximum context length". Here we estimate the outgoing
      // payload locally and compact preemptively when it's in the red
      // zone (>95% of the model's context window). One cheap
      // tokenize-pass per iter, only on our side.
      {
        const ctxMax = DEEPSEEK_CONTEXT_TOKENS[this.model] ?? DEFAULT_CONTEXT_TOKENS;
        const estimate = estimateRequestTokens(messages, this.prefix.toolSpecs);
        if (estimate / ctxMax > 0.95) {
          const result = this.compact(1_000);
          if (result.healedCount > 0) {
            yield {
              turn: this._turn,
              role: "warning",
              content: `preflight: request ~${estimate.toLocaleString()}/${ctxMax.toLocaleString()} tokens (${Math.round(
                (estimate / ctxMax) * 100,
              )}%) — pre-compacted ${result.healedCount} tool result(s), saved ${result.tokensSaved.toLocaleString()} tokens. Sending.`,
            };
            // Rebuild with the compacted log so we send the smaller payload.
            messages = this.buildMessages(pendingUser);
          } else {
            yield {
              turn: this._turn,
              role: "warning",
              content: `preflight: request ~${estimate.toLocaleString()}/${ctxMax.toLocaleString()} tokens (${Math.round(
                (estimate / ctxMax) * 100,
              )}%) and nothing to auto-compact — DeepSeek will likely 400. Run /forget or /clear to start fresh.`,
            };
          }
        }
      }

      let assistantContent = "";
      let reasoningContent = "";
      let toolCalls: ToolCall[] = [];
      let usage: TurnStats["usage"] | null = null;

      let branchSummary: BranchSummary | undefined;
      let preHarvestedPlanState: TypedPlanState | undefined;

      try {
        if (this.branchEnabled) {
          const budget = this.branchOptions.budget ?? 1;
          yield {
            turn: this._turn,
            role: "branch_start",
            content: "",
            branchProgress: {
              completed: 0,
              total: budget,
              latestIndex: -1,
              latestTemperature: -1,
              latestUncertainties: -1,
            },
          };

          // Queue samples as they complete so we can yield progress events
          // in resolution order (not launch order).
          const queue: BranchSample[] = [];
          let waiter: ((s: BranchSample) => void) | null = null;

          const onSampleDone = (sample: BranchSample) => {
            if (waiter) {
              const w = waiter;
              waiter = null;
              w(sample);
            } else {
              queue.push(sample);
            }
          };

          const callModel = this.modelForCurrentCall();
          const branchPromise = runBranches(
            this.client,
            {
              model: callModel,
              messages,
              tools: toolSpecs.length ? toolSpecs : undefined,
              signal,
              thinking: thinkingModeForModel(callModel),
              reasoningEffort: this.reasoningEffort,
            },
            {
              ...this.branchOptions,
              harvestOptions: this.harvestOptions,
              onSampleDone,
            },
          );

          for (let k = 0; k < budget; k++) {
            const sample: BranchSample =
              queue.shift() ??
              (await new Promise<BranchSample>((resolve) => {
                waiter = resolve;
              }));
            yield {
              turn: this._turn,
              role: "branch_progress",
              content: "",
              branchProgress: {
                completed: k + 1,
                total: budget,
                latestIndex: sample.index,
                latestTemperature: sample.temperature,
                latestUncertainties: sample.planState.uncertainties.length,
              },
            };
          }

          const result = await branchPromise;
          assistantContent = result.chosen.response.content;
          reasoningContent = result.chosen.response.reasoningContent ?? "";
          toolCalls = result.chosen.response.toolCalls;

          // Cost accounting: sum usage across ALL samples, not just the winner.
          // (We paid for all three.) Harvest-call tokens are not tracked; they
          // amount to rounding error compared to the main R1 calls.
          const agg = aggregateBranchUsage(result.samples);
          usage = new Usage(
            agg.promptTokens,
            agg.completionTokens,
            agg.totalTokens,
            agg.promptCacheHitTokens,
            agg.promptCacheMissTokens,
          );
          preHarvestedPlanState = result.chosen.planState;
          branchSummary = summarizeBranch(result.chosen, result.samples);
          yield {
            turn: this._turn,
            role: "branch_done",
            content: "",
            branch: branchSummary,
          };
        } else if (this.stream) {
          const callBuf: Map<number, ToolCall> = new Map();
          // Indices whose accumulated args have parsed as valid JSON at
          // least once. Purely informational — we don't dispatch until
          // the stream ends (that's the eager-dispatch feature we
          // intentionally punted) but the UI shows "N ready" so the
          // user sees progress on long multi-tool turns instead of a
          // stagnant "building tool call" spinner.
          const readyIndices = new Set<number>();
          const callModel = this.modelForCurrentCall();
          // Escalation-marker buffer: delay the first few assistant_delta
          // yields so a "<<<NEEDS_PRO>>>" lead-in never flashes on-screen
          // before we abort + retry. Only active on flash AND when the
          // user hasn't disabled auto-escalation (the `flash` preset
          // turns this off — model output flows through verbatim, no
          // marker handling). pro never requests its own escalation.
          const bufferForEscalation = this.autoEscalate && callModel !== ESCALATION_MODEL;
          let escalationBuf = "";
          let escalationBufFlushed = false;
          for await (const chunk of this.client.stream({
            model: callModel,
            messages,
            tools: toolSpecs.length ? toolSpecs : undefined,
            signal,
            thinking: thinkingModeForModel(callModel),
            reasoningEffort: this.reasoningEffort,
          })) {
            if (chunk.contentDelta) {
              assistantContent += chunk.contentDelta;
              if (bufferForEscalation && !escalationBufFlushed) {
                escalationBuf += chunk.contentDelta;
                // Early exit: marker matches — break and let the
                // post-call retry path take over. No delta was yielded
                // so the user sees nothing flicker.
                if (this.isEscalationRequest(escalationBuf)) {
                  break;
                }
                // Flush once we have enough content to rule out the
                // marker (clearly not a partial match anymore, or past
                // the look-ahead window).
                if (
                  escalationBuf.length >= NEEDS_PRO_BUFFER_CHARS ||
                  !this.looksLikePartialEscalationMarker(escalationBuf)
                ) {
                  escalationBufFlushed = true;
                  yield {
                    turn: this._turn,
                    role: "assistant_delta",
                    content: escalationBuf,
                  };
                  escalationBuf = "";
                }
              } else {
                yield {
                  turn: this._turn,
                  role: "assistant_delta",
                  content: chunk.contentDelta,
                };
              }
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

              // Mark this index "ready" once its args first parse as
              // valid JSON. JSON.parse is sub-millisecond on typical
              // tool-call payloads; skip the check once already ready.
              if (
                !readyIndices.has(d.index) &&
                cur.function.name &&
                looksLikeCompleteJson(cur.function.arguments ?? "")
              ) {
                readyIndices.add(d.index);
              }

              // Skip the id-only opener: name is empty until the next chunk.
              if (cur.function.name) {
                yield {
                  turn: this._turn,
                  role: "tool_call_delta",
                  content: "",
                  toolName: cur.function.name,
                  toolCallArgsChars: (cur.function.arguments ?? "").length,
                  toolCallIndex: d.index,
                  toolCallReadyCount: readyIndices.size,
                };
              }
            }
            if (chunk.usage) usage = chunk.usage;
          }
          toolCalls = [...callBuf.values()];
          // Stream ended before the escalation buffer got flushed —
          // either a short response or a partial marker match. If the
          // buffer ISN'T the marker, flush it as the final delta so
          // the user sees it. Marker-match is handled post-call.
          if (bufferForEscalation && !escalationBufFlushed && escalationBuf.length > 0) {
            if (!this.isEscalationRequest(escalationBuf)) {
              yield {
                turn: this._turn,
                role: "assistant_delta",
                content: escalationBuf,
              };
            }
          }
        } else {
          const callModel = this.modelForCurrentCall();
          const resp = await this.client.chat({
            model: callModel,
            messages,
            tools: toolSpecs.length ? toolSpecs : undefined,
            signal,
            thinking: thinkingModeForModel(callModel),
            reasoningEffort: this.reasoningEffort,
          });
          assistantContent = resp.content;
          reasoningContent = resp.reasoningContent ?? "";
          toolCalls = resp.toolCalls;
          usage = resp.usage;
        }
      } catch (err) {
        // An aborted signal here is almost always our own doing —
        // either Esc, or App.tsx calling `loop.abort()` to switch to a
        // queued synthetic input (ShellConfirm "always allow", PlanConfirm
        // approve, etc.). The DeepSeek client's fetch path translates
        // the abort into a generic `AbortError("This operation was
        // aborted")`, which used to bubble up here and render as a
        // scary red "error" row even though nothing actually broke.
        // Treat it as a clean early-exit instead: the next turn (queued
        // synthetic OR user re-prompt) starts immediately and gets to
        // produce its own answer.
        if (signal.aborted) {
          this.autoCompactToolResultsOnTurnEnd();
          yield { turn: this._turn, role: "done", content: "" };
          // Reset the controller so the carry-abort check at the top of
          // the NEXT step() doesn't inherit this turn's aborted state.
          // Without this, a queued-submit triggered by App.tsx (e.g.
          // ShellConfirm "run once" → loop.abort() + setQueuedSubmit)
          // produces a spurious "aborted at iter 0/64" the moment the
          // synthetic message starts processing, locking the session.
          this._turnAbort = new AbortController();
          return;
        }
        yield {
          turn: this._turn,
          role: "error",
          content: "",
          error: formatLoopError(err as Error),
        };
        return;
      }

      // Self-reported escalation: the model (flash) emitted the
      // NEEDS_PRO marker as its lead-in. Abort this call's accounting,
      // flip the turn to pro, and re-enter the iter without advancing
      // the counter — next attempt runs on v4-pro with the same
      // messages. Only triggers when the call was on a model OTHER
      // than the escalation model; if the user already configured
      // v4-pro (via /preset max etc.), the marker is taken as a
      // no-op content and passed through verbatim, so there's no
      // infinite-retry loop.
      if (
        this.autoEscalate &&
        this.modelForCurrentCall() !== ESCALATION_MODEL &&
        this.isEscalationRequest(assistantContent)
      ) {
        const { reason } = this.parseEscalationMarker(assistantContent);
        this._escalateThisTurn = true;
        const reasonSuffix = reason ? ` — ${reason}` : "";
        yield {
          turn: this._turn,
          role: "warning",
          content: `⇧ flash requested escalation — retrying this turn on ${ESCALATION_MODEL}${reasonSuffix}`,
        };
        // Reset per-iter state. We don't record stats for the rejected
        // flash call (cost is small — a ~20-token lead-in that we broke
        // out of early on streaming) — recording would attribute a
        // phantom call to the session total.
        assistantContent = "";
        reasoningContent = "";
        toolCalls = [];
        usage = null;
        branchSummary = undefined;
        preHarvestedPlanState = undefined;
        // Redo this iter on pro — `iter--` cancels the `iter++` the
        // for loop runs on `continue`.
        iter--;
        continue;
      }

      // Attribute under the actual model used (escalated → pro, else
      // this.model) so cost/usage logs reflect reality.
      const turnStats = this.stats.record(
        this._turn,
        this.modelForCurrentCall(),
        usage ?? new Usage(),
      );

      // Commit the user turn to the log only on success of the first round-trip.
      if (pendingUser !== null) {
        this.appendAndPersist({ role: "user", content: pendingUser });
        pendingUser = null;
      }

      this.scratch.reasoning = reasoningContent || null;
      // Harvest is a second API round-trip (cheap model, but still
      // 1-10s) that was previously silent. Bridge the gap with a
      // status indicator so the TUI shows *something* instead of
      // "reasoning finished, now staring at the wall."
      if (
        !preHarvestedPlanState &&
        this.harvestEnabled &&
        (reasoningContent?.trim().length ?? 0) >= 40
      ) {
        yield {
          turn: this._turn,
          role: "status",
          content: "extracting plan state from reasoning…",
        };
      }
      const planState = preHarvestedPlanState
        ? preHarvestedPlanState
        : this.harvestEnabled
          ? await harvest(reasoningContent || null, this.client, this.harvestOptions, signal)
          : emptyPlanState();

      const { calls: repairedCalls, report } = this.repair.process(
        toolCalls,
        reasoningContent || null,
        assistantContent || null,
      );

      this.appendAndPersist(
        this.assistantMessage(
          assistantContent,
          repairedCalls,
          this.modelForCurrentCall(),
          reasoningContent,
        ),
      );

      yield {
        turn: this._turn,
        role: "assistant_final",
        content: assistantContent,
        stats: turnStats,
        planState,
        repair: report,
        branch: branchSummary,
      };

      // Cost-aware escalation: repair fires (scavenge / truncation /
      // storm) are visible "model struggled" signals. Feed them into
      // the turn failure counter — if we hit the threshold, the
      // remainder of this turn's model calls use pro.
      if (this.noteToolFailureSignal("", report)) {
        yield {
          turn: this._turn,
          role: "warning",
          content: `⇧ auto-escalating to ${ESCALATION_MODEL} for the rest of this turn — flash hit ${this.formatFailureBreakdown()}. Next turn falls back to ${this.model} unless /pro is armed.`,
        };
      }

      const allSuppressed =
        report.stormsBroken > 0 && repairedCalls.length === 0 && toolCalls.length > 0;

      // First all-suppressed storm: rewrite tail with the original tool_calls
      // (so the next prompt shows what was attempted), stub tool responses to
      // keep the API contract, and continue the iter — model gets one shot to
      // self-correct before the loud-warning path takes over.
      if (allSuppressed && !this._turnSelfCorrected) {
        this._turnSelfCorrected = true;
        this.replaceTailAssistantMessage(
          this.assistantMessage(
            assistantContent,
            toolCalls,
            this.modelForCurrentCall(),
            reasoningContent,
          ),
        );
        for (const call of toolCalls) {
          this.appendAndPersist({
            role: "tool",
            tool_call_id: call.id ?? "",
            name: call.function?.name ?? "",
            content:
              "[repeat-loop guard] this call was suppressed because it was identical to a previous call in this turn. Earlier results for it are above — try a meaningfully different approach, or stop and answer if you have enough.",
          });
        }
        yield {
          turn: this._turn,
          role: "warning",
          content:
            "Caught a repeated tool call — let the model see the issue and retry with a different approach.",
        };
        continue;
      }

      if (report.stormsBroken > 0) {
        const noteTail = report.notes.length ? ` — ${report.notes[report.notes.length - 1]}` : "";
        const phrase = allSuppressed
          ? "Stopped a stuck retry loop — the model kept calling the same tool with identical args after a self-correction nudge. Try /retry, rephrase, or rule out the underlying blocker."
          : `Suppressed ${report.stormsBroken} repeated tool call(s) — same name + args fired 3+ times.`;
        yield {
          turn: this._turn,
          role: "warning",
          content: `${phrase}${noteTail}`,
        };
      }

      if (repairedCalls.length === 0) {
        if (allSuppressed) {
          yield* this.forceSummaryAfterIterLimit({ reason: "stuck" });
          return;
        }
        this.autoCompactToolResultsOnTurnEnd();
        yield { turn: this._turn, role: "done", content: assistantContent };
        return;
      }

      // Token-budget guard — the real stop condition. Iter count is a
      // proxy that misses the actual constraint: how close the prompt
      // already is to DeepSeek's 131k context. If we're over 80%, the
      // NEXT call (with the just-executed tools' results stuffed into
      // history) will be worse, and fairly soon it'll 400 with
      // "maximum context length".
      //
      // Strategy, in order:
      //   1. Try auto-compacting the log (shrink oversized tool
      //      results). If that gets us back under 80% we keep going —
      //      the user doesn't lose their turn to a premature summary.
      //   2. If still over after compact, divert to the forced-summary
      //      path. BUT first drop the trailing assistant-with-tool_calls
      //      that we just appended — we haven't executed the tools yet,
      //      so sending this to the summary call with no matching tool
      //      responses would 400 ("insufficient tool messages following
      //      tool_calls"). The summary is about what was LEARNED so far,
      //      not what we intended to do next.
      const ctxMax = DEEPSEEK_CONTEXT_TOKENS[this.model] ?? DEFAULT_CONTEXT_TOKENS;
      // Proactive 40-80% pre-shrink to 4k so we don't fall into the 80% reactive 1k cap.
      if (usage) {
        const ratio = usage.promptTokens / ctxMax;
        if (ratio > 0.4 && ratio <= 0.8) {
          const before = usage.promptTokens;
          const soft = this.compact(4_000);
          if (soft.healedCount > 0) {
            const after = Math.max(0, before - soft.tokensSaved);
            yield {
              turn: this._turn,
              role: "warning",
              content: `context ${before.toLocaleString()}/${ctxMax.toLocaleString()} (${Math.round(
                ratio * 100,
              )}%) — proactively compacted ${soft.healedCount} tool result(s) to 4k tokens, saved ${soft.tokensSaved.toLocaleString()} tokens (now ~${after.toLocaleString()}). Staying ahead of the 80% guard.`,
            };
          }
        }
      }
      if (usage && usage.promptTokens / ctxMax > 0.8) {
        const before = usage.promptTokens;
        const compactResult = this.compact(1_000);
        if (compactResult.healedCount > 0) {
          const after = Math.max(0, before - compactResult.tokensSaved);
          yield {
            turn: this._turn,
            role: "warning",
            content: `context ${before.toLocaleString()}/${ctxMax.toLocaleString()} — auto-compacted ${compactResult.healedCount} oversized tool result(s), saved ${compactResult.tokensSaved.toLocaleString()} tokens (now ~${after.toLocaleString()}). Continuing.`,
          };
          // Intentionally don't re-check the threshold here: even if
          // compaction didn't fully clear us under 80%, one more tool
          // call's overhead isn't going to overflow, and the NEXT
          // iter's fresh `usage` from the API will catch real danger.
        } else {
          yield {
            turn: this._turn,
            role: "warning",
            content: `context ${before.toLocaleString()}/${ctxMax.toLocaleString()} (${Math.round(
              (before / ctxMax) * 100,
            )}%) — nothing to auto-compact. Forcing summary from what was gathered.`,
          };
          // Drop the trailing assistant-with-tool_calls we just
          // appended. The forced-summary call would otherwise trip
          // DeepSeek's "insufficient tool messages following tool_calls"
          // validator, since we bail BEFORE dispatching the tools.
          const tail = this.log.entries[this.log.entries.length - 1];
          if (
            tail &&
            tail.role === "assistant" &&
            Array.isArray(tail.tool_calls) &&
            tail.tool_calls.length > 0
          ) {
            const kept = this.log.entries.slice(0, -1);
            this.log.compactInPlace([...kept]);
            if (this.sessionName) {
              try {
                rewriteSession(this.sessionName, kept);
              } catch {
                /* disk issue shouldn't block the summary path */
              }
            }
          }
          yield* this.forceSummaryAfterIterLimit({ reason: "context-guard" });
          return;
        }
      }

      for (const call of repairedCalls) {
        const name = call.function?.name ?? "";
        const args = call.function?.arguments ?? "{}";
        // Announce the tool BEFORE awaiting it so the TUI can render a
        // "running…" indicator. Without this, the window between
        // assistant_final and the tool-result yield is silent from the
        // UI's perspective — which makes long tool calls feel like the
        // app has hung.
        yield {
          turn: this._turn,
          role: "tool_start",
          content: "",
          toolName: name,
          toolArgs: args,
        };

        // PreToolUse hooks. A `block` decision (exit 2) skips dispatch
        // and surfaces the hook's stderr as the tool result so the model
        // sees a structured refusal instead of a silent omission. Non-
        // block non-zero outcomes are warnings: the loop continues, the
        // UI gets a yellow row.
        const parsedArgs = safeParseToolArgs(args);
        const preReport = await runHooks({
          hooks: this.hooks,
          payload: {
            event: "PreToolUse",
            cwd: this.hookCwd,
            toolName: name,
            toolArgs: parsedArgs,
          },
        });
        for (const w of hookWarnings(preReport.outcomes, this._turn)) yield w;

        let result: string;
        if (preReport.blocked) {
          const blocking = preReport.outcomes[preReport.outcomes.length - 1];
          const reason = (
            blocking?.stderr ||
            blocking?.stdout ||
            "blocked by PreToolUse hook"
          ).trim();
          result = `[hook block] ${blocking?.hook.command ?? "<unknown>"}\n${reason}`;
        } else {
          result = await this.tools.dispatch(name, args, {
            signal,
            maxResultTokens: DEFAULT_MAX_RESULT_TOKENS,
          });

          // PostToolUse hooks — block is meaningless after the fact, so
          // every non-pass outcome is a warning. Hooks here are the
          // natural place for "after every edit, run the formatter."
          const postReport = await runHooks({
            hooks: this.hooks,
            payload: {
              event: "PostToolUse",
              cwd: this.hookCwd,
              toolName: name,
              toolArgs: parsedArgs,
              toolResult: result,
            },
          });
          for (const w of hookWarnings(postReport.outcomes, this._turn)) yield w;
        }

        this.appendAndPersist({
          role: "tool",
          tool_call_id: call.id ?? "",
          name,
          content: result,
        });
        // Auto-shrink the matching tool_call's args now that the tool
        // has responded. No-op when args are under the threshold; when
        // over, the next turn's prompt + cache key carry the compact
        // marker instead of the raw SEARCH/REPLACE payload. See
        // compactToolCallArgsAfterResponse for the trade-offs.
        this.compactToolCallArgsAfterResponse();
        // Cost-aware escalation: check for "flash is struggling" shapes
        // (SEARCH-not-found, etc). If threshold hits here, surface a
        // one-time warning so the user knows the next call upgraded.
        if (this.noteToolFailureSignal(result)) {
          yield {
            turn: this._turn,
            role: "warning",
            content: `⇧ auto-escalating to ${ESCALATION_MODEL} for the rest of this turn — flash hit ${this.formatFailureBreakdown()}. Next turn falls back to ${this.model} unless /pro is armed.`,
          };
        }
        yield {
          turn: this._turn,
          role: "tool",
          content: result,
          toolName: name,
          toolArgs: args,
        };
      }
    }

    // We exhausted the tool-call budget while the model still wanted to
    // call more tools. Rather than stopping silently (which leaves the
    // user staring at a blank prompt), force one final no-tools call so
    // the model must produce a text summary from everything it has
    // already seen.
    yield* this.forceSummaryAfterIterLimit({ reason: "budget" });
  }

  private async *forceSummaryAfterIterLimit(
    opts: { reason: "budget" | "aborted" | "context-guard" | "stuck" } = { reason: "budget" },
  ): AsyncGenerator<LoopEvent> {
    try {
      // The summary call is non-streaming (reasoner, 30-60s typical).
      // Without this status the user sees nothing happening after the
      // yellow "budget reached" warning until the summary arrives.
      yield {
        turn: this._turn,
        role: "status",
        content: "summarizing what was gathered…",
      };
      const messages = this.buildMessages(null);
      // Passing `tools: undefined` was supposed to force a text
      // response, but R1 can still hallucinate tool-call markup
      // (e.g. DSML `<｜DSML｜function_calls>…</｜DSML｜function_calls>`)
      // in prose when it's been primed by prior tool use. An explicit
      // user-role instruction plus post-hoc stripping of known
      // hallucination shapes keeps the user from seeing raw markup.
      messages.push({
        role: "user",
        content:
          "I'm out of tool-call budget for this turn. Summarize in plain prose what you learned from the tool results above. Do NOT emit any tool calls, function-call markup, DSML invocations, or SEARCH/REPLACE edit blocks — they will be silently discarded. Just plain text.",
      });
      // Cost optimization: the forced summary is a wrap-up of work
      // already done, not fresh reasoning. Pin it to flash with
      // effort=high regardless of the main turn's model — pro is
      // 12× overkill for "paraphrase these tool results into prose."
      // Budget-exhausted turns are exactly when we DON'T want to
      // also torch the wallet.
      const summaryModel = "deepseek-v4-flash";
      const summaryEffort: "high" | "max" = "high";
      const resp = await this.client.chat({
        model: summaryModel,
        messages,
        // no tools → model is forced to answer in text
        signal: this._turnAbort.signal,
        thinking: thinkingModeForModel(summaryModel),
        reasoningEffort: summaryEffort,
      });
      const rawContent = resp.content?.trim() ?? "";
      const cleaned = stripHallucinatedToolMarkup(rawContent);
      const summary =
        cleaned ||
        "(model emitted fake tool-call markup instead of a prose summary — try /retry with a narrower question, or /think to inspect R1's reasoning)";
      const reasonPrefix = reasonPrefixFor(opts.reason, this.maxToolIters);
      const annotated = `${reasonPrefix}\n\n${summary}`;
      // Record under the actual model used (flash), not `this.model`,
      // so per-turn cost and `/stats` reflect reality.
      const summaryStats = this.stats.record(this._turn, summaryModel, resp.usage ?? new Usage());
      this.appendAndPersist(
        this.assistantMessage(summary, [], summaryModel, resp.reasoningContent),
      );
      yield {
        turn: this._turn,
        role: "assistant_final",
        content: annotated,
        stats: summaryStats,
        forcedSummary: true,
      };
      this.autoCompactToolResultsOnTurnEnd();
      yield { turn: this._turn, role: "done", content: summary };
    } catch (err) {
      const label = errorLabelFor(opts.reason, this.maxToolIters);
      yield {
        turn: this._turn,
        role: "error",
        content: "",
        error: `${label} and the fallback summary call failed: ${(err as Error).message}. Run /clear and retry with a narrower question, or raise --max-tool-iters.`,
      };
      this.autoCompactToolResultsOnTurnEnd();
      yield { turn: this._turn, role: "done", content: "" };
    }
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

  /** Thinking-mode producer ⇒ reasoning_content MUST be set (even ""), or next call 400s. */
  private assistantMessage(
    content: string,
    toolCalls: ToolCall[],
    producingModel: string,
    reasoningContent?: string | null,
  ): ChatMessage {
    const msg: ChatMessage = { role: "assistant", content };
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    // V4-era deepseek-chat returns reasoning_content even with thinking.type
    // disabled, and the API rejects round-trips that drop it. Whitelist on
    // model name is too brittle — preserve whenever the producer emitted any.
    if (isThinkingModeModel(producingModel) || (reasoningContent && reasoningContent.length > 0)) {
      msg.reasoning_content = reasoningContent ?? "";
    }
    return msg;
  }

  /** Abort notices etc — uses this.model as stand-in producer for the thinking-mode stamp. */
  private syntheticAssistantMessage(content: string): ChatMessage {
    return this.assistantMessage(content, [], this.model, "");
  }
}

/** True when the model emits reasoning_content and requires it round-tripped on follow-ups. */
export function isThinkingModeModel(model: string): boolean {
  if (model.includes("reasoner")) return true;
  if (model === "deepseek-v4-flash" || model === "deepseek-v4-pro") return true;
  return false;
}

/** Pins extra_body.thinking.type; `undefined` lets third-party endpoints skip the field. */
export function thinkingModeForModel(model: string): "enabled" | "disabled" | undefined {
  if (model === "deepseek-chat") return "disabled";
  if (model.includes("reasoner")) return "enabled";
  if (model === "deepseek-v4-flash" || model === "deepseek-v4-pro") return "enabled";
  return undefined;
}

/** Strip hallucinated tool-call envelopes — `tools: undefined` doesn't always force prose. */
export function stripHallucinatedToolMarkup(s: string): string {
  let out = s;
  // DeepSeek's DSML envelope (both the full-width "｜" character and
  // the ASCII-only fallback we've seen — the full-width form is the
  // one R1 emits in practice)
  out = out.replace(/<｜DSML｜function_calls>[\s\S]*?<\/?｜DSML｜function_calls>/g, "");
  out = out.replace(/<\|DSML\|function_calls>[\s\S]*?<\/?\|DSML\|function_calls>/g, "");
  // Anthropic / generic XML-ish envelope
  out = out.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "");
  // Lone unpaired DSML opener left over after the closer was on a
  // different line (seen when R1 truncates mid-call).
  out = out.replace(/<｜DSML｜[\s\S]*$/g, "");
  return out.trim();
}

function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function safeParseToolArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** UI progress feedback only — NOT a dispatch gate. */
export function looksLikeCompleteJson(s: string): boolean {
  if (!s || !s.trim()) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/** Format non-pass hook outcomes as `LoopEvent`s of role `warning`. */
function* hookWarnings(outcomes: HookOutcome[], turn: number): Generator<LoopEvent> {
  for (const o of outcomes) {
    if (o.decision === "pass") continue;
    yield { turn, role: "warning", content: formatHookOutcomeMessage(o) };
  }
}

function reasonPrefixFor(
  reason: "budget" | "aborted" | "context-guard" | "stuck",
  iterCap: number,
): string {
  if (reason === "aborted") return "[aborted by user (Esc) — summarizing what I found so far]";
  if (reason === "context-guard") {
    return "[context budget running low — summarizing before the next call would overflow]";
  }
  if (reason === "stuck") {
    return "[stuck on a repeated tool call — explaining what was tried and what's blocking progress]";
  }
  return `[tool-call budget (${iterCap}) reached — forcing summary from what I found]`;
}

function errorLabelFor(
  reason: "budget" | "aborted" | "context-guard" | "stuck",
  iterCap: number,
): string {
  if (reason === "aborted") return "aborted by user";
  if (reason === "context-guard") return "context-guard triggered (prompt > 80% of window)";
  if (reason === "stuck") return "stuck (repeated tool call suppressed by storm-breaker)";
  return `tool-call budget (${iterCap}) reached`;
}

function summarizeBranch(chosen: BranchSample, samples: BranchSample[]): BranchSummary {
  return {
    budget: samples.length,
    chosenIndex: chosen.index,
    uncertainties: samples.map((s) => s.planState.uncertainties.length),
    temperatures: samples.map((s) => s.temperature),
  };
}

/** Tool-role only — truncating user prompts would corrupt authored intent. */
export function shrinkOversizedToolResults(
  messages: ChatMessage[],
  maxChars: number,
): { messages: ChatMessage[]; healedCount: number; healedFrom: number } {
  let healedCount = 0;
  let healedFrom = 0;
  const out = messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length <= maxChars) return msg;
    healedCount += 1;
    healedFrom += content.length;
    return { ...msg, content: truncateForModel(content, maxChars) };
  });
  return { messages: out, healedCount, healedFrom };
}

/** Token-cap variant — char cap would let CJK slip past at 2× the intended token cost. */
export function shrinkOversizedToolResultsByTokens(
  messages: ChatMessage[],
  maxTokens: number,
): {
  messages: ChatMessage[];
  healedCount: number;
  tokensSaved: number;
  charsSaved: number;
} {
  let healedCount = 0;
  let tokensSaved = 0;
  let charsSaved = 0;
  const out = messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const content = typeof msg.content === "string" ? msg.content : "";
    // length ≤ maxTokens ⇒ tokens ≤ maxTokens — skip the per-message tokenize.
    if (content.length <= maxTokens) return msg;
    const beforeTokens = countTokens(content);
    if (beforeTokens <= maxTokens) return msg;
    const truncated = truncateForModelByTokens(content, maxTokens);
    const afterTokens = countTokens(truncated);
    healedCount += 1;
    tokensSaved += Math.max(0, beforeTokens - afterTokens);
    charsSaved += Math.max(0, content.length - truncated.length);
    return { ...msg, content: truncated };
  });
  return { messages: out, healedCount, tokensSaved, charsSaved };
}

/** Caller must gate on paired tool_calls — in-flight calls would crash mid-turn. */
export function shrinkOversizedToolCallArgsByTokens(
  messages: ChatMessage[],
  maxTokens: number,
): {
  messages: ChatMessage[];
  healedCount: number;
  tokensSaved: number;
  charsSaved: number;
} {
  let healedCount = 0;
  let tokensSaved = 0;
  let charsSaved = 0;
  const out = messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) return msg;
    let changed = false;
    const newCalls = msg.tool_calls.map((call) => {
      const args = call.function?.arguments;
      if (typeof args !== "string" || args.length <= maxTokens) return call;
      const beforeTokens = countTokens(args);
      if (beforeTokens <= maxTokens) return call;
      const shrunk = shrinkJsonLongStrings(args);
      const afterTokens = countTokens(shrunk);
      // Many-short-strings payloads can come back marginally larger — only swap on real saving.
      if (afterTokens >= beforeTokens) return call;
      changed = true;
      healedCount += 1;
      tokensSaved += beforeTokens - afterTokens;
      charsSaved += args.length - shrunk.length;
      return { ...call, function: { ...call.function, arguments: shrunk } };
    });
    if (!changed) return msg;
    return { ...msg, tool_calls: newCalls };
  });
  return { messages: out, healedCount, tokensSaved, charsSaved };
}

/** Keeps short keys/values (paths, ids) verbatim; only long string values get a marker. */
function shrinkJsonLongStrings(jsonStr: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const head = jsonStr.slice(0, 200);
    return `${head}…[shrunk: ${jsonStr.length} chars, unparsed]`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return jsonStr;
  }
  const LONG_THRESHOLD = 300;
  const input = parsed as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" && v.length > LONG_THRESHOLD) {
      const newlines = v.match(/\n/g)?.length ?? 0;
      output[k] =
        `[…shrunk: ${v.length} chars, ${newlines} lines — tool already responded, see result]`;
    } else {
      output[k] = v;
    }
  }
  return JSON.stringify(output);
}

/** Drops both unpaired assistant.tool_calls and stray tool messages — DeepSeek 400s on either. */
export function fixToolCallPairing(messages: ChatMessage[]): {
  messages: ChatMessage[];
  droppedAssistantCalls: number;
  droppedStrayTools: number;
} {
  const out: ChatMessage[] = [];
  let droppedAssistantCalls = 0;
  let droppedStrayTools = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const needed = new Set<string>();
      for (const call of msg.tool_calls) {
        if (call?.id) needed.add(call.id);
      }
      const candidates: ChatMessage[] = [];
      let j = i + 1;
      while (j < messages.length && needed.size > 0) {
        const nxt = messages[j]!;
        if (nxt.role !== "tool") break;
        const id = nxt.tool_call_id ?? "";
        if (!needed.has(id)) break;
        needed.delete(id);
        candidates.push(nxt);
        j++;
      }
      if (needed.size === 0) {
        out.push(msg);
        for (const r of candidates) out.push(r);
        i = j - 1;
      } else {
        droppedAssistantCalls += 1;
        droppedStrayTools += candidates.length;
        i = j - 1;
      }
      continue;
    }
    if (msg.role === "tool") {
      droppedStrayTools += 1;
      continue;
    }
    out.push(msg);
  }
  return { messages: out, droppedAssistantCalls, droppedStrayTools };
}

export function healLoadedMessages(
  messages: ChatMessage[],
  maxChars: number,
): { messages: ChatMessage[]; healedCount: number; healedFrom: number } {
  const shrunk = shrinkOversizedToolResults(messages, maxChars);
  const paired = fixToolCallPairing(shrunk.messages);
  const healedCount = shrunk.healedCount + paired.droppedAssistantCalls + paired.droppedStrayTools;
  return { messages: paired.messages, healedCount, healedFrom: shrunk.healedFrom };
}

/** Back-fills "" on bare assistant turns; skipped on non-thinking to avoid prefix-cache churn. */
export function stampMissingReasoningForThinkingMode(
  messages: ChatMessage[],
  model: string,
): { messages: ChatMessage[]; stampedCount: number } {
  if (!isThinkingModeModel(model)) {
    return { messages, stampedCount: 0 };
  }
  let stampedCount = 0;
  const out = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    if (Object.hasOwn(msg, "reasoning_content")) return msg;
    stampedCount += 1;
    return { ...msg, reasoning_content: "" };
  });
  return { messages: out, stampedCount };
}

/** Token-cap variant — char cap would let CJK slip past at 2× the intended token cost. */
export function healLoadedMessagesByTokens(
  messages: ChatMessage[],
  maxTokens: number,
): {
  messages: ChatMessage[];
  healedCount: number;
  tokensSaved: number;
  charsSaved: number;
} {
  const shrunk = shrinkOversizedToolResultsByTokens(messages, maxTokens);
  const paired = fixToolCallPairing(shrunk.messages);
  const healedCount = shrunk.healedCount + paired.droppedAssistantCalls + paired.droppedStrayTools;
  return {
    messages: paired.messages,
    healedCount,
    tokensSaved: shrunk.tokensSaved,
    charsSaved: shrunk.charsSaved,
  };
}

/** Single text-layer DeepSeek-error formatter — 429/5xx never reach here (retry.ts swallows). */
export function formatLoopError(err: Error): string {
  const msg = err.message ?? "";
  if (msg.includes("maximum context length")) {
    const reqMatch = msg.match(/requested\s+(\d+)\s+tokens/);
    const requested = reqMatch
      ? `${Number(reqMatch[1]).toLocaleString()} tokens`
      : "too many tokens";
    return `Context overflow (DeepSeek 400): session history is ${requested}, past the model's prompt limit (V4: 1M tokens; legacy chat/reasoner: 131k). Usually a single tool result grew too big. Reasonix caps new tool results at 8k tokens and auto-heals oversized history on session load — a restart often clears it. If it still overflows, run /forget (delete the session) or /clear (drop the displayed history) to start fresh.`;
  }

  const m = /^DeepSeek (\d{3}):\s*([\s\S]*)$/.exec(msg);
  if (!m) return msg;
  const status = m[1] ?? "";
  const body = m[2] ?? "";
  const inner = extractDeepSeekErrorMessage(body);

  if (status === "401") {
    return `Authentication failed (DeepSeek 401): ${inner}. Your API key is rejected. Fix with \`reasonix setup\` or \`export DEEPSEEK_API_KEY=sk-...\`. Get one at https://platform.deepseek.com/api_keys.`;
  }
  if (status === "402") {
    return `Out of balance (DeepSeek 402): ${inner}. Top up at https://platform.deepseek.com/top_up — the panel header shows your balance once it's non-zero.`;
  }
  if (status === "422") {
    return `Invalid parameter (DeepSeek 422): ${inner}`;
  }
  if (status === "400") {
    return `Bad request (DeepSeek 400): ${inner}`;
  }
  return msg;
}

function extractDeepSeekErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "(no message)";
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { error?: { message?: unknown }; message?: unknown };
      if (obj.error && typeof obj.error.message === "string") return obj.error.message;
      if (typeof obj.message === "string") return obj.message;
    }
  } catch {
    /* not JSON — fall through */
  }
  return trimmed;
}
