import type { SlashHandler } from "../dispatch.js";

const exit: SlashHandler = () => ({ exit: true });

const clear: SlashHandler = () => ({
  clear: true,
  info: "▸ cleared visible scrollback only. Context (message log) is intact — next turn still sees everything. Use /new to start fresh, or /forget to delete the session entirely.",
});

const resetLog: SlashHandler = (_args, loop) => {
  // Actually drop the in-memory log + rewrite the session file so the
  // NEXT call has no prior context. Keeps session name, model, and
  // other config — just the conversation is reset.
  const { dropped } = loop.clearLog();
  return {
    clear: true,
    info: `▸ new conversation — dropped ${dropped} message(s) from context. Same session, fresh slate.`,
  };
};

const keys: SlashHandler = () => ({
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
    "  Shift+Tab              cycle edit gate: review ↔ AUTO (code mode, persists to config)",
    "  u                      undo the latest non-undone edit batch (session-wide, not just banner)",
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
    "MCP exploration:",
    "  /mcp                   servers + tool/resource/prompt counts",
    "  /resource [uri]        browse & read resources exposed by your MCP servers",
    "  /prompt [name]         browse & fetch prompts exposed by your MCP servers",
    "",
    "Useful slashes: /help · /context · /stats · /compact · /new · /exit",
  ].join("\n"),
});

const help: SlashHandler = () => ({
  info: [
    "Commands:",
    "  /help                    this message",
    "  /keys                    keyboard shortcuts + prompt prefixes (!, @, /)",
    "  /status                  show current settings",
    "  /preset <fast|smart|max> one-tap presets — see below",
    "  /model <id>              deepseek-chat or deepseek-reasoner",
    "  /harvest [on|off]        Pillar 2: structured plan-state extraction",
    "  /branch <N|off>          run N parallel samples (N>=2), pick most confident",
    "  /effort <high|max>       reasoning_effort cap (max=agent default, high=cheaper)",
    "  /mcp                     list MCP servers + tools attached to this session",
    "  /resource [uri]          browse + read MCP resources (no arg → list URIs; <uri> → fetch)",
    "  /prompt [name]           browse + fetch MCP prompts (no arg → list names; <name> → render)",
    "  /setup                   (exit + reconfigure) → run `reasonix setup`",
    "  /compact [tokens]        shrink large tool results in history (default 4000 tokens/result)",
    "  /think                   dump the most recent turn's full R1 reasoning (reasoner only)",
    "  /tool [N]                list tool calls (or dump full output of #N, 1=most recent)",
    "  /memory [sub]            show pinned memory (REASONIX.md + ~/.reasonix/memory).",
    "                            subs: list | show <name> | forget <name> | clear <scope> confirm",
    "  /skill [sub]             list / run user skills (project/.reasonix/skills + ~/.reasonix/skills).",
    "                            subs: list | show <name> | <name> [args] (injects skill body as user turn)",
    "  /retry                   truncate & resend your last message (fresh sample from the model)",
    "  /apply                   (code mode) commit the pending edit blocks to disk",
    "  /discard                 (code mode) drop pending edits without writing",
    "  /undo                    (code mode) roll back the latest non-undone edit batch",
    "  /history                 (code mode) list every edit batch this session",
    "  /show [id]               (code mode) dump a stored edit diff (newest when id omitted)",
    '  /commit "msg"            (code mode) git add -A && git commit -m "msg"',
    "  /plan [on|off]           (code mode) toggle read-only plan mode; writes gated behind submit_plan + your approval",
    "  /apply-plan              (code mode) force-approve pending/in-text plan (fallback)",
    "  /mode [review|auto]      (code mode) edit-gate: queue edits for /apply or apply instantly (Shift+Tab cycles, u undoes within 5s)",
    "  /jobs                    (code mode) list background processes (run_background) — running and exited",
    "  /kill <id>               (code mode) stop a background job by id (SIGTERM → SIGKILL)",
    "  /logs <id> [lines]       (code mode) tail a background job's output (default 80 lines)",
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
});

const setup: SlashHandler = () => ({
  info:
    "To reconfigure (preset, MCP servers, API key), exit this chat and run " +
    "`reasonix setup`. Changes take effect on next launch.",
});

const retry: SlashHandler = (_args, loop) => {
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
};

export const handlers: Record<string, SlashHandler> = {
  exit,
  quit: exit,
  clear,
  new: resetLog,
  reset: resetLog,
  keys,
  help,
  "?": help,
  setup,
  retry,
};
