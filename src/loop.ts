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

/**
 * Threshold above which a single tool-call's `arguments` JSON gets
 * automatically shrunk as soon as the tool has responded. 800 tokens
 * (~3 KB) leaves small/typical edits byte-verbatim while catching
 * whole-file rewrites and sprawling SEARCH/REPLACE payloads that
 * otherwise re-pay their cost on every subsequent turn's prompt.
 */
const ARGS_COMPACT_THRESHOLD_TOKENS = 800;
/**
 * Cap applied to every tool RESULT in the log when a turn ends. Big
 * `read_file` / `search_content` outputs (typical: 3-15 KB) are what
 * each subsequent turn's prompt keeps paying for, even at 98% cache
 * hit; the cache-hit price × tokens × turns × flash-or-pro rate is
 * how $5 sessions turn into $50 over a long project.
 *
 * 3000 tokens is the knee of the curve: enough head+tail to keep a
 * file excerpt recognisable as a citation reference, small enough
 * that 10 reads ≈ 30K carry-cost instead of 100K+. The model can
 * always re-read the file if it needs fresh detail — one extra
 * `read_file` call is vastly cheaper than dragging raw content
 * through every future turn.
 */
const TURN_END_RESULT_CAP_TOKENS = 3000;

/**
 * How many visible failure signals in a single turn before the
 * remaining model calls auto-escalate to pro. Pitched conservatively:
 * 1-2 retries are normal even for pro (indentation drift, stale context),
 * 3+ means flash is genuinely stuck on this task and continuing at the
 * cheap tier wastes tokens + user time. Announced in the UI when it
 * fires — no silent upgrades.
 */
const FAILURE_ESCALATION_THRESHOLD = 3;
/**
 * Model used when the current turn auto-escalates (either from the
 * `/pro` slash arming or the failure threshold). Hard-coded rather
 * than plumbing a separate option because the semantics are exactly
 * "use DeepSeek's stronger tier for this turn" — any deployment
 * custom enough to need a different escalation model would already
 * be constructing loops directly and can override at that layer.
 */
const ESCALATION_MODEL = "deepseek-v4-pro";
/**
 * Self-report marker: when flash's first line of output is exactly
 * this string, the loop aborts the current call and retries the
 * turn on {@link ESCALATION_MODEL}. The model is instructed (via
 * system prompts) to emit this only when the task is clearly beyond
 * its ability — complex architecture refactors, subtle invariants,
 * design tradeoffs the model can't resolve confidently. Keeps most
 * users off the pro tier while giving flash a self-aware escape
 * hatch for tasks it would otherwise botch.
 */
/**
 * Two accepted forms:
 *   - `<<<NEEDS_PRO>>>`              — bare marker, no reason
 *   - `<<<NEEDS_PRO: <reason text>>>>` — model includes a one-sentence
 *     rationale that gets surfaced in the escalation warning. Reason
 *     can be empty (treated as bare); leading/trailing whitespace is
 *     trimmed.
 */
const NEEDS_PRO_MARKER_PREFIX = "<<<NEEDS_PRO";
const NEEDS_PRO_MARKER_RE = /^<<<NEEDS_PRO(?::\s*([^>]*))?>>>/;
/** Max chars of assistant content we buffer before flushing in the
 *  streaming path. Bumped from 80 → 256 to leave room for the
 *  optional reason text without prematurely flushing it. */
const NEEDS_PRO_BUFFER_CHARS = 256;
import { AppendOnlyLog, type ImmutablePrefix, VolatileScratch } from "./memory.js";
import { type RepairReport, ToolCallRepair } from "./repair/index.js";
import { appendSessionMessage, loadSessionMessages, rewriteSession } from "./session.js";
import {
  DEEPSEEK_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  SessionStats,
  type TurnStats,
} from "./telemetry.js";
import { countTokens, estimateRequestTokens } from "./tokenizer.js";
import { ToolRegistry } from "./tools.js";
import type { ChatMessage, ToolCall } from "./types.js";

export type EventRole =
  | "assistant_delta"
  | "assistant_final"
  /**
   * Emitted as `tool_calls[].function.arguments` streams in. A tool
   * call with a large arguments payload produces no `content` or
   * `reasoning_content` bytes — this is the only signal the UI has
   * that the stream is alive during that window.
   */
  | "tool_call_delta"
  /**
   * Yielded immediately before a tool is dispatched. Lets the TUI put
   * up a "▸ tool<X> running…" spinner while the tool's Promise is
   * pending — otherwise the UI looks frozen whenever a tool call
   * takes more than a few hundred ms (a big `filesystem_edit_file`
   * is a typical trigger).
   */
  | "tool_start"
  | "tool"
  | "done"
  | "error"
  | "warning"
  /**
   * Transient "what's happening right now" indicator. Emitted during
   * silent phases — between a tool result and the next iteration's
   * first streaming byte, and right before harvest — so the TUI can
   * show a spinner with explanatory text instead of looking frozen.
   * The UI clears it on the next primary event (assistant_delta,
   * tool_start, tool, assistant_final, error).
   */
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
  /**
   * Raw JSON-string arguments the model sent for a tool call (role === "tool").
   * Populated so transcripts can persist *why* a tool was called, not just
   * what it returned. Needed by `reasonix diff` to explain divergences.
   */
  toolArgs?: string;
  /** Cumulative arguments-string length for `role === "tool_call_delta"`. */
  toolCallArgsChars?: number;
  /**
   * Zero-based index of the tool call this delta belongs to. Surfaces
   * multi-tool turns: on a response emitting 4 write_file calls the UI
   * can show "building call 3/?" instead of a context-free spinner.
   */
  toolCallIndex?: number;
  /**
   * Count of prior tool calls (this turn) whose arguments have finished
   * streaming into valid JSON. Not all ready calls have been dispatched
   * yet — dispatch still happens post-stream — but the user gets "2
   * ready" progress feedback while later calls keep streaming.
   */
  toolCallReadyCount?: number;
  stats?: TurnStats;
  planState?: TypedPlanState;
  repair?: RepairReport;
  branch?: BranchSummary;
  branchProgress?: BranchProgress;
  error?: string;
  /**
   * True on `assistant_final` events emitted by the no-tools fallback
   * when the loop hit its budget, was aborted, or tripped the
   * token-context guard. Consumers that act on assistant text (notably
   * the code-mode edit applier) MUST treat these as display-only —
   * the model is "wrapping up," not proposing new work. Applying
   * SEARCH/REPLACE blocks found in a forced summary caused the
   * "analysis became edits" bug in v0.4.1 and earlier.
   */
  forcedSummary?: boolean;
}

export interface CacheFirstLoopOptions {
  client: DeepSeekClient;
  prefix: ImmutablePrefix;
  tools?: ToolRegistry;
  model?: string;
  maxToolIters?: number;
  stream?: boolean;
  /**
   * Pillar 2 — structured harvesting of R1 reasoning into a typed plan state.
   * Pass `true` for defaults or an options object. Off by default (adds a
   * cheap but non-zero V3 call per turn).
   */
  harvest?: boolean | HarvestOptions;
  /**
   * Self-consistency branching. Pass a number for just a budget (e.g. 3) or
   * a full `BranchOptions` object. Disables streaming for the branched turn
   * because all samples must complete before selection. Auto-enables harvest
   * since the default selector scores samples by plan-state uncertainty.
   */
  branch?: number | BranchOptions;
  /**
   * Reasoning-effort cap. See {@link ReconfigurableOptions} — default
   * `max` for Reasonix (agent-class use per DeepSeek V4 docs).
   */
  reasoningEffort?: "high" | "max";
  /**
   * Master switch for auto-escalation paths. See ReconfigurableOptions
   * — defaults to `true` (current behavior); the `flash` and `pro`
   * presets pass `false` to lock the running session to one model.
   */
  autoEscalate?: boolean;
  /**
   * Soft USD budget for the entire session. When set, the loop:
   *   - Emits a one-shot warning event when cumulative cost crosses 80%
   *   - Refuses to run the next turn once cumulative cost ≥ budget,
   *     yielding an error that explains how to bump or clear the cap
   *
   * Default `undefined` — no cap, no warnings. Reasonix is the cost-
   * focused agent; the budget is opt-in so users new to the tool
   * don't get blocked at $0.50 wondering what happened, but heavy /
   * headless / CI users have a clean circuit breaker available.
   */
  budgetUsd?: number;
  /**
   * Session name. When set, the loop pre-loads the session's prior messages
   * into its log on construction, and appends every new log entry to
   * `~/.reasonix/sessions/<name>.jsonl` so the next run can resume.
   */
  session?: string;
  /**
   * Resolved hook list — loaded from `<project>/.reasonix/settings.json`
   * + `~/.reasonix/settings.json` by the CLI before constructing the loop.
   * The loop dispatches `PreToolUse` and `PostToolUse` events itself; the
   * CLI handles `UserPromptSubmit` and `Stop` since they live at the App
   * boundary. Empty / unset → no hooks fire (the runtime cost of an empty
   * filter is one ms). See `src/hooks.ts` for the full contract.
   */
  hooks?: ResolvedHook[];
  /**
   * `cwd` reported to hooks via the stdin payload. Defaults to `process.cwd()`.
   * `reasonix code` overrides this to the sandbox root so a hook that does
   * `cd $REASONIX_CWD` lands in the project, not in the user's shell home.
   */
  hookCwd?: string;
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
export interface ReconfigurableOptions {
  model?: string;
  harvest?: boolean | HarvestOptions;
  branch?: number | BranchOptions;
  stream?: boolean;
  /**
   * Reasoning-effort cap sent per turn (V4 thinking mode only;
   * deepseek-chat ignores it). Reasonix pins `max` by default because
   * DeepSeek's V4 docs flag Claude-Code-style agent loops as the
   * canonical `max` use case. `/effort high` lets a user step down
   * mid-session for cheaper, faster turns on simple tasks.
   */
  reasoningEffort?: "high" | "max";
  /**
   * Master switch for the auto-escalation paths — both the
   * `<<<NEEDS_PRO>>>` marker scavenge and the failure-count threshold.
   * `true` (default) preserves the original "flash baseline, jump to
   * pro when struggling" behavior. `false` locks the active turn to
   * whatever `model` is set to — used by the `flash` and `pro` presets
   * which want a hard model commitment.
   */
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
  /** See ReconfigurableOptions — mutable so `/effort` can flip mid-session. */
  reasoningEffort: "high" | "max";
  /**
   * Auto-escalation toggle. `true` lets the loop self-promote to pro
   * mid-turn (NEEDS_PRO marker / failure threshold); `false` keeps it
   * pinned to `model`. Mutable so the dashboard's preset switcher can
   * flip it live alongside `model`.
   */
  autoEscalate = true;
  /**
   * Soft USD budget — see {@link CacheFirstLoopOptions.budgetUsd}.
   * Mutable so `/budget` slash can set / change / clear it mid-session.
   * `null` (the default) disables all budget checks.
   */
  budgetUsd: number | null;
  /**
   * Set the first time a turn crosses 80% of the budget so the warning
   * doesn't repeat every turn afterwards. Cleared by `setBudget` (any
   * change re-arms the warning, including raising the cap above the
   * current spend).
   */
  private _budgetWarned = false;
  sessionName: string | null;

  /**
   * Hook list, mutable so `/hooks reload` can swap it without
   * reconstructing the loop. Default empty — the filter cost on a
   * tool call is one array length check.
   */
  hooks: ResolvedHook[];
  /**
   * `cwd` reported to hook stdin. Mutable so `/cwd` can switch the
   * working directory mid-session — the App keeps it in sync with
   * the same currentRootDir that drives tool re-registration.
   */
  hookCwd: string;

  /** Number of messages that were pre-loaded from the session file. */
  readonly resumedMessageCount: number;

  private _turn = 0;
  private _streamPreference: boolean;
  /**
   * AbortController per active turn. Threaded through the DeepSeek
   * HTTP calls AND every tool dispatch so Esc actually cancels the
   * in-flight network/subprocess work — not "we'll get to it after
   * the current call finishes." Re-created at the start of each
   * `step()` (the prior turn's signal has already fired).
   */
  private _turnAbort: AbortController = new AbortController();

  /**
   * "Next turn should run on pro, regardless of this.model." Set by the
   * `/pro` slash command; consumed at the next turn's start (flipping
   * `_escalateThisTurn` on and self-clearing) so it's a fire-and-forget
   * single-turn upgrade. Survives across multiple slash inputs so
   * typing `/pro` and then hesitating a while before submitting a real
   * message still applies.
   */
  private _proArmedForNextTurn = false;
  /**
   * Active for the current turn only — true means every model call
   * this turn uses pro instead of `this.model`. Turned on by EITHER
   * the pro-armed consumption OR the mid-turn auto-escalation
   * threshold (see `_turnFailureCount`). Cleared at turn end.
   */
  private _escalateThisTurn = false;
  /**
   * Visible-failure count for the current turn. Incremented by tool
   * dispatch paths when a result matches a known "flash is struggling"
   * shape (SEARCH-not-found errors, scavenge / truncation / storm
   * repair fires). Once it hits {@link FAILURE_ESCALATION_THRESHOLD},
   * the remainder of the turn's model calls auto-upgrade to pro so
   * the user doesn't watch flash retry the same edit 5 times.
   */
  private _turnFailureCount = 0;
  /**
   * Per-type breakdown of failure signals counted toward the turn's
   * auto-escalation threshold. Surfaced in the warning when the
   * threshold trips so the user sees what kind of trouble flash
   * actually hit ("3× search-mismatch, 2× truncated") rather than
   * just a bare count. Reset alongside _turnFailureCount.
   */
  private _turnFailureTypes: Record<string, number> = {};

  constructor(opts: CacheFirstLoopOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix;
    this.tools = opts.tools ?? new ToolRegistry();
    // Library fallback aligns with the CLI's new default: flash, not
    // pro. Callers who want pro pass it explicitly — pro-by-default
    // was ~12× more expensive than most deployments needed.
    this.model = opts.model ?? "deepseek-v4-flash";
    this.reasoningEffort = opts.reasoningEffort ?? "max";
    if (opts.autoEscalate !== undefined) this.autoEscalate = opts.autoEscalate;
    this.budgetUsd =
      typeof opts.budgetUsd === "number" && opts.budgetUsd > 0 ? opts.budgetUsd : null;
    // Iter cap is a safety net, not the primary stop condition. The
    // primary stop is the token-context guard inside step(): after
    // every model response we check whether the prompt is already past
    // 80% of the model's context window, and if so divert to the
    // forced-summary path. 64 is high enough that exploration almost
    // never exhausts it before the token guard fires first — which
    // is the point: let the real constraint (context window) drive
    // the decision, keep the iter cap as a last-resort backstop for
    // the case where something spins without growing the prompt.
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
    // Mutation predicate sourced from the ToolRegistry: a tool is
    // mutating unless it declares `readOnly: true` (or has a per-call
    // `readOnlyCheck` that returns true on the actual args). The storm
    // breaker uses this to clear its window after edit/write/shell, so
    // legitimate read → edit → verify cycles aren't mistaken for storms.
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
    this.repair = new ToolCallRepair({ allowedToolNames: allowedNames, isMutating });

    // Session resume: pre-load prior messages into the log if a session name
    // is provided. New messages appended to the log are also persisted.
    //
    // Heal-on-load: if a previous run (or a pre-alpha.6 client) stored a
    // tool result bigger than the cap, the next API call would blow past
    // DeepSeek's 131k-token limit *before the user even types anything*.
    // Truncating here lets the user pick up their session history without
    // losing the conversational context around the oversized call.
    this.sessionName = opts.session ?? null;
    if (this.sessionName) {
      const prior = loadSessionMessages(this.sessionName);
      const shrunk = healLoadedMessagesByTokens(prior, DEFAULT_MAX_RESULT_TOKENS);
      // On thinking-mode sessions, stamp empty `reasoning_content` on any
      // assistant turn that's missing the field. Covers sessions written
      // by pre-fix builds (0.5.14 → 0.6.0) where the stamp was gated on
      // `reasoning.length > 0` — those files carry assistant turns with
      // the field absent, and the next API call 400s on resume even
      // though we're no longer producing such messages.
      const stamped = stampMissingReasoningForThinkingMode(shrunk.messages, this.model);
      const messages = stamped.messages;
      const healedCount = shrunk.healedCount + stamped.stampedCount;
      const tokensSaved = shrunk.tokensSaved;
      for (const msg of messages) this.log.append(msg);
      this.resumedMessageCount = messages.length;
      if (healedCount > 0) {
        // Persist the healed log back to disk so the damage doesn't
        // re-surface on the next session load — otherwise `heal →
        // append → resume → heal → …` would keep noticing the same
        // broken tail every restart. Non-fatal on I/O error: the
        // in-memory log is already healed so this session still works.
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

  /**
   * Shrink the log by re-truncating oversized tool results to a tighter
   * token cap, and persist the result back to disk so the next launch
   * doesn't re-inherit a fat session file. Returns a summary the TUI
   * can display.
   *
   * The cap is in DeepSeek V3 tokens (not chars) — so CJK text gets
   * capped at the same effective context footprint as English instead
   * of slipping past a char cap at 2× the token cost. Default 4000
   * tokens, matching the token-aware dispatch cap from 0.5.2.
   *
   * Only tool-role messages are touched (same rationale as
   * {@link healLoadedMessages}). User and assistant messages carry
   * authored intent we can't mechanically shrink without losing
   * meaning.
   */
  /**
   * Conservative args-only shrink fired after every tool response —
   * strictly about ONE thing: stop oversized `edit_file` / `write_file`
   * arguments from riding every future turn's prompt.
   *
   * Why this is worth doing AUTOMATICALLY (not just on /compact):
   * Each tool-call arguments string sticks in the log verbatim. On a
   * coding session with ~10 edits, that's 20-40K tokens of stale
   * SEARCH/REPLACE text riding along on every turn. Even at a 98.9%
   * cache hit rate the input cost still adds up linearly (cache-hit
   * price × tokens × turns). Compacting IMMEDIATELY after the tool
   * responds means the next turn's prompt is already smaller — the
   * shrink is a one-time write that saves every future prompt.
   *
   * Threshold rationale: 800 tokens ≈ 3 KB. A typical 20-line edit's
   * args land well under that; massive rewrites (whole-file content,
   * 100+ line refactors) land above and get the compaction. Small
   * edits stay byte-verbatim so nothing common-case changes.
   *
   * Safety: we ONLY shrink args whose tool has ALREADY responded.
   * Structurally that's every call in `log.toMessages()` at this
   * point — the current turn's assistant/tool pairing is by
   * construction closed by the time we get here (append happens
   * AFTER dispatch). The in-flight assistant message being built
   * lives in scratch, not the log, so this pass can't touch it.
   *
   * Model impact: the model may occasionally want to reference the
   * exact SEARCH text of a prior edit — it then reads the file
   * directly (which shows current state) or looks at the preceding
   * assistant text (which has its plan). Losing the stale args is a
   * net win: one extra read_file vs. dragging N KB of stale text
   * through every subsequent turn.
   */
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

  /**
   * Fired at the END of a turn (just before `done` is yielded). Shrinks
   * every tool RESULT in the log that exceeds {@link TURN_END_RESULT_CAP_TOKENS}
   * to a tight cap so the NEXT turn's prompt doesn't re-pay for big
   * reads or searches done earlier. Unlike the reactive 40/80%
   * thresholds which react to context pressure, this runs unconditionally
   * — the win is preventive: each turn's big outputs get trimmed before
   * they ride into the next prompt. Saves compounding cost on long
   * sessions.
   *
   * Why compact the JUST-finished turn's results too (not just older
   * turns)? The same-turn iters already consumed the raw content to
   * make their decisions — the log is only carried forward for future
   * prompts. And "let me re-read the file" is vastly cheaper than
   * "carry this 12KB result in every future turn's prompt forever."
   *
   * Safe by construction: args-compact for THIS turn already ran
   * inside `compactToolCallArgsAfterResponse`; this pass is orthogonal.
   */
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
    // Two-pass shrink: first the tool RESULTS (the classic compact
    // concern — big read_file output, search_content hits), then the
    // tool-call ARGS (edit_file / write_file search/replace payloads,
    // which on a coding session can out-weigh results 2-3x).
    //
    // Order matters: we want the args-shrink to see any messages whose
    // results were just trimmed, so tokensSaved is independently
    // accumulated from both passes and charsSaved is summed the same
    // way.
    //
    // Using shrink* (not healLoadedMessages) — the full heal would
    // strip a dangling `assistant.tool_calls` tail, which during an
    // active turn is legitimate state. Structural healing is only
    // appropriate at session LOAD; mid-session compact is about
    // payload shrinkage, not pairing.
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

  /**
   * Start a fresh conversation WITHOUT exiting. Drops every message
   * in the in-memory log AND rewrites the session file to empty so
   * a resume won't re-hydrate the old turns. Unlike `/forget`, which
   * deletes the session entirely, this keeps the session name and
   * config intact — it's the "new chat" button.
   *
   * The immutable prefix (system prompt + tool specs) is preserved
   * — that's the cache-first invariant, not part of the conversation.
   * Returns the number of messages dropped so the UI can show it.
   */
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

  /**
   * Reconfigure model/harvest/branch/stream mid-session. The loop's log,
   * scratch, and stats are preserved — only the per-turn behavior changes.
   * Used by the TUI's slash commands and by library callers who want to
   * flip a knob between turns.
   */
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

  /**
   * Set / change / clear the soft USD budget. `null` (or any non-
   * positive number) disables the cap entirely. Re-arms the 80%
   * warning so a user who bumps the cap mid-session sees a fresh
   * threshold message at the new boundary.
   */
  setBudget(usd: number | null): void {
    this.budgetUsd = typeof usd === "number" && usd > 0 ? usd : null;
    this._budgetWarned = false;
  }

  /**
   * Arm pro for the next turn (consumed at turn start). Called by
   * `/pro`. Idempotent — repeated calls stay armed, `disarmPro()`
   * clears. Separate from `/preset max` which persistently switches
   * this.model; armed state is strictly single-turn.
   */
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

  /**
   * Model the current model call should use. Defaults to `this.model`;
   * upgrades to {@link ESCALATION_MODEL} when the turn is armed for
   * pro (via `/pro`) or has hit the failure-escalation threshold.
   * Same thinking + effort policy applies regardless — pro defaults
   * to thinking=enabled and effort=max, which the current turn wanted
   * anyway when flash was struggling.
   */
  private modelForCurrentCall(): string {
    return this._escalateThisTurn ? ESCALATION_MODEL : this.model;
  }

  /**
   * Parse the escalation marker out of the model's leading content.
   * Returns `{ matched: true, reason? }` for both bare and reason-
   * carrying forms. Only the FIRST line matters — the model is
   * instructed to emit the marker as the first output token if at
   * all. Matches anywhere else in the text are normal content
   * references (e.g. the user asked about the marker itself).
   */
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

  /**
   * Could `buf` STILL plausibly become the full marker as more chunks
   * arrive? Drives the streaming buffer's flush decision: while this
   * is true we keep accumulating; once it's false (or the buffer
   * exceeds the byte limit) we flush so the user isn't staring at a
   * delayed display for arbitrary content that just happens to start
   * with `<`.
   */
  private looksLikePartialEscalationMarker(buf: string): boolean {
    const t = buf.trimStart();
    if (t.length === 0) return true;
    if (t.length <= NEEDS_PRO_MARKER_PREFIX.length) {
      return NEEDS_PRO_MARKER_PREFIX.startsWith(t);
    }
    if (!t.startsWith(NEEDS_PRO_MARKER_PREFIX)) return false;
    const rest = t.slice(NEEDS_PRO_MARKER_PREFIX.length);
    // After `<<<NEEDS_PRO`, valid next chars are `>` (closing the
    // marker) or `:` (start of the reason). Anything else means this
    // was real content that happened to share a prefix.
    if (rest[0] !== ">" && rest[0] !== ":") return false;
    return true;
  }

  /**
   * Check whether a tool result string looks like a "flash struggled"
   * signal and, if so, increment the turn's failure counter. Escalates
   * the REST of the current turn to pro once the threshold is hit.
   * Idempotent after escalation — further failures don't re-escalate,
   * but the turn is already on pro so it doesn't matter.
   *
   * Return: `true` when this call tipped the turn into escalation
   * mode (so the loop can surface a one-time warning to the user).
   */
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
    // ToolCallRepair fires mean the MODEL's output was malformed
    // (truncation, hallucinated tool markup, repeated same call).
    // Each flavor counts as one failure signal AND gets its own tag
    // in the breakdown so the warning can say "3× truncated" instead
    // of an opaque "3 repair signals".
    if (repair) {
      if (repair.scavenged > 0) bump("scavenged", repair.scavenged);
      if (repair.truncationsFixed > 0) bump("truncated", repair.truncationsFixed);
      if (repair.stormsBroken > 0) bump("storm-broken", repair.stormsBroken);
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

  /**
   * Render `_turnFailureTypes` as a comma-separated breakdown like
   * "2× search-mismatch, 1× truncated" for the auto-escalation
   * warning. Empty if no types have been recorded yet (defensive —
   * the warning sites only call this after a bump).
   */
  private formatFailureBreakdown(): string {
    const parts = Object.entries(this._turnFailureTypes)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => `${n}× ${kind}`);
    return parts.length > 0 ? parts.join(", ") : `${this._turnFailureCount} repair/error signal(s)`;
  }

  private buildMessages(pendingUser: string | null): ChatMessage[] {
    // Full tool_calls ↔ tool pairing validation. DeepSeek 400s on
    // both sides of this contract — unpaired assistant.tool_calls
    // ("insufficient tool messages following") OR stray tool entries
    // ("tool must be a response to a preceding tool_calls"). A corrupted
    // session from an earlier build can have either. Rather than
    // applying a bunch of narrow tail-trim heuristics, rebuild the
    // message stream through the same validator used at load time so
    // the payload we hand to the API is well-formed by construction.
    const healed = healLoadedMessages(this.log.toMessages(), DEFAULT_MAX_RESULT_CHARS);
    const msgs: ChatMessage[] = [...this.prefix.toMessages(), ...healed.messages];
    if (pendingUser !== null) msgs.push({ role: "user", content: pendingUser });
    return msgs;
  }

  /**
   * Signal the currently-running {@link step} to stop **now**. Cancels
   * the in-flight network request (DeepSeek HTTP/SSE) AND any tool call
   * currently dispatching (MCP `notifications/cancelled` + promise
   * reject). The loop itself also sees `signal.aborted` at each
   * iteration boundary and exits quickly instead of looping again.
   * Called by the TUI on Esc.
   */
  abort(): void {
    this._turnAbort.abort();
  }

  /**
   * Drop everything in the log after (and including) the most recent
   * user message. Used by `/retry` so the caller can re-send that
   * message with a fresh turn instead of layering another response on
   * top of the prior exchange. Returns the content of the dropped user
   * message, or `null` if there isn't one yet.
   *
   * Persists by rewriting the session file — otherwise the next
   * launch would rehydrate the old exchange and `/retry` would seem
   * to have done nothing.
   */
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
    // Keep everything strictly before the user message. The caller
    // will submit the text again through the normal path, which
    // re-appends the user turn on first successful API response.
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

      // Loud signal when the storm breaker caught a repeat pattern.
      // The `repair` field on assistant_final already carries the
      // count as a subtext on the assistant row, but a dedicated
      // warning row is far more noticeable — and critical when ALL
      // calls were suppressed, because the turn then ends with no
      // visible explanation of why nothing happened.
      if (report.stormsBroken > 0) {
        const noteTail = report.notes.length ? ` — ${report.notes[report.notes.length - 1]}` : "";
        const allSuppressed = repairedCalls.length === 0 && toolCalls.length > 0;
        const phrase = allSuppressed
          ? `stopped the model from calling the same tool with identical args repeatedly (all ${toolCalls.length} call(s) this turn were already in the recent-repeat window). Likely a stuck retry — reword your instruction, rule out the underlying blocker, or try /retry after fixing it`
          : `suppressed ${report.stormsBroken} repeat tool call(s) that had fired 3+ times with identical args in a sliding window`;
        yield {
          turn: this._turn,
          role: "warning",
          content: `${phrase}${noteTail}`,
        };
      }

      if (repairedCalls.length === 0) {
        // Two sub-cases here:
        //   (a) Model legitimately produced ZERO tool calls — final
        //       prose answer, terminate the loop.
        //   (b) Model emitted tool calls but storm-breaker ate them
        //       all (allSuppressed). The user sees only the warning
        //       row and a silent stop, which feels like the agent
        //       gave up. Route through the forced-summary path so
        //       the model gets one no-tools call to explain what it
        //       tried, what blocked it, and what would unblock —
        //       turning a silent dead-end into actionable feedback.
        const allSuppressed = report.stormsBroken > 0 && toolCalls.length > 0;
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
      // Proactive tier: between 40% and 80%, pre-shrink oversized tool
      // results to a moderate cap (4k tokens) so the next iter doesn't
      // slam straight into the 80% reactive path — which shrinks far
      // more aggressively (1k tokens) and risks losing useful tail
      // info. Lowered from 60% to 40% (v0.6) because cost compounds:
      // carrying a 10K-token read_file through even 3-4 more turns
      // costs more than the one-shot compact. The turn-end auto-compact
      // already caps results at 3K, so this threshold mostly catches
      // multi-iter turns where one tool returned a huge payload mid-turn.
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

      // When `change_workspace` fires its WorkspaceConfirmationError,
      // any subsequent calls in the same parallel batch would dispatch
      // against the OLD sandbox before the user has approved the switch
      // — a silent data-loss footgun (file lands in the old project).
      // Once we observe one of these in this batch, every remaining
      // call gets a synthetic "skipped" result instead of running.
      // Tool-call ↔ tool pairing stays intact so DeepSeek doesn't 400
      // on the next turn; the model sees the deferral and the user
      // gets the modal first.
      let workspaceSwitchPending = false;
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
        if (workspaceSwitchPending) {
          // Tool fired in the same parallel batch as a change_workspace
          // that's awaiting user confirmation. Don't dispatch — the
          // sandbox root may flip under us. Surface a clear deferral
          // so the model retries on the next turn (where rootDir is
          // either the new path or unchanged after a deny).
          result = JSON.stringify({
            error: `${name}: deferred because change_workspace in the same batch is awaiting the user's approval. Re-issue this call on your next turn — the sandbox root may have changed.`,
          });
        } else if (preReport.blocked) {
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
          // Detect a workspace-switch confirmation marker in this dispatch
          // result; flip the gate so the rest of the batch defers.
          if (name === "change_workspace" && result.includes('"WorkspaceConfirmationError:')) {
            workspaceSwitchPending = true;
          }

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

  /**
   * Build an assistant message for the log. The `producingModel` arg is
   * the model that actually generated this turn (flash, pro, the
   * forced-summary flash call, `this.model` for synthetics, etc.) —
   * NOT `this.model`, because escalation + forced-summary can both
   * route a single turn to a different model.
   *
   * The single invariant this encodes: if the producing model is
   * thinking-mode, `reasoning_content` MUST be present on the
   * persisted message — even as an empty string. DeepSeek's validator
   * 400s the NEXT request if any historical thinking-mode assistant
   * turn is missing it. We used to gate on `reasoning.length > 0`,
   * which silently dropped the field whenever the stream emitted zero
   * reasoning deltas or the API returned `reasoning_content: null` —
   * both legitimate edge cases the 0.5.15/0.5.18 fixes missed.
   */
  private assistantMessage(
    content: string,
    toolCalls: ToolCall[],
    producingModel: string,
    reasoningContent?: string | null,
  ): ChatMessage {
    const msg: ChatMessage = { role: "assistant", content };
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    if (isThinkingModeModel(producingModel)) {
      msg.reasoning_content = reasoningContent ?? "";
    }
    return msg;
  }

  /**
   * Synthetic assistant message (abort notices, future system injections)
   * — no real API round trip. Delegates to {@link assistantMessage} with
   * `this.model` as the stand-in producer, so the same thinking-mode
   * invariant applies: reasoner sessions get an empty-string
   * `reasoning_content`; V3 sessions get nothing.
   */
  private syntheticAssistantMessage(content: string): ChatMessage {
    return this.assistantMessage(content, [], this.model, "");
  }
}

/**
 * True when the model emits `reasoning_content` and therefore requires
 * it round-tripped on follow-up requests.
 *   - `deepseek-reasoner`: legacy R1 alias (= v4-flash thinking mode)
 *   - `deepseek-v4-flash` / `deepseek-v4-pro`: default to thinking mode
 *     per the V4 docs (2026-04)
 *   - `deepseek-chat`: non-thinking compat alias → false
 *
 * Exported so tests can lock the behavior down as DeepSeek adds more
 * model variants.
 */
export function isThinkingModeModel(model: string): boolean {
  if (model.includes("reasoner")) return true;
  if (model === "deepseek-v4-flash" || model === "deepseek-v4-pro") return true;
  return false;
}

/**
 * What `extra_body.thinking.type` value to send for a given model. Pins
 * the mode explicitly rather than relying on the server default, which
 * removes one source of ambiguity when DeepSeek validates the request's
 * `reasoning_content` round-trip.
 *
 *   - `deepseek-chat`                   → "disabled" (non-thinking alias)
 *   - `deepseek-reasoner`               → "enabled"  (thinking alias)
 *   - `deepseek-v4-flash` / `-v4-pro`   → "enabled"  (V4 docs default)
 *   - anything else                     → undefined (let server decide)
 *
 * Returning `undefined` makes the client skip the field entirely so
 * third-party models routed through a DeepSeek-compatible endpoint
 * don't get a parameter they don't recognize.
 */
export function thinkingModeForModel(model: string): "enabled" | "disabled" | undefined {
  if (model === "deepseek-chat") return "disabled";
  if (model.includes("reasoner")) return "enabled";
  if (model === "deepseek-v4-flash" || model === "deepseek-v4-pro") return "enabled";
  return undefined;
}

/**
 * R1 occasionally hallucinates tool-call markup as plain text when the
 * real tool channel has been closed — typically our forced-summary
 * path, where `tools: undefined` is supposed to force prose but isn't
 * always respected. The markup isn't parsed by our tool-call path
 * (the API response's structured `tool_calls` field is empty), so
 * it's just noise in the user's view. Strip known envelope shapes.
 *
 * Exported so tests can exercise it against concrete R1 outputs.
 */
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

/**
 * Try to JSON-decode the model's tool-call arguments so PreToolUse /
 * PostToolUse hooks get a structured object instead of a string.
 * Falls back to the raw string when the model emits malformed JSON
 * (the loop's own dispatch already tolerates that — keep parity).
 */
function safeParseToolArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Cheap "is this accumulated tool-call arguments blob now a complete
 * JSON value?" check. Used during streaming to mark a tool call as
 * ready for UI progress feedback — not for dispatch gating. Empty /
 * whitespace-only is not complete; anything that parses is.
 *
 * Exported so tests can lock down the precise shapes we consider
 * "ready" vs "still streaming."
 */
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

/**
 * Truncate any tool-role message whose content exceeds the cap. User
 * and assistant messages are left alone because (a) they're almost
 * always small, (b) truncating user prompts would corrupt conversational
 * intent in a way the user didn't author. Exported for tests.
 */
/**
 * Shrink oversized tool results only — the original compact concern.
 * Separated from `healLoadedMessages` so `/compact` (live, mid-session)
 * doesn't accidentally strip structural tail that belongs in the
 * current turn's state.
 */
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

/**
 * Token-aware variant of `shrinkOversizedToolResults`. Used by live
 * `/compact` and auto-compact so the shrink cap bounds the REAL
 * context footprint (CJK at 1 char/token would otherwise survive a
 * char cap at 2× the intended token cost). Session-load heal still
 * uses the char version for backward-compat on stored session files.
 *
 * Per-message token accounting: we tokenize each shrink candidate
 * twice (before + after) so `tokensSaved` is exact. At typical log
 * sizes (≤20 tool results) this is bounded; at pathological sizes
 * the `truncateForModelByTokens` call internally never tokenizes the
 * full input, so worst-case stays bounded too.
 */
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
    // Fast path: length ≤ maxTokens ⇒ tokens ≤ maxTokens (every token
    // is ≥1 char). Skip the per-message tokenize for small results.
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

/**
 * Shrink fat `assistant.tool_calls[*].function.arguments` payloads.
 *
 * Why: tools like `edit_file` / `write_file` ship the full SEARCH /
 * REPLACE text in the arguments JSON. After the edit is applied the
 * tool result already tells the model what happened — the giant
 * arguments string just sits in the log burning prompt tokens every
 * future turn. On a long coding session, args can eat 2-3x as many
 * tokens as the tool results they spawned (observed: 45K vs 27K in a
 * single session). That's the biggest stale-context leak we have.
 *
 * Strategy: for each oversized call, parse the JSON, replace long
 * string fields with `"[…shrunk: N chars, M lines, tool already
 * responded — see tool result]"`. Keeps valid JSON + the key structure
 * (so the model still sees which path was edited), drops the body.
 *
 * Only mutates assistant messages whose tool_calls are already paired
 * with tool responses (i.e. historical, not in-flight) — the caller
 * is responsible for that gate; `fixToolCallPairing` handles structural
 * safety at session load, and the in-flight tail isn't in the log yet
 * (lives in the loop's scratch buffer until the turn commits).
 */
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
      // Guard: only swap if we actually saved anything. shrinkJsonLongStrings
      // might produce output that is only marginally shorter when a call's
      // payload is dominated by many short strings.
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

/**
 * Replace long string VALUES inside a tool-call arguments JSON with a
 * compact marker. Keeps top-level keys + short values intact so the
 * model can still read "path":"src/foo.ts" and the like. Falls back to
 * whole-string truncation when the input doesn't parse or isn't an
 * object.
 *
 * Threshold: 300 chars — below that it's probably a path / short
 * identifier we want to keep verbatim. Above, it's body text (SEARCH
 * / REPLACE / content) that the tool result already reflects.
 */
function shrinkJsonLongStrings(jsonStr: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Unparseable — truncate the whole string to something small with
    // a marker. 200 chars keeps the call recognizable in the log without
    // hauling the full payload forward.
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

/**
 * Enforce tool_calls ↔ tool pairing across a message log. DeepSeek
 * rejects two shapes at the API boundary:
 *   (a) assistant with tool_calls not followed by matching tool
 *       responses ("insufficient tool messages following tool_calls")
 *   (b) tool message without a preceding assistant.tool_calls with
 *       the matching tool_call_id ("must be a response to a preceding
 *       message with 'tool_calls'")
 *
 * Corrupted session files from earlier builds have hit both. This pass
 * rebuilds the message stream so only well-formed (assistant.tool_calls
 * + all matching responses) groups survive. Plain user/assistant/system
 * messages (no tool_calls) always pass through.
 *
 * Exported so both char-based and token-based heal can compose it.
 */
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

/**
 * Back-fill empty `reasoning_content` on assistant messages that lack it
 * when the current session model is thinking-mode. Covers session files
 * written by older builds (0.5.14 → 0.6.0) whose bug was exactly the
 * thing we're fixing now: reasoning was gated on `length > 0`, so turns
 * that returned empty reasoning were persisted without the field, and
 * the NEXT API call 400s with the "thinking mode must be passed back"
 * error the moment the user resumes.
 *
 * Non-thinking-mode sessions are left untouched — deepseek-chat round
 * trips don't include the field at all, and stamping empty strings
 * would just churn the prefix cache.
 *
 * Exported for tests.
 */
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

/**
 * Token-aware counterpart of {@link healLoadedMessages}. Used at
 * session-load time so resumed sessions come back capped at the same
 * token budget (not char budget) as live tool results — CJK text no
 * longer slips past at 2× the intended token cost when re-hydrated.
 *
 * Still does the same structural pass for tool_calls ↔ tool pairing;
 * that logic is orthogonal to the truncation cap.
 */
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

/**
 * Turn raw `DeepSeek NNN: {json}` errors into short actionable hints.
 * Client code throws these verbatim from the HTTP layer (see client.ts);
 * this is the one place the UI text layer reads to decide what the user
 * actually needs to do about it.
 *
 * Covered codes (per DeepSeek's error-code doc):
 *   - 400 + "maximum context length" → context-overflow, point at /forget
 *   - 400 generic → strip the JSON, show inner message
 *   - 401 → API key rejected, point at `reasonix setup`
 *   - 402 → balance depleted, link to top-up page
 *   - 422 → param error, show inner message (usually explains which field)
 *
 * 429/500/502/503/504 are swallowed by retry.ts before they reach here;
 * if they DO reach here (all retries exhausted), the raw string already
 * says "DeepSeek 503: server busy" etc. which is informative enough.
 */
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

/**
 * Pull the human-readable message out of a DeepSeek error response body
 * (`{"error":{"message":"..."}}`). Falls back to the raw body when
 * parsing fails — anything is better than eating the clue entirely.
 */
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
