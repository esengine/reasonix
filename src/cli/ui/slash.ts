import { spawnSync } from "node:child_process";
import {
  HOOK_EVENTS,
  type HookEvent,
  type ResolvedHook,
  globalSettingsPath,
  projectSettingsPath,
} from "../../hooks.js";
import type { CacheFirstLoop } from "../../loop.js";
import type { InspectionReport } from "../../mcp/inspect.js";
import { PROJECT_MEMORY_FILE, memoryEnabled, readProjectMemory } from "../../project-memory.js";
import { deleteSession, listSessions } from "../../session.js";
import { SkillStore } from "../../skills.js";
import { DEEPSEEK_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS } from "../../telemetry.js";
import { countTokens } from "../../tokenizer.js";
import { aggregateUsage, defaultUsageLogPath, readUsageLog } from "../../usage.js";
import { type MemoryScope, MemoryStore } from "../../user-memory.js";
import { VERSION, compareVersions, isNpxInstall } from "../../version.js";
import { renderDashboard } from "../commands/stats.js";

export interface SlashResult {
  /** Text to display back to the user as a system/info line. */
  info?: string;
  /** Exit the app. */
  exit?: boolean;
  /** Clear the visible history. */
  clear?: boolean;
  /** Unknown command — display usage hint. */
  unknown?: boolean;
  /**
   * Re-submit this text as a user message after displaying `info`.
   * Used by `/retry` — the slash command truncates the log, then
   * asks the TUI to push the original text back through the normal
   * submit flow so a fresh turn runs.
   */
  resubmit?: string;
}

/**
 * Extra runtime context a slash handler may care about but that isn't
 * already on the loop. Kept as an optional object so tests that only
 * need loop-scoped commands can skip it, and callers only populate the
 * slots that apply to their session.
 */
export interface SlashContext {
  /**
   * The exact `--mcp` / config-derived spec strings that were bridged
   * into this session (one entry per server). Used by `/mcp`. Empty or
   * omitted → no MCP servers attached.
   */
  mcpSpecs?: string[];
  /**
   * Callback for `/undo` — provided by the TUI when it's running in
   * code mode. Returns a human-readable report of what was restored.
   * Absent outside code mode → `/undo` replies "not available here".
   */
  codeUndo?: () => string;
  /**
   * Callback for `/apply` — commits pending edit blocks to disk. Returns
   * a report of what landed. Absent → `/apply` replies "nothing pending"
   * or "not available outside code mode".
   */
  codeApply?: () => string;
  /**
   * Callback for `/discard` — drops the pending edit blocks without
   * touching disk.
   */
  codeDiscard?: () => string;
  /**
   * Root directory passed by `reasonix code`. Enables `/commit`, which
   * runs `git add -A && git commit` in this directory. Missing → `/commit`
   * replies "only available in code mode".
   */
  codeRoot?: string;
  /**
   * How many edit blocks are currently pending `/apply` or `/discard`.
   * Surfaced by `/status`. TUI populates it live from its pending ref;
   * omitted → treat as 0 (chat-only session).
   */
  pendingEditCount?: number;
  /**
   * Callback returning every tool result seen this session in
   * chronological order (oldest first). Powers `/tool [N]` for
   * inspecting the full untruncated output that `EventLog` clips at
   * 400 chars for display. Absent → `/tool` replies "not available".
   */
  toolHistory?: () => Array<{ toolName: string; text: string }>;
  /**
   * Pre-captured inspection reports for each connected MCP server.
   * Populated once at chat startup (chat.tsx) so `/mcp` can render
   * tools + resources + prompts synchronously without needing async
   * handler support.
   */
  mcpServers?: McpServerSummary[];
  /**
   * Directory `/memory` should resolve `REASONIX.md` from. In code
   * mode this is the rootDir the filesystem tools are pinned to; in
   * plain chat this is `process.cwd()` at launch time. Absent → the
   * TUI is running in some non-cwd context (tests) and `/memory`
   * replies "root unknown" instead of silently reading a different dir.
   */
  memoryRoot?: string;
  /**
   * Current plan-mode state, surfaced in `/status` and toggled by
   * `/plan`. Present iff the session is a `reasonix code` run — chat
   * mode doesn't have plan mode.
   */
  planMode?: boolean;
  /**
   * Callback the `/plan` slash uses to flip plan mode on/off. Also
   * mirrors the state to the underlying ToolRegistry so dispatch
   * enforcement follows. Absent → `/plan` replies "only available in
   * code mode".
   */
  setPlanMode?: (on: boolean) => void;
  /**
   * Callback that clears a pending-plan picker state. Called by
   * `/apply-plan` so that when the user force-approves, the picker
   * dismisses without also firing its own approval synthetic (the
   * slash returns its own `resubmit` instead). Safe to call with no
   * pending plan.
   */
  clearPendingPlan?: () => void;
  /**
   * Re-load `~/.reasonix/settings.json` + `<project>/.reasonix/settings.json`
   * and update both the App's hook state and the loop's mutable hook
   * list. Returns the new hook count so the slash can echo a sane
   * confirmation. Absent → `/hooks reload` replies "not available".
   */
  reloadHooks?: () => number;
  /**
   * Latest published version if App's background registry check
   * has completed, `null` otherwise (still in flight OR offline).
   * Drives `/update` — the slash shows whatever the async check
   * already resolved, so the command is fully synchronous.
   */
  latestVersion?: string | null;
  /**
   * Fire-and-forget: kick off a fresh registry fetch. `/update`
   * calls this whenever it encounters `latestVersion === null`
   * so the user can rerun the slash a few seconds later and see
   * a concrete answer. Absent → the slash just reports "pending"
   * with no retry path.
   */
  refreshLatestVersion?: () => void;
  /**
   * Model catalog fetched from DeepSeek's `/models` endpoint at App
   * mount. `null` → still in flight or the call failed (auth / offline);
   * `[]` → the API answered with zero entries. `/models` uses this to
   * render the list, and `/model <id>` uses it for soft validation
   * (warn-only — we still switch even on unknown ids since the list
   * can lag a newly-released model).
   */
  models?: string[] | null;
  /**
   * Fire-and-forget refresh for the models list. Lets `/models` retry
   * after a flaky first fetch without needing async slash support.
   */
  refreshModels?: () => void;
}

export interface McpServerSummary {
  /** Short label shown in the `/mcp` output (server namespace or "anon"). */
  label: string;
  /** Original --mcp spec string. */
  spec: string;
  /** Count of tools bridged into the Reasonix registry from this server. */
  toolCount: number;
  /** Full inspection snapshot — used for the resources + prompts sections. */
  report: InspectionReport;
}

/**
 * Slash command registry. Drives `/help`, the on-type suggestion
 * popup (`SlashSuggestions`), and auto-complete. Kept as data rather
 * than derived from the `handleSlash` switch so summaries can be
 * user-facing rather than code comments.
 *
 * `contextual` gates commands that only make sense in certain modes:
 *   - `"code"` — only show when the TUI is running `reasonix code`
 *   - absent → always shown
 */
export interface SlashCommandSpec {
  cmd: string;
  summary: string;
  contextual?: "code";
  /** If the command takes args, hint text shown after the name. */
  argsHint?: string;
  /**
   * How the first argument position should autocomplete. Shapes the
   * picker that appears below the prompt once the user types `/<cmd>`
   * + space:
   *   - `"file"`    → file picker (uses the same mtime/recency ranking
   *                    as the `@` picker; resolves against codeMode.rootDir).
   *   - `"models"`  → DeepSeek model-id list fetched at startup.
   *   - `string[]`  → small enum of literal values (e.g. `["on", "off"]`).
   *   - omitted     → no picker; a persistent usage hint shows the
   *                    argsHint + summary so the user knows what to type.
   */
  argCompleter?: "file" | "models" | readonly string[];
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { cmd: "help", summary: "show the full command reference" },
  { cmd: "status", summary: "current model, flags, context, session" },
  {
    cmd: "preset",
    argsHint: "<fast|smart|max>",
    summary: "one-tap model + harvest + branch bundle",
    argCompleter: ["fast", "smart", "max"],
  },
  {
    cmd: "model",
    argsHint: "<id>",
    summary: "switch DeepSeek model id",
    argCompleter: "models",
  },
  { cmd: "models", summary: "list available models fetched from DeepSeek /models" },
  {
    cmd: "harvest",
    argsHint: "[on|off]",
    summary: "toggle Pillar-2 plan-state extraction",
    argCompleter: ["on", "off"],
  },
  {
    cmd: "branch",
    argsHint: "<N|off>",
    summary: "run N parallel samples per turn (N>=2)",
    argCompleter: ["off", "2", "3", "4", "5"],
  },
  { cmd: "mcp", summary: "list MCP servers + tools attached to this session" },
  { cmd: "tool", argsHint: "[N]", summary: "dump full output of the Nth tool call (1=latest)" },
  {
    cmd: "memory",
    argsHint: "[list|show <name>|forget <name>|clear <scope> confirm]",
    summary: "show / manage pinned memory (REASONIX.md + ~/.reasonix/memory)",
  },
  {
    cmd: "skill",
    argsHint: "[list|show <name>|<name> [args]]",
    summary: "list / run user skills (<project>/.reasonix/skills + ~/.reasonix/skills)",
  },
  {
    cmd: "hooks",
    argsHint: "[reload]",
    summary: "list active hooks (settings.json under .reasonix/) · reload re-reads from disk",
  },
  {
    cmd: "update",
    summary: "show current vs latest version + the shell command to upgrade",
  },
  {
    cmd: "stats",
    summary:
      "cross-session cost dashboard (today / week / month / all-time · cache hit · vs Claude)",
  },
  { cmd: "think", summary: "dump the last turn's full R1 reasoning (reasoner only)" },
  {
    cmd: "context",
    summary: "break down where context tokens are going: system / tools / per-turn log",
  },
  { cmd: "retry", summary: "truncate & resend your last message (fresh sample)" },
  {
    cmd: "compact",
    argsHint: "[tokens]",
    summary: "shrink oversized tool results in the log (cap in tokens, default 4000)",
  },
  { cmd: "keys", summary: "show all keyboard shortcuts and prompt prefixes" },
  { cmd: "sessions", summary: "list saved sessions (current marked with ▸)" },
  { cmd: "forget", summary: "delete the current session from disk" },
  { cmd: "setup", summary: "reminds you to exit and run `reasonix setup`" },
  { cmd: "clear", summary: "clear visible scrollback only (log/context kept)" },
  { cmd: "new", summary: "start a fresh conversation (clear context + scrollback)" },
  { cmd: "exit", summary: "quit the TUI" },
  // Code-mode only
  {
    cmd: "edit",
    argsHint: "<file> <instruction>",
    summary: "one-shot surgical edit — inlines <file>, asks model for a SEARCH/REPLACE block",
    contextual: "code",
    argCompleter: "file",
  },
  { cmd: "apply", summary: "commit pending edit blocks to disk", contextual: "code" },
  { cmd: "discard", summary: "drop pending edit blocks without writing", contextual: "code" },
  { cmd: "undo", summary: "roll back the last applied edit batch", contextual: "code" },
  {
    cmd: "commit",
    argsHint: '"msg"',
    summary: "git add -A && git commit -m ...",
    contextual: "code",
  },
  {
    cmd: "plan",
    argsHint: "[on|off]",
    summary: "toggle read-only plan mode (writes bounced until submit_plan + approval)",
    contextual: "code",
    argCompleter: ["on", "off"],
  },
  {
    cmd: "apply-plan",
    summary: "force-approve a pending / in-text plan (fallback if picker was missed)",
    contextual: "code",
  },
];

/**
 * Filter the registry by a prefix string (without the leading `/`).
 * Empty prefix returns the full non-contextual list (plus code-mode
 * entries when `codeMode` is true). Case-insensitive.
 */
export function suggestSlashCommands(prefix: string, codeMode = false): SlashCommandSpec[] {
  const p = prefix.toLowerCase();
  return SLASH_COMMANDS.filter((c) => {
    if (c.contextual === "code" && !codeMode) return false;
    return c.cmd.startsWith(p);
  });
}

/**
 * Shape describing what the prompt buffer is asking for AFTER the
 * user has committed to a slash command (`/<cmd> `) and started
 * typing its first argument. Consumed by the TUI to drive an
 * argument-level picker.
 */
export interface SlashArgContext {
  /** The command spec (looked up by name from SLASH_COMMANDS). */
  spec: SlashCommandSpec;
  /** The partial first-argument text, possibly empty. */
  partial: string;
  /**
   * Buffer offset where `partial` begins. Used by the TUI to splice
   * a picked completion back in at the right position.
   */
  partialOffset: number;
  /**
   * Classification of what the caller should show:
   *   - `"picker"` → an interactive picker (file / enum / models). The
   *     caller uses `spec.argCompleter` to pick the data source and
   *     filters against `partial`.
   *   - `"hint"`   → past the completable position (additional args or
   *     no completer declared). Caller shows a dim usage hint only.
   */
  kind: "picker" | "hint";
}

/**
 * Classify the prompt buffer for argument completion. Returns `null`
 * when the buffer isn't in a slash-with-args state.
 *
 * Firing shape: input must start with `/<cmd> ` (space after a known
 * command). The character right after the space through end-of-buffer
 * is the "arg tail"; if the tail has NO internal whitespace the
 * picker is live (tail is the partial). If the tail has whitespace,
 * the user has moved past the first argument position and we surface
 * the usage hint only.
 */
export function detectSlashArgContext(input: string, codeMode = false): SlashArgContext | null {
  // `/cmd <rest>` — one space, rest captured up to end-of-buffer.
  const m = /^\/(\S+) ([\s\S]*)$/.exec(input);
  if (!m) return null;
  const cmdName = m[1]!.toLowerCase();
  const tail = m[2] ?? "";
  const spec = SLASH_COMMANDS.find(
    (s) => s.cmd === cmdName && (s.contextual !== "code" || codeMode),
  );
  if (!spec) return null;
  const hasInternalSpace = /\s/.test(tail);
  const partialOffset = input.length - tail.length;
  if (hasInternalSpace) {
    // Past the first arg position (typing the second arg for e.g.
    // `/edit <file> <instruction>`, or mid-sentence for free-form).
    return { spec, partial: tail, partialOffset, kind: "hint" };
  }
  // No internal whitespace — we're still typing the first arg. Picker
  // is live if the spec declares a completer; otherwise show a hint
  // ("what goes here?") since the user's guessing.
  return {
    spec,
    partial: tail,
    partialOffset,
    kind: spec.argCompleter ? "picker" : "hint",
  };
}

export function parseSlash(text: string): { cmd: string; args: string[] } | null {
  if (!text.startsWith("/")) return null;
  const parts = text.slice(1).trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  if (!cmd) return null;
  return { cmd, args: parts.slice(1) };
}

export function handleSlash(
  cmd: string,
  args: string[],
  loop: CacheFirstLoop,
  ctx: SlashContext = {},
): SlashResult {
  switch (cmd) {
    case "exit":
    case "quit":
      return { exit: true };

    case "clear":
      return {
        clear: true,
        info: "▸ cleared visible scrollback only. Context (message log) is intact — next turn still sees everything. Use /new to start fresh, or /forget to delete the session entirely.",
      };

    case "new":
    case "reset": {
      // Actually drop the in-memory log + rewrite the session file
      // so the NEXT call has no prior context. Keeps session name,
      // model, and other config — just the conversation is reset.
      const { dropped } = loop.clearLog();
      return {
        clear: true,
        info: `▸ new conversation — dropped ${dropped} message(s) from context. Same session, fresh slate.`,
      };
    }

    case "keys":
      return {
        info: [
          "Keyboard & prompt shortcuts:",
          "",
          "  Enter                  submit the current prompt",
          "  Shift+Enter  /  Ctrl+J  insert a newline (multi-line prompt)",
          "  \\<Enter>               bash-style line continuation",
          "  ← → ↑ ↓                move cursor / recall history when buffer empty",
          "  Ctrl+A / Ctrl+E        jump to start / end of the current line",
          "  Backspace              delete left;  Delete   delete under cursor",
          "  Esc                    abort the in-flight turn",
          "  y / n                  accept / reject pending edits (code mode)",
          "",
          "Prompt prefixes:",
          "  /<name>                slash command; Tab/Enter picks from the suggestion list",
          "  @<path>                inline a file under [Referenced files] (code mode).",
          "                           Trailing `@…` opens a file picker; ↑/↓ navigate, Tab/Enter pick.",
          "  !<cmd>                 run <cmd> as shell in the sandbox root; output goes into context",
          "                           so the model sees it next turn. No allowlist gate.",
          "",
          "Pickers (slash + @-mention):",
          "  ↑ / ↓                  navigate the suggestion list",
          "  Tab                    insert the highlighted item without submitting",
          "  Enter                  insert and (slash) run it, (@) keep editing",
          "",
          "Useful slashes: /help · /context · /stats · /compact · /new · /exit",
        ].join("\n"),
      };

    case "help":
    case "?":
      return {
        info: [
          "Commands:",
          "  /help                    this message",
          "  /keys                    keyboard shortcuts + prompt prefixes (!, @, /)",
          "  /status                  show current settings",
          "  /preset <fast|smart|max> one-tap presets — see below",
          "  /model <id>              deepseek-chat or deepseek-reasoner",
          "  /harvest [on|off]        Pillar 2: structured plan-state extraction",
          "  /branch <N|off>          run N parallel samples (N>=2), pick most confident",
          "  /mcp                     list MCP servers + tools attached to this session",
          "  /setup                   (exit + reconfigure) → run `reasonix setup`",
          "  /compact [tokens]        shrink large tool results in history (default 4000 tokens/result)",
          "  /think                   dump the most recent turn's full R1 reasoning (reasoner only)",
          "  /tool [N]                list tool calls (or dump full output of #N, 1=most recent)",
          "  /memory [sub]            show pinned memory (REASONIX.md + ~/.reasonix/memory).",
          "                            subs: list | show <name> | forget <name> | clear <scope> confirm",
          "  /skill [sub]             list / run user skills (project/.reasonix/skills + ~/.reasonix/skills).",
          "                            subs: list | show <name> | <name> [args] (injects skill body as user turn)",
          "  /retry                   truncate & resend your last message (fresh sample from the model)",
          '  /edit <file> "instruction"  (code mode) one-shot surgical edit — inlines <file>, asks for SEARCH/REPLACE',
          "  /apply                   (code mode) commit the pending edit blocks to disk",
          "  /discard                 (code mode) drop pending edits without writing",
          "  /undo                    (code mode) roll back the last applied edit batch",
          '  /commit "msg"            (code mode) git add -A && git commit -m "msg"',
          "  /plan [on|off]           (code mode) toggle read-only plan mode; writes gated behind submit_plan + your approval",
          "  /apply-plan              (code mode) force-approve pending/in-text plan (fallback)",
          "  /sessions                list saved sessions (current is marked with ▸)",
          "  /forget                  delete the current session from disk",
          "  /new                     start fresh: drop all context + clear scrollback",
          "  /clear                   clear displayed scrollback only (context kept — model still sees it)",
          "  /exit                    quit",
          "",
          "Shell shortcut:",
          "  !<cmd>                   run <cmd> in the sandbox root; output goes into",
          "                             the conversation so the model sees it next turn.",
          "                             No allowlist gate — user-typed = explicit consent.",
          "                             Example: !git status   !ls src/   !npm test",
          "",
          "File references (code mode):",
          "  @path/to/file            inline file content under [Referenced files] on send.",
          "                             Type `@` to open the picker (↑↓ navigate, Tab/Enter pick).",
          "",
          "Presets:",
          "  fast   deepseek-chat   no harvest  no branch    ~1¢/100turns  ← default",
          "  smart  reasoner        harvest                  ~10x cost, slower",
          "  max    reasoner        harvest     branch 3     ~30x cost, slowest",
          "",
          "Sessions (auto-enabled by default, named 'default'):",
          "  reasonix chat --session <name>   use a different named session",
          "  reasonix chat --no-session       disable persistence for this run",
        ].join("\n"),
      };

    case "mcp": {
      const servers = ctx.mcpServers ?? [];
      const specs = ctx.mcpSpecs ?? [];
      const toolSpecs = loop.prefix.toolSpecs ?? [];
      if (servers.length === 0 && specs.length === 0 && toolSpecs.length === 0) {
        return {
          info:
            "no MCP servers attached. Run `reasonix setup` to pick some, " +
            'or launch with --mcp "<spec>". `reasonix mcp list` shows the catalog.',
        };
      }
      // Rich path — we have full inspection reports, so show each
      // server with its tools / resources / prompts grouped together.
      if (servers.length > 0) {
        const lines: string[] = [];
        for (const s of servers) {
          const { report } = s;
          const serverName = report.serverInfo.name || "(unknown)";
          const serverVer = report.serverInfo.version ? ` v${report.serverInfo.version}` : "";
          lines.push(`[${s.label}] ${serverName}${serverVer}  —  ${s.spec}`);
          lines.push(`  tools     ${s.toolCount}`);
          appendSection(lines, "resources", report.resources);
          appendSection(lines, "prompts  ", report.prompts);
          lines.push("");
        }
        lines.push(
          "Chat mode consumes tools today; resources+prompts are surfaced here for awareness.",
        );
        lines.push(
          "Full catalog: `reasonix mcp list` · deeper diagnosis: `reasonix mcp inspect <spec>`.",
        );
        return { info: lines.join("\n") };
      }
      // Fallback — older path when the TUI hasn't populated `mcpServers`.
      const lines: string[] = [];
      if (specs.length > 0) {
        lines.push(`MCP servers (${specs.length}):`);
        for (const spec of specs) lines.push(`  · ${spec}`);
        lines.push("");
      }
      if (toolSpecs.length > 0) {
        lines.push(`Tools in registry (${toolSpecs.length}):`);
        for (const t of toolSpecs) lines.push(`  · ${t.function.name}`);
      }
      lines.push("");
      lines.push("To change this set, exit and run `reasonix setup`.");
      return { info: lines.join("\n") };
    }

    case "setup":
      return {
        info:
          "To reconfigure (preset, MCP servers, API key), exit this chat and run " +
          "`reasonix setup`. Changes take effect on next launch.",
      };

    case "retry": {
      const prev = loop.retryLastUser();
      if (!prev) {
        return {
          info: "nothing to retry — no prior user message in this session's log.",
        };
      }
      const preview = prev.length > 80 ? `${prev.slice(0, 80)}…` : prev;
      return {
        info: `▸ retrying: "${preview}"`,
        resubmit: prev,
      };
    }

    case "memory": {
      return handleMemorySlash(args, ctx);
    }

    case "skill":
    case "skills": {
      return handleSkillSlash(args, ctx);
    }

    case "hook":
    case "hooks": {
      return handleHooksSlash(args, loop, ctx);
    }

    case "update": {
      return handleUpdateSlash(ctx);
    }

    case "stats": {
      return handleStatsSlash();
    }

    case "think":
    case "reasoning": {
      const raw = loop.scratch.reasoning;
      if (!raw || !raw.trim()) {
        return {
          info:
            "no reasoning cached. `/think` shows the full R1 thought for the most recent turn — " +
            "only `deepseek-reasoner` produces it, and only once the turn completes.",
        };
      }
      return { info: `↳ full thinking (${raw.length} chars):\n\n${raw.trim()}` };
    }

    case "tool": {
      // EventLog truncates tool results at 400 chars for display. When
      // the user wants to check what the model actually read (e.g. to
      // verify it isn't hallucinating a file's contents), they need
      // the full text. `/tool` is the escape hatch.
      const history = ctx.toolHistory?.() ?? [];
      if (history.length === 0) {
        return {
          info:
            "no tool calls yet in this session. `/tool` lists them once the model has actually " +
            "used a tool; `/tool N` dumps the full (untruncated) output of the Nth-most-recent.",
        };
      }
      const raw = (args[0] ?? "").toLowerCase();
      if (raw === "" || raw === "list" || raw === "ls") {
        return { info: formatToolList(history) };
      }
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) {
        return {
          info: "usage: /tool [N]   (no arg → list; N=1 → most recent result in full, N=2 → previous, …)",
        };
      }
      if (n > history.length) {
        return {
          info: `only ${history.length} tool call(s) in history — asked for #${n}. Try /tool with no arg to see the list.`,
        };
      }
      const entry = history[history.length - n];
      if (!entry) {
        return { info: `could not read tool call #${n}` };
      }
      return {
        info: `↳ tool<${entry.toolName}> #${n} (${entry.text.length} chars):\n\n${entry.text}`,
      };
    }

    case "undo": {
      if (!ctx.codeUndo) {
        return {
          info: "/undo is only available inside `reasonix code` — chat mode doesn't apply edits.",
        };
      }
      return { info: ctx.codeUndo() };
    }

    case "edit": {
      // One-shot surgical edit. We re-express the user's intent as
      //     @<file> <instruction>
      //     Output ONLY a SEARCH/REPLACE block for this one edit.
      // and feed it through the normal turn machinery. `@` expansion
      // (0.5.5) inlines the file content under a `[Referenced files]`
      // block, the model returns a SEARCH/REPLACE block, the code-mode
      // loop catches it into pendingEdits, and the existing y/n gate
      // fires. Zero new code path — the slash is sugar over the stuff
      // that already works.
      if (!ctx.codeRoot) {
        return {
          info: "/edit only works in code mode. Start Reasonix with `reasonix code <dir>` so filesystem tools and SEARCH/REPLACE handling are active.",
        };
      }
      const filePath = args[0];
      if (!filePath) {
        return {
          info: 'usage: /edit <file> <instruction>   e.g. /edit src/loop.ts "add a comment above the compact() method"',
        };
      }
      const instruction = args.slice(1).join(" ").trim();
      if (!instruction) {
        return {
          info: `usage: /edit <file> <instruction>   — missing instruction for "${filePath}".`,
        };
      }
      return {
        resubmit: `@${filePath} ${instruction}\n\nOutput ONLY a SEARCH/REPLACE block for this one edit. No prose, no explanation.`,
      };
    }

    case "apply": {
      if (!ctx.codeApply) {
        return {
          info: "/apply is only available inside `reasonix code` (nothing to apply here).",
        };
      }
      return { info: ctx.codeApply() };
    }

    case "discard": {
      if (!ctx.codeDiscard) {
        return {
          info: "/discard is only available inside `reasonix code`.",
        };
      }
      return { info: ctx.codeDiscard() };
    }

    case "plan": {
      if (!ctx.setPlanMode) {
        return {
          info: "/plan is only available inside `reasonix code` — chat mode doesn't gate tool writes.",
        };
      }
      const currentOn = Boolean(ctx.planMode);
      const raw = (args[0] ?? "").toLowerCase();
      let target: boolean;
      if (raw === "on" || raw === "true" || raw === "1") target = true;
      else if (raw === "off" || raw === "false" || raw === "0") target = false;
      else target = !currentOn;
      ctx.setPlanMode(target);
      if (target) {
        return {
          info: "▸ plan mode ON — write tools are gated; the model MUST call `submit_plan` before anything executes. (The model can also call submit_plan on its own for big tasks even when plan mode is off — this toggle is the stronger, explicit constraint.) Type /plan off to leave.",
        };
      }
      return {
        info: "▸ plan mode OFF — write tools are live again. Model can still propose plans autonomously for large tasks.",
      };
    }

    case "apply-plan":
    case "applyplan": {
      if (!ctx.setPlanMode) {
        return {
          info: "/apply-plan is only available inside `reasonix code`.",
        };
      }
      ctx.setPlanMode(false);
      ctx.clearPendingPlan?.();
      return {
        info: "▸ plan approved — implementing",
        resubmit:
          "The plan above has been approved. Implement it now. You are out of plan mode — use edit_file / write_file / run_command as needed. Stick to the plan unless you discover a concrete reason to deviate; if you do, tell me and wait for a response before making that deviation.",
      };
    }

    case "commit": {
      if (!ctx.codeRoot) {
        return {
          info: "/commit is only available inside `reasonix code` (needs a rooted git repo).",
        };
      }
      // Reassemble the original argv. The parser lowercases cmd but
      // leaves args alone, and the TUI splits on whitespace which
      // mangles quoted messages — rejoin with spaces and strip a
      // surrounding pair of double quotes if the user wrote them.
      const raw = args.join(" ").trim();
      const message = stripOuterQuotes(raw);
      if (!message) {
        return {
          info: `usage: /commit "your commit message"  — runs \`git add -A && git commit -m "…"\` in ${ctx.codeRoot}`,
        };
      }
      return runGitCommit(ctx.codeRoot, message);
    }

    case "compact": {
      // Manual companion to the automatic 60%/80% auto-compact. Re-
      // applies token-aware truncation with a tighter cap (default 4000
      // tokens per tool result) and rewrites the session file so the
      // shrink persists. Useful when the ctx gauge in StatsPanel goes
      // yellow/red mid-session and the user wants to keep chatting
      // without /forget'ing everything.
      const tight = Number.parseInt(args[0] ?? "", 10);
      const cap = Number.isFinite(tight) && tight >= 100 ? tight : 4000;
      const { healedCount, tokensSaved, charsSaved } = loop.compact(cap);
      if (healedCount === 0) {
        return {
          info: `▸ nothing to compact — no tool result in history exceeds ${cap.toLocaleString()} tokens.`,
        };
      }
      return {
        info: `▸ compacted ${healedCount} tool result(s) to ${cap.toLocaleString()} tokens each, saved ${tokensSaved.toLocaleString()} tokens (${charsSaved.toLocaleString()} chars). Session file rewritten.`,
      };
    }

    case "sessions": {
      const items = listSessions();
      if (items.length === 0) {
        return {
          info: "no saved sessions yet — chat normally and your messages will be saved automatically",
        };
      }
      const lines = ["Saved sessions:"];
      for (const s of items) {
        const sizeKb = (s.size / 1024).toFixed(1);
        const when = s.mtime.toISOString().replace("T", " ").slice(0, 16);
        const marker = s.name === loop.sessionName ? "▸" : " ";
        lines.push(
          `  ${marker} ${s.name.padEnd(22)} ${String(s.messageCount).padStart(5)} msgs  ${sizeKb.padStart(7)} KB  ${when}`,
        );
      }
      lines.push("");
      lines.push("Resume with: reasonix chat --session <name>");
      return { info: lines.join("\n") };
    }

    case "forget": {
      if (!loop.sessionName) {
        return { info: "not in a session — nothing to forget" };
      }
      const name = loop.sessionName;
      const ok = deleteSession(name);
      return {
        info: ok
          ? `▸ deleted session "${name}" — current screen still shows the conversation, but next launch starts fresh`
          : `could not delete session "${name}" (already gone?)`,
      };
    }

    case "context": {
      // Measure each slice of the next request locally so the user can
      // see *where* context is being spent — a much more useful number
      // than the "last turn's total" the gauge shows. Tokenization is
      // lazy so the first /context call carries the data-file load
      // cost (~100ms); subsequent calls are pure compute.
      const systemTokens = countTokens(loop.prefix.system);
      const toolsTokens = countTokens(JSON.stringify(loop.prefix.toolSpecs));
      const entries = loop.log.toMessages();
      let userTokens = 0;
      let assistantTokens = 0;
      let toolResultTokens = 0;
      let toolCallTokens = 0;
      const toolBreakdown: Array<{ name: string; tokens: number; turn: number }> = [];
      let logTurn = 0;
      for (const e of entries) {
        const content = typeof e.content === "string" ? e.content : "";
        if (e.role === "user") {
          userTokens += countTokens(content);
          logTurn += 1;
        } else if (e.role === "assistant") {
          assistantTokens += countTokens(content);
          if (Array.isArray(e.tool_calls) && e.tool_calls.length > 0) {
            toolCallTokens += countTokens(JSON.stringify(e.tool_calls));
          }
        } else if (e.role === "tool") {
          const n = countTokens(content);
          toolResultTokens += n;
          toolBreakdown.push({ name: e.name ?? "?", tokens: n, turn: logTurn });
        }
      }
      const logTokens = userTokens + assistantTokens + toolResultTokens + toolCallTokens;
      const total = systemTokens + toolsTokens + logTokens;
      const ctxMax = DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS;
      const pct = (n: number) =>
        total > 0 ? `${Math.round((n / total) * 100)}%`.padStart(4) : "  0%";
      const row = (label: string, n: number, note = "") =>
        `  ${label.padEnd(20)}${compactNum(n).padStart(8)} tokens ${pct(n)}${note ? `   ${note}` : ""}`;

      const lines = [
        `Next-request estimate: ~${compactNum(total)} tokens of ${compactNum(ctxMax)} (${Math.round(
          (total / ctxMax) * 100,
        )}% of window)`,
        "",
        row("system prompt", systemTokens),
        row("tool specs", toolsTokens, `(${loop.prefix.toolSpecs.length} tools)`),
        row("log (all turns)", logTokens, `(${entries.length} messages)`),
        `    user                ${compactNum(userTokens).padStart(8)} tokens`,
        `    assistant           ${compactNum(assistantTokens).padStart(8)} tokens`,
        `    tool-call args      ${compactNum(toolCallTokens).padStart(8)} tokens`,
        `    tool results        ${compactNum(toolResultTokens).padStart(8)} tokens`,
      ];

      // Top 5 heaviest tool results — usually where unexpected bloat
      // lives (a big read_file, an unfiltered search_content).
      if (toolBreakdown.length > 0) {
        const top = [...toolBreakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
        lines.push("");
        lines.push(`Top tool results by cost (of ${toolBreakdown.length} total):`);
        for (const t of top) {
          lines.push(
            `    turn ${String(t.turn).padStart(3)}  ${t.name.padEnd(22)} ${compactNum(t.tokens).padStart(8)} tokens`,
          );
        }
      }

      lines.push("");
      lines.push(
        "Count is a local estimate (DeepSeek V3 tokenizer, pure-TS port); server prompt_tokens may add ~3-6% for chat-template role markers.",
      );
      return { info: lines.join("\n") };
    }

    case "status": {
      const branchBudget = loop.branchOptions.budget ?? 1;
      const ctxMax = DEEPSEEK_CONTEXT_TOKENS[loop.model] ?? DEFAULT_CONTEXT_TOKENS;
      const lastPromptTokens = loop.stats.summary().lastPromptTokens;
      const ctxPct = ctxMax > 0 ? Math.round((lastPromptTokens / ctxMax) * 100) : 0;
      const ctxLine =
        lastPromptTokens > 0
          ? `  ctx    ${compactNum(lastPromptTokens)}/${compactNum(ctxMax)} (${ctxPct}%)`
          : "  ctx    no turns yet";
      const pending = ctx.pendingEditCount ?? 0;
      const sessionLine = loop.sessionName
        ? `  session "${loop.sessionName}" · ${loop.log.length} messages in log (resumed ${loop.resumedMessageCount})`
        : "  session (ephemeral — no persistence)";
      const mcpCount = ctx.mcpSpecs?.length ?? 0;
      const toolCount = loop.prefix.toolSpecs.length;
      const mcpLine = `  mcp     ${mcpCount} server(s), ${toolCount} tool(s) in registry`;
      const pendingLine =
        pending > 0 ? `  edits   ${pending} pending (/apply to commit, /discard to drop)` : "";
      const planLine = ctx.planMode ? "  plan    ON — writes gated (submit_plan + approval)" : "";
      const lines = [
        `  model   ${loop.model}`,
        `  flags   harvest=${loop.harvestEnabled ? "on" : "off"} · branch=${branchBudget > 1 ? branchBudget : "off"} · stream=${loop.stream ? "on" : "off"}`,
        ctxLine,
        mcpLine,
        sessionLine,
      ];
      if (pendingLine) lines.push(pendingLine);
      if (planLine) lines.push(planLine);
      return { info: lines.join("\n") };
    }

    case "model": {
      const id = args[0];
      const known = ctx.models ?? null;
      if (!id) {
        const hint =
          known && known.length > 0
            ? known.join(" | ")
            : "try deepseek-chat or deepseek-reasoner — run /models to fetch the live list";
        return { info: `usage: /model <id>   (${hint})` };
      }
      loop.configure({ model: id });
      // Soft validation: if we have the live list and the id isn't in
      // it, flag a warning but still switch — DeepSeek may have just
      // released something we haven't indexed yet, and refusing would
      // be worse than a bad API error on the next call.
      if (known && known.length > 0 && !known.includes(id)) {
        return {
          info: `model → ${id}   (⚠ not in the fetched catalog: ${known.join(", ")}. If this is wrong the next call will 400 — run /models to refresh.)`,
        };
      }
      return { info: `model → ${id}` };
    }

    case "models": {
      const list = ctx.models ?? null;
      if (list === null) {
        ctx.refreshModels?.();
        return {
          info: "fetching /models from DeepSeek… run /models again in a moment. If it stays empty, your API key may lack permission or the network is blocked.",
        };
      }
      if (list.length === 0) {
        return {
          info: "DeepSeek /models returned an empty list. Try /models again, or check your account status at api-docs.deepseek.com.",
        };
      }
      const current = loop.model;
      const lines = list.map((id) => (id === current ? `▸ ${id}  (current)` : `  ${id}`));
      return {
        info: [
          `Available models (DeepSeek /models · ${list.length} total):`,
          "",
          ...lines,
          "",
          "Switch with: /model <id>",
        ].join("\n"),
      };
    }

    case "harvest": {
      const arg = (args[0] ?? "").toLowerCase();
      const on = arg === "" ? !loop.harvestEnabled : arg === "on" || arg === "true" || arg === "1";
      loop.configure({ harvest: on });
      return { info: `harvest → ${loop.harvestEnabled ? "on" : "off"}` };
    }

    case "preset": {
      const name = (args[0] ?? "").toLowerCase();
      if (name === "fast" || name === "default") {
        loop.configure({ model: "deepseek-chat", harvest: false, branch: 1 });
        return { info: "preset → fast  (deepseek-chat, no harvest, no branch)" };
      }
      if (name === "smart") {
        loop.configure({ model: "deepseek-reasoner", harvest: true, branch: 1 });
        return { info: "preset → smart  (reasoner + harvest, ~10x cost vs fast)" };
      }
      if (name === "max" || name === "best") {
        loop.configure({ model: "deepseek-reasoner", harvest: true, branch: 3 });
        return {
          info: "preset → max  (reasoner + harvest + branch3, ~30x cost vs fast, slowest)",
        };
      }
      return { info: "usage: /preset <fast|smart|max>" };
    }

    case "branch": {
      const raw = (args[0] ?? "").toLowerCase();
      if (raw === "" || raw === "off" || raw === "0" || raw === "1") {
        loop.configure({ branch: 1 });
        return { info: "branch → off" };
      }
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 2) {
        return { info: "usage: /branch <N>   (N>=2, or 'off')" };
      }
      if (n > 8) {
        return { info: "branch budget capped at 8 to prevent runaway cost" };
      }
      loop.configure({ branch: n });
      return { info: `branch → ${n}  (harvest auto-enabled; streaming disabled)` };
    }

    default:
      return { unknown: true, info: `unknown command: /${cmd}  (try /help)` };
  }
}

/**
 * `/skill` family. Bare `/skill` (or `/skill list`) prints the
 * discovered skills from `<projectRoot>/.reasonix/skills` (code mode
 * only) + `~/.reasonix/skills`. `/skill show <name>` dumps one body
 * inline for reading. `/skill <name> [args...]` injects the skill body
 * as a user turn via `resubmit` — the same mechanism `/apply-plan`
 * uses — so the next model turn runs with the skill's instructions
 * fresh in the log.
 *
 * Project scope is only populated when the session has a `codeRoot`
 * (set by `reasonix code`). In plain chat mode the store reads the
 * global scope only, matching how user-memory behaves.
 */
/**
 * `/update` — inside the TUI we deliberately do NOT spawn `npm install`.
 * stdio:inherit into a running Ink renderer corrupts the display, and
 * the process being upgraded is the same process that's still reading
 * its own binaries (messy on Windows). Instead we surface what we
 * already know from the App's background registry check and print the
 * exact shell command the user should run after exiting.
 *
 * The `latestVersion` ctx field is populated by App.tsx's mount-time
 * `getLatestVersion()` effect. When it's `null` we report the check
 * as pending/offline — still a useful output (current version + how
 * to force a fresh check from another terminal).
 */
/**
 * `/stats` — dashboard view of `~/.reasonix/usage.jsonl`, the same
 * roll-up `reasonix stats` (no arg) prints at the shell. Synchronous
 * disk read; cheap enough that we don't bother caching between slash
 * invocations.
 *
 * No transcript-path variant in-TUI: the per-file summary is scripty
 * and rarely wanted mid-session. If someone needs it they have the
 * CLI form (`reasonix stats <path>`).
 */
function handleStatsSlash(): SlashResult {
  const path = defaultUsageLogPath();
  const records = readUsageLog(path);
  if (records.length === 0) {
    return {
      info: [
        "no usage data yet.",
        "",
        `  ${path}`,
        "",
        "every turn you run here appends one record — this session's turns",
        "will show up in the dashboard once you send a message.",
      ].join("\n"),
    };
  }
  const agg = aggregateUsage(records);
  return { info: renderDashboard(agg, path) };
}

function handleUpdateSlash(ctx: SlashContext): SlashResult {
  const latest = ctx.latestVersion ?? null;
  const lines: string[] = [`current: reasonix ${VERSION}`];
  if (latest === null) {
    // Kick off a fresh fetch so a follow-up /update a few seconds
    // later has a real answer instead of the same pending message.
    ctx.refreshLatestVersion?.();
    lines.push(
      "latest:  (not yet resolved — background check in flight or offline)",
      "",
      "triggered a fresh registry fetch — retry `/update` in a few seconds,",
      "or run `reasonix update` in another terminal to force it synchronously.",
    );
    return { info: lines.join("\n") };
  }
  lines.push(`latest:  reasonix ${latest}`);
  const diff = compareVersions(VERSION, latest);
  if (diff >= 0) {
    lines.push("", "you're on the latest. nothing to do.");
    return { info: lines.join("\n") };
  }
  if (isNpxInstall()) {
    lines.push(
      "",
      "you're running via npx — the next `npx reasonix ...` launch will auto-fetch.",
      "to force a refresh sooner: `npm cache clean --force`.",
    );
  } else {
    lines.push(
      "",
      "to upgrade, exit this session and run:",
      "  reasonix update           (interactive, dry-run supported via --dry-run)",
      "  npm install -g reasonix@latest   (direct)",
      "",
      "in-session install is deliberately disabled — the npm spawn would",
      "corrupt this TUI's rendering and Windows can lock the running binary.",
    );
  }
  return { info: lines.join("\n") };
}

function handleHooksSlash(args: string[], loop: CacheFirstLoop, ctx: SlashContext): SlashResult {
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "reload") {
    if (!ctx.reloadHooks) {
      return {
        info: "/hooks reload is not available in this context (no reload callback wired).",
      };
    }
    const count = ctx.reloadHooks();
    return { info: `▸ reloaded hooks · ${count} active` };
  }

  if (sub !== "" && sub !== "list" && sub !== "ls") {
    return {
      info: "usage: /hooks            list active hooks\n       /hooks reload     re-read settings.json files",
    };
  }

  const hooks = loop.hooks;
  const projPath = ctx.codeRoot ? projectSettingsPath(ctx.codeRoot) : undefined;
  const globPath = globalSettingsPath();
  if (hooks.length === 0) {
    const lines = [
      "no hooks configured.",
      "",
      "drop a settings.json with a `hooks` key into either of:",
      ctx.codeRoot
        ? `  · ${projPath} (project)`
        : "  · <project>/.reasonix/settings.json (project)",
      `  · ${globPath} (global)`,
      "",
      "events: PreToolUse, PostToolUse, UserPromptSubmit, Stop",
      "exit 0 = pass · exit 2 = block (Pre*) · other = warn",
    ];
    return { info: lines.join("\n") };
  }

  const grouped = new Map<HookEvent, ResolvedHook[]>();
  for (const event of HOOK_EVENTS) grouped.set(event, []);
  for (const h of hooks) grouped.get(h.event)?.push(h);

  const lines: string[] = [`▸ ${hooks.length} hook(s) loaded`];
  for (const event of HOOK_EVENTS) {
    const list = grouped.get(event) ?? [];
    if (list.length === 0) continue;
    lines.push("", `${event}:`);
    for (const h of list) {
      const match = h.match && h.match !== "*" ? ` match=${h.match}` : "";
      const desc = h.description ? `  — ${h.description}` : "";
      lines.push(`  [${h.scope}]${match} ${h.command}${desc}`);
    }
  }
  lines.push("", `sources: project=${projPath ?? "(none — chat mode)"} · global=${globPath}`);
  return { info: lines.join("\n") };
}

function handleSkillSlash(args: string[], ctx: SlashContext): SlashResult {
  const store = new SkillStore({ projectRoot: ctx.codeRoot });
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "" || sub === "list" || sub === "ls") {
    const skills = store.list();
    if (skills.length === 0) {
      const lines = ["no skills found. Reasonix reads skills from:"];
      if (store.hasProjectScope()) {
        lines.push(
          "  · <project>/.reasonix/skills/<name>/SKILL.md  (or <name>.md)  — project scope",
        );
      }
      lines.push("  · ~/.reasonix/skills/<name>/SKILL.md  (or <name>.md)  — global scope");
      if (!store.hasProjectScope()) {
        lines.push("  (project scope is only active in `reasonix code`)");
      }
      lines.push(
        "",
        "Each file's frontmatter needs at least `name` and `description`.",
        "Invoke a skill with `/skill <name> [args]` or by asking the model to call `run_skill`.",
      );
      return { info: lines.join("\n") };
    }
    const lines = [`User skills (${skills.length}):`];
    for (const s of skills) {
      const scope = `(${s.scope})`.padEnd(11);
      const name = s.name.padEnd(24);
      const desc = s.description.length > 70 ? `${s.description.slice(0, 69)}…` : s.description;
      lines.push(`  ${scope} ${name}  ${desc}`);
    }
    lines.push("");
    lines.push("View body: /skill show <name>   Run: /skill <name> [args]");
    return { info: lines.join("\n") };
  }

  if (sub === "show" || sub === "cat") {
    const target = args[1];
    if (!target) return { info: "usage: /skill show <name>" };
    const skill = store.read(target);
    if (!skill) return { info: `no skill found: ${target}` };
    return {
      info: [
        `▸ ${skill.name}  (${skill.scope})`,
        skill.description ? `  ${skill.description}` : "",
        `  ${skill.path}`,
        "",
        skill.body,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  }

  // Bare `/skill <name> [args...]` — inject the body as a user turn.
  // The first arg is the skill name; remaining args are forwarded
  // verbatim as the skill's "Arguments:" line.
  const name = args[0] ?? "";
  const skill = store.read(name);
  if (!skill) {
    return {
      info: `no skill found: ${name}  (try /skill list)`,
    };
  }
  const extra = args.slice(1).join(" ").trim();
  const header = `# Skill: ${skill.name}${skill.description ? `\n> ${skill.description}` : ""}`;
  const argsLine = extra ? `\n\nArguments: ${extra}` : "";
  const payload = `${header}\n\n${skill.body}${argsLine}`;
  return {
    info: `▸ running skill: ${skill.name}${extra ? ` — ${extra}` : ""}`,
    resubmit: payload,
  };
}

/**
 * `/memory` family. Bare `/memory` shows what's pinned (REASONIX.md +
 * both MEMORY.md blocks). Subcommands manage the user-memory store:
 *   list                 — every memory file, both scopes
 *   show <name>          — dump one file's body
 *   show <scope>/<name>  — disambiguate when name exists in both scopes
 *   forget <name>        — delete (same scope resolution as show)
 *   clear <scope> confirm — wipe a scope (typed literal "confirm" required)
 */
function handleMemorySlash(args: string[], ctx: SlashContext): SlashResult {
  if (!memoryEnabled()) {
    return {
      info: "memory is disabled (REASONIX_MEMORY=off in env). Unset the var to re-enable — no REASONIX.md or ~/.reasonix/memory content will be pinned in the meantime.",
    };
  }
  if (!ctx.memoryRoot) {
    return {
      info: "no working directory on this session — `/memory` needs a root to resolve REASONIX.md from. (Running in a test harness?)",
    };
  }
  // `codeRoot` is set only when running `reasonix code`. Chat mode has
  // `memoryRoot` = cwd (for REASONIX.md), but we don't treat cwd as a
  // sandbox — project-scope user memory requires a real code-mode root.
  const store = new MemoryStore({ projectRoot: ctx.codeRoot });
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "list" || sub === "ls") {
    const entries = store.list();
    if (entries.length === 0) {
      return {
        info: "no user memories yet. The model can call `remember` to save one, or you can create files by hand in ~/.reasonix/memory/global/ or the per-project subdir.",
      };
    }
    const lines = [`User memories (${entries.length}):`];
    for (const e of entries) {
      const tag = `${e.scope}/${e.type}`.padEnd(18);
      const name = e.name.padEnd(28);
      const desc = e.description.length > 70 ? `${e.description.slice(0, 69)}…` : e.description;
      lines.push(`  ${tag}  ${name}  ${desc}`);
    }
    lines.push("");
    lines.push("View body: /memory show <name>   Delete: /memory forget <name>");
    return { info: lines.join("\n") };
  }

  if (sub === "show" || sub === "cat") {
    const target = args[1];
    if (!target) return { info: "usage: /memory show <name>  or  /memory show <scope>/<name>" };
    const resolved = resolveMemoryTarget(store, target);
    if (!resolved) return { info: `no memory found: ${target}` };
    try {
      const entry = store.read(resolved.scope, resolved.name);
      return {
        info: [
          `▸ ${entry.scope}/${entry.name}  (${entry.type}, created ${entry.createdAt || "?"})`,
          entry.description ? `  ${entry.description}` : "",
          "",
          entry.body,
        ]
          .filter((l) => l !== "")
          .concat("")
          .join("\n"),
      };
    } catch (err) {
      return { info: `show failed: ${(err as Error).message}` };
    }
  }

  if (sub === "forget" || sub === "rm" || sub === "delete") {
    const target = args[1];
    if (!target) return { info: "usage: /memory forget <name>  or  /memory forget <scope>/<name>" };
    const resolved = resolveMemoryTarget(store, target);
    if (!resolved) return { info: `no memory found: ${target}` };
    try {
      const ok = store.delete(resolved.scope, resolved.name);
      return {
        info: ok
          ? `▸ forgot ${resolved.scope}/${resolved.name}. Next /new or launch won't see it.`
          : `could not forget ${resolved.scope}/${resolved.name} (already gone?)`,
      };
    } catch (err) {
      return { info: `forget failed: ${(err as Error).message}` };
    }
  }

  if (sub === "clear") {
    const rawScope = (args[1] ?? "").toLowerCase();
    if (rawScope !== "global" && rawScope !== "project") {
      return { info: "usage: /memory clear <global|project> confirm" };
    }
    if ((args[2] ?? "").toLowerCase() !== "confirm") {
      return {
        info: `about to delete every memory in scope=${rawScope}. Re-run with the word 'confirm' to proceed: /memory clear ${rawScope} confirm`,
      };
    }
    const scope = rawScope as MemoryScope;
    const entries = store.list().filter((e) => e.scope === scope);
    let deleted = 0;
    for (const e of entries) {
      try {
        if (store.delete(scope, e.name)) deleted++;
      } catch {
        /* skip */
      }
    }
    return { info: `▸ cleared scope=${scope} — deleted ${deleted} memory file(s).` };
  }

  // Bare `/memory` — show REASONIX.md + both MEMORY.md blocks.
  const parts: string[] = [];
  const projMem = readProjectMemory(ctx.memoryRoot);
  if (projMem) {
    const hdr = projMem.truncated
      ? `▸ ${PROJECT_MEMORY_FILE}: ${projMem.path} (${projMem.originalChars.toLocaleString()} chars, truncated)`
      : `▸ ${PROJECT_MEMORY_FILE}: ${projMem.path} (${projMem.originalChars.toLocaleString()} chars)`;
    parts.push(hdr, "", projMem.content);
  }
  const globalIdx = store.loadIndex("global");
  if (globalIdx) {
    parts.push(
      "",
      `▸ global memory (${globalIdx.originalChars.toLocaleString()} chars${globalIdx.truncated ? ", truncated" : ""})`,
      "",
      globalIdx.content,
    );
  }
  const projectIdx = store.loadIndex("project");
  if (projectIdx) {
    parts.push(
      "",
      `▸ project memory (${projectIdx.originalChars.toLocaleString()} chars${projectIdx.truncated ? ", truncated" : ""})`,
      "",
      projectIdx.content,
    );
  }
  if (parts.length === 0) {
    return {
      info: [
        `no memory pinned in ${ctx.memoryRoot}.`,
        "",
        "Three layers are available:",
        `  1. ${PROJECT_MEMORY_FILE} — committable team memory (in the repo).`,
        "  2. ~/.reasonix/memory/global/ — your cross-project private memory.",
        `  3. ~/.reasonix/memory/<project-hash>/ — this project's private memory.`,
        "",
        "Ask the model to `remember` something, or hand-edit files directly.",
        "Changes take effect on next /new or launch — the system prompt is hashed once per session to keep the prefix cache warm.",
        "",
        "Subcommands: /memory list | /memory show <name> | /memory forget <name> | /memory clear <scope> confirm",
      ].join("\n"),
    };
  }
  parts.push(
    "",
    "Changes take effect on next /new or launch. Subcommands: /memory list | show | forget | clear",
  );
  return { info: parts.join("\n") };
}

/**
 * Parse a `/memory show|forget` argument. Accepts bare `<name>` or
 * `<scope>/<name>`. For bare names, tries project scope first (more
 * specific, usually what the user means) then falls back to global.
 */
function resolveMemoryTarget(
  store: MemoryStore,
  raw: string,
): { scope: MemoryScope; name: string } | null {
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const scopeRaw = raw.slice(0, slash).toLowerCase();
    const name = raw.slice(slash + 1);
    if (scopeRaw !== "global" && scopeRaw !== "project") return null;
    const scope = scopeRaw as MemoryScope;
    if (scope === "project" && !store.hasProjectScope()) return null;
    return { scope, name };
  }
  for (const scope of ["project", "global"] as MemoryScope[]) {
    if (scope === "project" && !store.hasProjectScope()) continue;
    try {
      store.read(scope, raw);
      return { scope, name: raw };
    } catch {
      /* next scope */
    }
  }
  return null;
}

/**
 * Render a section (resources / prompts) of an MCP inspection into a
 * compact "name  count  items" form, collapsing when unsupported.
 * Names-only — descriptions and full metadata live in
 * `reasonix mcp inspect`, which is purpose-built for the deep view.
 */
function appendSection(
  lines: string[],
  label: string,
  section:
    | { supported: true; items: Array<{ name: string }> }
    | { supported: false; reason: string }
    | undefined,
): void {
  if (!section || !section.supported) {
    lines.push(
      `  ${label.trim()}    ${section?.supported === false ? "(not supported)" : "(none)"}`,
    );
    return;
  }
  const names = section.items.map((i) => i.name);
  if (names.length === 0) {
    lines.push(`  ${label.trim()}    (none)`);
    return;
  }
  const head = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? ` +${names.length - 5} more` : "";
  lines.push(`  ${label.trim()}    ${names.length}  [${head}${more}]`);
}

function formatToolList(history: Array<{ toolName: string; text: string }>): string {
  const total = history.length;
  const header = `Tool calls in this session (${total}, most recent first):`;
  // Show the 10 most recent. Older ones are rarely what the user
  // wants — and the help footer tells them how to reach any entry
  // by index if they do.
  const shown = Math.min(total, 10);
  const lines: string[] = [header];
  for (let i = 0; i < shown; i++) {
    const entry = history[total - 1 - i];
    if (!entry) continue;
    const idx = i + 1; // 1-based from most recent
    const flat = entry.text.replace(/\s+/g, " ").trim();
    const preview = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
    const name = entry.toolName.length > 24 ? `${entry.toolName.slice(0, 23)}…` : entry.toolName;
    lines.push(
      `  #${String(idx).padStart(2)}  ${name.padEnd(24)}  ${String(entry.text.length).padStart(6)} chars  ${preview}`,
    );
  }
  if (total > shown) {
    lines.push(`  … (${total - shown} earlier, reach with /tool N)`);
  }
  lines.push("");
  lines.push("View full output: /tool N   (N=1 → most recent)");
  return lines.join("\n");
}

/**
 * Binary-K token formatter: 1234 → "1.2K", 131072 → "128K". Matches
 * DeepSeek's doc ("128K context"). Every call site here is rendering
 * token counts — if a future caller wants decimal-K for dollars or
 * similar, add a separate formatter rather than reusing this one.
 */
function compactNum(n: number): string {
  if (n < 1024) return String(n);
  const k = n / 1024;
  return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
}

function stripOuterQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Run `git add -A` then `git commit -m <message>` in `rootDir`. Returns
 * a SlashResult with a human-scannable info line. We surface stderr on
 * failure so the user sees exactly what git complained about (bad
 * config, pre-commit hook rejection, nothing staged, etc.).
 */
function runGitCommit(rootDir: string, message: string): SlashResult {
  const add = spawnSync("git", ["add", "-A"], { cwd: rootDir, encoding: "utf8" });
  if (add.error || add.status !== 0) {
    return { info: `git add failed (${add.status ?? "?"}):\n${gitTail(add)}` };
  }
  const commit = spawnSync("git", ["commit", "-m", message], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (commit.error || commit.status !== 0) {
    return { info: `git commit failed (${commit.status ?? "?"}):\n${gitTail(commit)}` };
  }
  const firstLine = (commit.stdout || "").split(/\r?\n/)[0] ?? "";
  return { info: `▸ committed: ${message}${firstLine ? `\n  ${firstLine}` : ""}` };
}

/**
 * Safely extract whatever diagnostic text is available from a spawnSync
 * result — on Windows or when cwd doesn't exist, `stderr`/`stdout` can
 * be `undefined` and the caller has only `error.message` to go on.
 */
function gitTail(res: ReturnType<typeof spawnSync>): string {
  const stderr = (res.stderr as string | undefined) ?? "";
  const stdout = (res.stdout as string | undefined) ?? "";
  const body = stderr.trim() || stdout.trim();
  if (body) return body;
  if (res.error) return (res.error as Error).message;
  return "(no output from git)";
}
