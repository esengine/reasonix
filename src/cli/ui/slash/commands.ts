import type { SlashArgContext, SlashCommandSpec } from "./types.js";

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { cmd: "help", summary: "show the full command reference" },
  { cmd: "status", summary: "current model, flags, context, session" },
  {
    cmd: "preset",
    argsHint: "<auto|flash|pro>",
    summary: "model bundle — auto escalates flash → pro, flash/pro lock",
    argCompleter: ["auto", "flash", "pro"],
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
  {
    cmd: "effort",
    argsHint: "<high|max>",
    summary: "reasoning_effort cap — max is default (agent-class), high is cheaper/faster",
    argCompleter: ["max", "high"],
  },
  {
    cmd: "pro",
    argsHint: "[off]",
    summary: "arm v4-pro for the NEXT turn only (one-shot · auto-disarms after turn)",
    argCompleter: ["off"],
  },
  {
    cmd: "budget",
    argsHint: "[usd|off]",
    summary:
      "session USD cap — warns at 80%, refuses next turn at 100%. Off by default. /budget alone shows status",
    argCompleter: ["off", "1", "5", "10", "20", "50"],
  },
  {
    cmd: "language",
    argsHint: "<EN|zh-CN>",
    summary: "switch the runtime language",
    argCompleter: ["EN", "zh-CN"],
  },
  { cmd: "mcp", summary: "list MCP servers + tools attached to this session" },
  {
    cmd: "resource",
    argsHint: "[uri]",
    summary: "browse + read MCP resources (no arg → list URIs; <uri> → fetch contents)",
    argCompleter: "mcp-resources",
  },
  {
    cmd: "prompt",
    argsHint: "[name]",
    summary: "browse + fetch MCP prompts (no arg → list names; <name> → render prompt)",
    argCompleter: "mcp-prompts",
  },
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
    cmd: "permissions",
    argsHint: "[list|add <prefix>|remove <prefix|N>|clear confirm]",
    summary:
      "show / edit shell allowlist (builtin read-only · per-project: ~/.reasonix/config.json)",
    argCompleter: ["list", "add", "remove", "clear"],
  },
  {
    cmd: "dashboard",
    argsHint: "[stop]",
    summary: "launch the embedded web dashboard (127.0.0.1, token-gated)",
    argCompleter: ["stop"],
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
  {
    cmd: "cost",
    argsHint: "[text]",
    summary:
      "bare → last turn's spend (Usage card); with text → estimate cost of sending it next (worst-case + likely-cache)",
  },
  { cmd: "doctor", summary: "health check (api / config / api-reach / index / hooks / project)" },
  { cmd: "think", summary: "dump the last turn's full R1 reasoning (reasoner only)" },
  {
    cmd: "context",
    summary: "show context-window breakdown (system / tools / log / input)",
  },
  { cmd: "retry", summary: "truncate & resend your last message (fresh sample)" },
  {
    cmd: "compact",
    argsHint: "[tokens]",
    summary:
      "shrink oversized tool results AND tool-call args (edit_file search/replace) in the log; cap in tokens, default 4000",
  },
  { cmd: "keys", summary: "show all keyboard shortcuts and prompt prefixes" },
  { cmd: "plans", summary: "list this session's active + archived plans, newest first" },
  {
    cmd: "replay",
    summary: "load an archived plan as a read-only Time Travel snapshot (default: newest)",
    argsHint: "[N]",
  },
  { cmd: "sessions", summary: "list saved sessions (current marked with ▸)" },
  { cmd: "rename", argsHint: "<new-name>", summary: "rename the current session on disk" },
  {
    cmd: "resume",
    argsHint: "<name>",
    summary: "show the launch command to resume a saved session",
  },
  { cmd: "forget", summary: "delete the current session from disk" },
  {
    cmd: "prune-sessions",
    summary: "delete sessions idle ≥N days (default 90) — frees disk on long-time installs",
    argsHint: "[days]",
  },
  { cmd: "setup", summary: "reminds you to exit and run `reasonix setup`" },
  {
    cmd: "semantic",
    summary: "show semantic_search status — built? Ollama installed? how to enable",
  },
  { cmd: "clear", summary: "clear visible scrollback only (log/context kept)" },
  { cmd: "new", summary: "start a fresh conversation (clear context + scrollback)" },
  {
    cmd: "loop",
    argsHint: "<5s..6h> <prompt>  ·  stop  ·  (no args = status)",
    summary: "auto-resubmit <prompt> every <interval> until you type something / Esc / /loop stop",
  },
  { cmd: "exit", summary: "quit the TUI" },
  // Code-mode only
  {
    cmd: "init",
    argsHint: "[force]",
    summary:
      "scan the project and synthesize a baseline REASONIX.md (model writes; review with /apply). `force` overwrites an existing file.",
    contextual: "code",
    argCompleter: ["force"],
  },
  {
    cmd: "apply",
    argsHint: "[N|N,M|N-M]",
    summary:
      "commit pending edit blocks to disk (no arg → all; `1`, `1,3`, or `1-4` → that subset, rest stay pending)",
    contextual: "code",
  },
  {
    cmd: "discard",
    argsHint: "[N|N,M|N-M]",
    summary: "drop pending edit blocks without writing (no arg → all; indices → that subset)",
    contextual: "code",
  },
  {
    cmd: "walk",
    summary:
      "step through pending edits one block at a time (git-add-p style: y/n per block, a apply rest, A flip AUTO)",
    contextual: "code",
  },
  { cmd: "undo", summary: "roll back the last applied edit batch", contextual: "code" },
  {
    cmd: "history",
    summary: "list every edit batch this session (ids for /show, undone markers)",
    contextual: "code",
  },
  {
    cmd: "show",
    argsHint: "[id]",
    summary: "dump a stored edit diff (omit id for newest non-undone)",
    contextual: "code",
  },
  {
    cmd: "commit",
    argsHint: '"msg"',
    summary: "git add -A && git commit -m ...",
    contextual: "code",
  },
  {
    cmd: "checkpoint",
    argsHint: "[name|list|forget <id>]",
    summary:
      "snapshot every file the session has touched (Cursor-style internal store, not git). /checkpoint alone lists.",
    contextual: "code",
    argCompleter: ["list", "forget"],
  },
  {
    cmd: "restore",
    argsHint: "<name|id>",
    summary: "roll back files to a named checkpoint (see /checkpoint list)",
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
  {
    cmd: "mode",
    argsHint: "[review|auto|yolo]",
    summary:
      "edit-gate: review (queue) · auto (apply+undo) · yolo (apply+auto-shell). Shift+Tab cycles.",
    contextual: "code",
    argCompleter: ["review", "auto", "yolo"],
  },
  { cmd: "jobs", summary: "list background jobs started by run_background", contextual: "code" },
  {
    cmd: "kill",
    argsHint: "<id>",
    summary: "stop a background job by id (SIGTERM → SIGKILL after grace)",
    contextual: "code",
  },
  {
    cmd: "logs",
    argsHint: "<id> [lines]",
    summary: "tail a background job's output (default last 80 lines)",
    contextual: "code",
  },
];

export function suggestSlashCommands(prefix: string, codeMode = false): SlashCommandSpec[] {
  const p = prefix.toLowerCase();
  return SLASH_COMMANDS.filter((c) => {
    if (c.contextual === "code" && !codeMode) return false;
    return c.cmd.startsWith(p);
  });
}

/** Picker fires only when arg tail has no internal whitespace; past that it's a usage hint. */
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
