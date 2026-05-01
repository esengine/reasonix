import { formatDuration, formatLoopStatus, parseLoopCommand } from "../../loop.js";
import type { SlashHandler } from "../dispatch.js";

const exit: SlashHandler = () => ({ exit: true });

const clear: SlashHandler = () => ({
  clear: true,
  info: "▸ terminal cleared (viewport + scrollback). Context (message log) is intact — next turn still sees everything. Use /new to start fresh, or /forget to delete the session entirely.",
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
    "  ← → ↑ ↓                move cursor / recall history at buffer boundary",
    "  PageUp / PageDown      jump to top / bottom of the WHOLE buffer (handy after a big paste)",
    "  Ctrl+A / Ctrl+E        jump to start / end of the CURRENT line",
    "  Ctrl+U                 clear the entire input buffer",
    "  Ctrl+W                 delete the word before the cursor",
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
    "  @https://...           fetch the URL, strip HTML, inline under [Referenced URLs].",
    "                           Cached per session — same URL twice fetches once.",
    "  !<cmd>                 run <cmd> as shell in the sandbox root; output goes into context",
    "                           so the model sees it next turn. No allowlist gate.",
    "  #<note>                append <note> to <project>/REASONIX.md (committable, team-shared).",
    "  #g <note>              append <note> to ~/.reasonix/REASONIX.md (global, never committed).",
    "                           Both pin into the immutable prefix every future session.",
    "                           Use `\\#literal` if you actually want a `#` heading sent to the model.",
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
    "  /preset <auto|flash|pro> model bundle — see below",
    "  /model <id>              deepseek-v4-flash or deepseek-v4-pro",
    "  /pro [off]               arm v4-pro for NEXT turn only (one-shot, auto-disarms)",
    "  /harvest [on|off]        Pillar 2: structured plan-state extraction (OPT-IN — costs extra)",
    "  /branch <N|off>          run N parallel samples (N>=2) — MANUAL ONLY, N× cost",
    "  /effort <high|max>       reasoning_effort cap (max=full thinking, high=cheaper/faster)",
    "  /mcp                     list MCP servers + tools attached to this session",
    "  /resource [uri]          browse + read MCP resources (no arg → list URIs; <uri> → fetch)",
    "  /prompt [name]           browse + fetch MCP prompts (no arg → list names; <name> → render)",
    "  /setup                   (exit + reconfigure) → run `reasonix setup`",
    "  /compact [tokens]        shrink large tool results in history (default 4000 tokens/result)",
    "  /think                   dump the most recent turn's full R1 reasoning (reasoner only)",
    "  /tool [N]                list tool calls (or dump full output of #N, 1=most recent)",
    "  /cost [text]             bare → last turn's spend; with text → estimate cost of sending it next",
    "  /memory [sub]            show pinned memory (REASONIX.md + ~/.reasonix/memory).",
    "                            subs: list | show <name> | forget <name> | clear <scope> confirm",
    "  /skill [sub]             list / run user skills (project/.reasonix/skills + ~/.reasonix/skills).",
    "                            subs: list | show <name> | <name> [args] (injects skill body as user turn)",
    "  /retry                   truncate & resend your last message (fresh sample from the model)",
    "  /apply [N|1,3|1-4]       (code mode) commit pending edit blocks (no arg → all; index → subset)",
    "  /discard [N|1,3|1-4]     (code mode) drop pending edits (no arg → all; index → subset)",
    "  /walk                    (code mode) step through pending edits one block at a time (y/n per block, a apply rest, A flip AUTO)",
    "  /undo                    (code mode) roll back the latest non-undone edit batch",
    "  /history                 (code mode) list every edit batch this session",
    "  /show [id]               (code mode) dump a stored edit diff (newest when id omitted)",
    '  /commit "msg"            (code mode) git add -A && git commit -m "msg"',
    "  /plan [on|off]           (code mode) toggle read-only plan mode; writes gated behind submit_plan + your approval",
    "  /apply-plan              (code mode) force-approve pending/in-text plan (fallback)",
    "  /mode [review|auto|yolo] (code mode) review = queue · auto = apply+undo banner · yolo = apply+auto-shell. Shift+Tab cycles all three.",
    "  /jobs                    (code mode) list background processes (run_background) — running and exited",
    "  /kill <id>               (code mode) stop a background job by id (SIGTERM → SIGKILL)",
    "  /logs <id> [lines]       (code mode) tail a background job's output (default 80 lines)",
    "  /sessions                list saved sessions (current is marked with ▸)",
    "  /forget                  delete the current session from disk",
    "  /new                     start fresh: drop all context + clear scrollback",
    "  /clear                   clear displayed scrollback only (context kept — model still sees it)",
    "  /loop <interval> <prompt> auto-resubmit <prompt> every <interval> (5s..6h). /loop stop · type anything to cancel.",
    "  /exit                    quit",
    "",
    "Shell shortcut:",
    "  !<cmd>                   run <cmd> in the sandbox root; output goes into",
    "                             the conversation so the model sees it next turn.",
    "                             No allowlist gate — user-typed = explicit consent.",
    "                             Example: !git status   !ls src/   !npm test",
    "",
    "Quick memory:",
    "  #<note>                  append <note> to <project>/REASONIX.md (committable).",
    "                             Example: #findByEmail must be case-insensitive",
    "  #g <note>                append <note> to ~/.reasonix/REASONIX.md (global, never committed).",
    "                             Example: #g always run pnpm not npm",
    "                             Both pin into every future session's prefix. Faster than /memory.",
    "                             Use `\\#text` to send a literal `#text` to the model.",
    "",
    "File references (code mode):",
    "  @path/to/file            inline file content under [Referenced files] on send.",
    "                             Type `@` to open the picker (↑↓ navigate, Tab/Enter pick).",
    "",
    "URL references:",
    "  @https://example.com     fetch the URL, strip HTML, inline under [Referenced URLs].",
    "                             Same URL twice in one session fetches once (in-mem cache).",
    "                             Trailing sentence punctuation (./,/)) is stripped automatically.",
    "",
    "Presets (branch + harvest are NEVER auto-enabled — opt-in only):",
    "  auto   v4-flash → v4-pro on hard turns  ← default · cheap when easy, smart when hard",
    "  flash  v4-flash always                  cheapest · predictable per-turn cost",
    "  pro    v4-pro   always                  ~3× flash (5/31) · hard multi-turn work",
    "",
    "Sessions (auto-enabled by default, named 'default'):",
    "  reasonix chat --session <name>   use a different named session",
    "  reasonix chat --no-session       disable persistence for this run",
    "",
    "Known limitation:",
    "  Resizing the terminal mid-session may stack ghost header frames in",
    "  scrollback (Ink library's live-region clear doesn't account for line",
    "  re-wrapping at the new width). Scroll-up history is unaffected; the",
    "  artifact is purely visual and clears the next time you /clear.",
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

const loop: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.startLoop || !ctx.stopLoop || !ctx.getLoopStatus) {
    return {
      info: "/loop is only available in the interactive TUI (not in run/replay).",
    };
  }
  const cmd = parseLoopCommand(args);
  if (cmd.kind === "error") return { info: cmd.message };
  if (cmd.kind === "stop") {
    const wasActive = ctx.getLoopStatus() !== null;
    ctx.stopLoop();
    return {
      info: wasActive ? "▸ loop stopped." : "no active loop to stop.",
    };
  }
  if (cmd.kind === "status") {
    const status = ctx.getLoopStatus();
    if (!status) {
      return {
        info:
          "no active loop. Start one with `/loop <interval> <prompt>` (e.g. /loop 30s npm test).\n" +
          "Cancels on: /loop stop · Esc · /clear · /new · any user-typed prompt.",
      };
    }
    return { info: `▸ ${formatLoopStatus(status.prompt, status.nextFireMs, status.iter)}` };
  }
  // kind === "start"
  ctx.startLoop(cmd.intervalMs, cmd.prompt);
  return {
    info: `▸ loop started — re-submitting "${cmd.prompt}" every ${formatDuration(
      cmd.intervalMs,
    )}. Type anything (or /loop stop) to cancel.`,
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
  loop,
};
