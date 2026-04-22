import { type DeepSeekClient, Usage } from "./client.js";
import {
  type BranchOptions,
  type BranchSample,
  aggregateBranchUsage,
  runBranches,
} from "./consistency.js";
import { type HarvestOptions, type TypedPlanState, emptyPlanState, harvest } from "./harvest.js";
import { DEFAULT_MAX_RESULT_CHARS, truncateForModel } from "./mcp/registry.js";
import { AppendOnlyLog, type ImmutablePrefix, VolatileScratch } from "./memory.js";
import { type RepairReport, ToolCallRepair } from "./repair/index.js";
import { appendSessionMessage, loadSessionMessages, rewriteSession } from "./session.js";
import {
  DEEPSEEK_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  SessionStats,
  type TurnStats,
} from "./telemetry.js";
import { ToolRegistry } from "./tools.js";
import type { ChatMessage, ToolCall } from "./types.js";

export type EventRole =
  | "assistant_delta"
  | "assistant_final"
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
   * Session name. When set, the loop pre-loads the session's prior messages
   * into its log on construction, and appends every new log entry to
   * `~/.reasonix/sessions/<name>.jsonl` so the next run can resume.
   */
  session?: string;
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
  sessionName: string | null;

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

  constructor(opts: CacheFirstLoopOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix;
    this.tools = opts.tools ?? new ToolRegistry();
    this.model = opts.model ?? "deepseek-chat";
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
    this.repair = new ToolCallRepair({ allowedToolNames: allowedNames });

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
      const { messages, healedCount, healedFrom } = healLoadedMessages(
        prior,
        DEFAULT_MAX_RESULT_CHARS,
      );
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
          `▸ session "${this.sessionName}": healed ${healedCount} entr${healedCount === 1 ? "y" : "ies"}${healedFrom > 0 ? ` (was ${healedFrom.toLocaleString()} chars oversized)` : " (dropped dangling tool_calls tail)"}. Rewrote session file.\n`,
        );
      }
    } else {
      this.resumedMessageCount = 0;
    }
  }

  /**
   * Shrink the log by re-truncating oversized tool results to a tighter
   * cap, and persist the result back to disk so the next launch doesn't
   * re-inherit a fat session file. Returns a summary the TUI can
   * display.
   *
   * Only tool-role messages are touched (same rationale as
   * {@link healLoadedMessages}). User and assistant messages carry
   * authored intent we can't mechanically shrink without losing
   * meaning.
   */
  compact(tightCapChars = 4000): { healedCount: number; charsSaved: number } {
    const before = this.log.toMessages();
    // Use `shrinkOversizedToolResults` (not `healLoadedMessages`) — the
    // full heal would also strip a dangling `assistant.tool_calls` tail,
    // which during an active turn is legitimate state we still need
    // (tools haven't been dispatched yet). Structural healing is only
    // appropriate at session LOAD; mid-session `/compact` is strictly
    // about shrinking oversized tool payloads.
    const { messages, healedCount, healedFrom } = shrinkOversizedToolResults(before, tightCapChars);
    const afterBytes = messages
      .filter((m) => m.role === "tool")
      .reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : 0), 0);
    const charsSaved = healedFrom - afterBytes;
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
    return { healedCount, charsSaved };
  }

  private appendAndPersist(message: ChatMessage): void {
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
    this._turn++;
    this.scratch.reset();
    // Fresh controller for this turn: the prior step's signal has
    // already fired (or stayed clean); either way we don't want its
    // state to bleed into the new turn.
    this._turnAbort = new AbortController();
    const signal = this._turnAbort.signal;
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
        this.appendAndPersist({ role: "assistant", content: stoppedMsg });
        yield {
          turn: this._turn,
          role: "assistant_final",
          content: stoppedMsg,
          forcedSummary: true,
        };
        yield { turn: this._turn, role: "done", content: stoppedMsg };
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
      const messages = this.buildMessages(pendingUser);

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

          const branchPromise = runBranches(
            this.client,
            {
              model: this.model,
              messages,
              tools: toolSpecs.length ? toolSpecs : undefined,
              signal,
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
          for await (const chunk of this.client.stream({
            model: this.model,
            messages,
            tools: toolSpecs.length ? toolSpecs : undefined,
            signal,
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
            signal,
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
          error: formatLoopError(err as Error),
        };
        return;
      }

      const turnStats = this.stats.record(this._turn, this.model, usage ?? new Usage());

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

      this.appendAndPersist(this.assistantMessage(assistantContent, repairedCalls));

      yield {
        turn: this._turn,
        role: "assistant_final",
        content: assistantContent,
        stats: turnStats,
        planState,
        repair: report,
        branch: branchSummary,
      };

      if (repairedCalls.length === 0) {
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
      if (usage && usage.promptTokens / ctxMax > 0.8) {
        const before = usage.promptTokens;
        const compactResult = this.compact(4000);
        if (compactResult.healedCount > 0) {
          // Rough estimate: 4 chars per token. Good enough to decide
          // whether compaction pushed us back under the threshold; the
          // exact number comes back from the NEXT API response's usage.
          const approxSaved = Math.round(compactResult.charsSaved / 4);
          const after = before - approxSaved;
          yield {
            turn: this._turn,
            role: "warning",
            content: `context ${before.toLocaleString()}/${ctxMax.toLocaleString()} — auto-compacted ${compactResult.healedCount} oversized tool result(s), saved ~${approxSaved.toLocaleString()} tokens (now ~${after.toLocaleString()}). Continuing.`,
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
        const result = await this.tools.dispatch(name, args, { signal });
        this.appendAndPersist({
          role: "tool",
          tool_call_id: call.id ?? "",
          name,
          content: result,
        });
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
    opts: { reason: "budget" | "aborted" | "context-guard" } = { reason: "budget" },
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
      const resp = await this.client.chat({
        model: this.model,
        messages,
        // no tools → model is forced to answer in text
        signal: this._turnAbort.signal,
      });
      const rawContent = resp.content?.trim() ?? "";
      const cleaned = stripHallucinatedToolMarkup(rawContent);
      const summary =
        cleaned ||
        "(model emitted fake tool-call markup instead of a prose summary — try /retry with a narrower question, or /think to inspect R1's reasoning)";
      const reasonPrefix = reasonPrefixFor(opts.reason, this.maxToolIters);
      const annotated = `${reasonPrefix}\n\n${summary}`;
      const summaryStats = this.stats.record(this._turn, this.model, resp.usage ?? new Usage());
      this.appendAndPersist({ role: "assistant", content: summary });
      yield {
        turn: this._turn,
        role: "assistant_final",
        content: annotated,
        stats: summaryStats,
        forcedSummary: true,
      };
      yield { turn: this._turn, role: "done", content: summary };
    } catch (err) {
      const label = errorLabelFor(opts.reason, this.maxToolIters);
      yield {
        turn: this._turn,
        role: "error",
        content: "",
        error: `${label} and the fallback summary call failed: ${(err as Error).message}. Run /clear and retry with a narrower question, or raise --max-tool-iters.`,
      };
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

  private assistantMessage(content: string, toolCalls: ToolCall[]): ChatMessage {
    const msg: ChatMessage = { role: "assistant", content };
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    return msg;
  }
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

function reasonPrefixFor(reason: "budget" | "aborted" | "context-guard", iterCap: number): string {
  if (reason === "aborted") return "[aborted by user (Esc) — summarizing what I found so far]";
  if (reason === "context-guard") {
    return "[context budget running low — summarizing before the next call would overflow]";
  }
  return `[tool-call budget (${iterCap}) reached — forcing summary from what I found]`;
}

function errorLabelFor(reason: "budget" | "aborted" | "context-guard", iterCap: number): string {
  if (reason === "aborted") return "aborted by user";
  if (reason === "context-guard") return "context-guard triggered (prompt > 80% of window)";
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

export function healLoadedMessages(
  messages: ChatMessage[],
  maxChars: number,
): { messages: ChatMessage[]; healedCount: number; healedFrom: number } {
  // Pass 1: shrink oversized tool results (original heal purpose).
  const shrunk = shrinkOversizedToolResults(messages, maxChars);
  let healedCount = shrunk.healedCount;
  // Pass 2: enforce tool_calls ↔ tool pairing across the full log.
  //
  // DeepSeek rejects two shapes at the API boundary:
  //   (a) assistant with tool_calls not followed by matching tool
  //       responses ("insufficient tool messages following tool_calls")
  //   (b) tool message without a preceding assistant.tool_calls with
  //       the matching tool_call_id ("must be a response to a preceding
  //       message with 'tool_calls'")
  //
  // Corrupted session files from earlier builds have hit both. Rebuild
  // the message stream so only well-formed (assistant.tool_calls + all
  // matching responses) groups survive. Plain user/assistant messages
  // (no tool_calls) always pass through.
  const out: ChatMessage[] = [];
  const openCallIds = new Set<string>();
  let droppedAssistantCalls = 0;
  let droppedStrayTools = 0;
  for (let i = 0; i < shrunk.messages.length; i++) {
    const msg = shrunk.messages[i]!;
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // Look ahead for tool responses matching every id in this
      // assistant's tool_calls. If all present (in any order, but
      // contiguous after this message), include the whole group.
      const needed = new Set<string>();
      for (const call of msg.tool_calls) {
        if (call?.id) needed.add(call.id);
      }
      const candidates: ChatMessage[] = [];
      let j = i + 1;
      while (j < shrunk.messages.length && needed.size > 0) {
        const nxt = shrunk.messages[j]!;
        if (nxt.role !== "tool") break;
        const id = nxt.tool_call_id ?? "";
        if (!needed.has(id)) break;
        needed.delete(id);
        candidates.push(nxt);
        j++;
      }
      if (needed.size === 0) {
        // Every call has a response — emit the whole group.
        out.push(msg);
        for (const r of candidates) out.push(r);
        i = j - 1; // for-loop ++ will advance past the last response
      } else {
        // Drop the assistant entry and anything that was speculatively
        // its responses — they'd become stray tool messages.
        droppedAssistantCalls += 1;
        droppedStrayTools += candidates.length;
        i = j - 1;
      }
      continue;
    }
    if (msg.role === "tool") {
      // Any tool message that reaches here did NOT get consumed by
      // the assistant-with-tool_calls branch above, so it's stray.
      // Drop it — surfacing it would 400 the next API call.
      droppedStrayTools += 1;
      continue;
    }
    // Plain user/assistant/system message — pass through.
    out.push(msg);
  }
  healedCount += droppedAssistantCalls + droppedStrayTools;
  return { messages: out, healedCount, healedFrom: shrunk.healedFrom };
}

/**
 * Annotate the `DeepSeek 400: … maximum context length …` error the API
 * returns when a session's history has grown past 131,072 tokens. The
 * raw message is a JSON blob; we surface a short actionable hint on top
 * so the user knows to `/forget` or `/clear` rather than parsing the
 * JSON themselves. Other errors pass through unchanged — the loop's
 * error channel already formats them well enough.
 */
export function formatLoopError(err: Error): string {
  const msg = err.message ?? "";
  if (msg.includes("maximum context length")) {
    // Pull the "requested X tokens" figure out of the JSON for scale.
    const reqMatch = msg.match(/requested\s+(\d+)\s+tokens/);
    const requested = reqMatch
      ? `${Number(reqMatch[1]).toLocaleString()} tokens`
      : "too many tokens";
    return `Context overflow (DeepSeek 400): session history is ${requested}, past the 131,072-token limit. Usually this means a single tool call returned a huge payload. v0.3.0-alpha.6+ caps new tool results at 32k chars, AND auto-heals oversized history on session load — restart Reasonix and this session should come back trimmed. If it still overflows, run /forget (delete the session) or /clear (drop the displayed history) to start fresh.`;
  }
  return msg;
}
