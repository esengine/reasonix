import type { TranslationSchema } from "./types.js";

export const EN: TranslationSchema = {
  common: {
    error: "Error",
    warning: "Warning",
    loading: "Loading...",
    done: "Done",
    cancel: "Cancel",
    confirm: "Confirm",
    back: "Back",
    next: "Next",
  },
  cli: {
    description: "DeepSeek-native agent framework — built for cache hits and cheap tokens.",
    continue: "Resume the most recently used chat session without showing the picker.",
    setup: "Interactive wizard — API key, preset, MCP servers. Re-run any time to reconfigure.",
    code: "Code-editing chat — filesystem tools rooted at <dir> (default: cwd), coding system prompt, v4-flash baseline.",
    chat: "Interactive Ink TUI with live cache/cost panel.",
    run: "Run a single task non-interactively, streaming output.",
    stats: "Show usage dashboard.",
    doctor: "One-command health check.",
    commit: "Draft a commit message from the staged diff.",
    sessions: "List saved chat sessions, or inspect one by name.",
    events: "Pretty-print the kernel event-log sidecar.",
    replay: "Interactive Ink TUI to scrub through a transcript.",
    diff: "Compare two transcripts in a split-pane Ink TUI.",
    mcp: "Model Context Protocol helpers — discover servers, test your setup.",
    version: "Print Reasonix version.",
    update: "Check for a newer Reasonix and install it.",
    index: "Build (or incrementally refresh) a local semantic search index.",
  },
  ui: {
    welcome: "Run `reasonix` any time to start chatting — your settings are remembered.",
    taglineChat: "DeepSeek-native agent",
    taglineCode: "DeepSeek-native coding agent",
    taglineSub: "cache-first · flash-first",
    startSessionHint: "type a message to start your session",
    inputPlaceholder: "Ask anything... (type / for commands, @ for files)",
    busy: "Thinking...",
    thinking: "▸ thinking...",
    undo: "Undo",
    undoHint: "press u within 5s to undo",
    applied: "applied",
    rejected: "rejected",
    noDashboard: "Suppress the auto-launched embedded web dashboard.",
    dashboardAutoStartFailed:
      "▲ dashboard auto-start failed ({reason}) — try /dashboard, or pass --no-dashboard to silence",
    systemAppendHint:
      "Append instructions to the code system prompt. Does NOT replace the default prompt — adds after it.",
    systemAppendFileHint:
      "Append file contents to the code system prompt. Does NOT replace the default prompt. UTF-8, relative to cwd or absolute.",
    resumedSession:
      '▸ resumed session "{name}" with {count} prior messages · /forget to start over · /sessions to list',
    newSession:
      '▸ session "{name}" (new) — auto-saved as you chat · /forget to delete · /sessions to list',
    ephemeralSession: "▸ ephemeral chat (no session persistence) — drop --no-session to enable",
    restoredEdits:
      "▸ restored {count} pending edit block(s) from an interrupted prior run — /apply to commit or /discard to drop.",
    resumedPlan: "Resumed plan · {when}{summary}",
    tipEditBindings:
      "▸ TIP: edit-gate keybindings\n    y / n       accept or drop pending edits\n    Shift+Tab   switch review ↔ AUTO (persisted; AUTO applies instantly)\n    u           undo the last auto-applied batch (within the 5s banner)\n  Current mode is shown in the bottom status bar. Run /keys anytime for the full list.\n  (This tip shows once — suppressed after.)",
    modelOverride: "override the default model",
    noSession: "disable session persistence for this run",
    resumeHint: "force-resume the named session (even if idle)",
    newHint: "force a fresh session (ignore --session / --continue)",
    transcriptHint: "path to write the JSONL transcript",
    harvestHint: "opt into Pillar-2 plan-state extraction (costs +1 flash call per turn)",
    budgetHint: "session USD cap — warns at 80%, refuses next turn at 100%",
    modelIdHint: "DeepSeek model id (e.g. deepseek-v4-flash)",
    systemPromptHint: "override the default system prompt",
    presetHint: "model bundle — auto|flash|pro",
    harvestOptInHint: "opt into Pillar-2 plan-state extraction",
    branchHint: "run N parallel samples per turn (N>=2, manual only)",
    sessionNameHint: "session name (default: 'default')",
    ephemeralHint: "disable session persistence for this run",
    mcpSpecHint: "MCP server spec (repeatable)",
    mcpPrefixHint: "prefix MCP tool names with this string",
    noConfigHint: "ignore ~/.reasonix/config.json for this run",
    presetHintShort: "model bundle — auto|flash|pro",
    harvestHintShort: "Pillar-2 plan-state extraction",
    branchHintShort: "parallel samples per turn (N>=2)",
    budgetHintShort: "session USD cap",
    transcriptHintShort: "JSONL transcript path",
    mcpSpecHintShort: "MCP server spec (repeatable)",
    mcpPrefixHintShort: "MCP tool name prefix",
    dryRunHint: "show what would be installed without actually installing",
    rebuildHint: "rebuild the index from scratch",
    embedModelHint: "embedding model name",
    projectDirHint: "project root directory",
    ollamaUrlHint: "Ollama server URL",
    skipPromptsHint: "skip confirmation prompts",
    verboseHint: "show full session metadata",
    eventTypeHint: "filter by event type",
    eventSinceHint: "start from this event id",
    eventTailHint: "show only the last N events",
    jsonHint: "output as JSON",
    projectionHint: "show projected state at each event",
    printHint: "print to stdout instead of TUI",
    headHint: "show only the first N events",
    tailHint: "show only the last N events",
    mdReportHint: "write a markdown diff report to this path",
    printHintTable: "print a table to stdout",
    tuiHint: "open the interactive TUI",
    labelAHint: "label for the left pane",
    labelBHint: "label for the right pane",
    mcpListDescription: "list discovered MCP servers and their tools",
    mcpInspectDescription: "inspect an MCP server spec (tools, resources, prompts)",
    jsonHintCatalog: "output the catalog as JSON",
    jsonHintReport: "output the inspection report as JSON",
    modelOverrideFlash: "override the model (default: deepseek-v4-flash)",
    skipConfirmHint: "skip the confirmation prompt",
  },
  slash: {
    help: { description: "show the full command reference" },
    status: { description: "current model, flags, context, session" },
    preset: {
      description: "model bundle — auto escalates flash → pro, flash/pro lock",
      argsHint: "<auto|flash|pro>",
    },
    model: { description: "switch DeepSeek model id", argsHint: "<id>" },
    models: { description: "list available models fetched from DeepSeek /models" },
    language: {
      description: "switch the runtime language",
      argsHint: "<EN|zh-CN>",
      success: "Language switched to English.",
      unsupported: "Unsupported language code: {code}. Supported: {supported}.",
    },
    harvest: { description: "toggle Pillar-2 plan-state extraction", argsHint: "[on|off]" },
    branch: { description: "run N parallel samples per turn (N>=2)", argsHint: "<N|off>" },
    effort: {
      description: "reasoning_effort cap — max is default (agent-class), high is cheaper/faster",
      argsHint: "<high|max>",
    },
    pro: {
      description: "arm v4-pro for the NEXT turn only (one-shot · auto-disarms after turn)",
      argsHint: "[off]",
    },
    budget: {
      description:
        "session USD cap — warns at 80%, refuses next turn at 100%. Off by default. /budget alone shows status",
      argsHint: "[usd|off]",
    },
    mcp: { description: "list MCP servers + tools attached to this session" },
    resource: {
      description: "browse + read MCP resources (no arg → list URIs; <uri> → fetch contents)",
      argsHint: "[uri]",
    },
    prompt: {
      description: "browse + fetch MCP prompts (no arg → list names; <name> → render prompt)",
      argsHint: "[name]",
    },
    tool: { description: "dump full output of the Nth tool call (1=latest)", argsHint: "[N]" },
    memory: {
      description: "show / manage pinned memory (REASONIX.md + ~/.reasonix/memory)",
      argsHint: "[list|show <name>|forget <name>|clear <scope> confirm]",
    },
    skill: {
      description: "list / run user skills (<project>/.reasonix/skills + ~/.reasonix/skills)",
      argsHint: "[list|show <name>|<name> [args]]",
    },
    hooks: {
      description: "list active hooks (settings.json under .reasonix/) · reload re-reads from disk",
      argsHint: "[reload]",
    },
    permissions: {
      description:
        "show / edit shell allowlist (builtin read-only · per-project: ~/.reasonix/config.json)",
      argsHint: "[list|add <prefix>|remove <prefix|N>|clear confirm]",
    },
    dashboard: {
      description: "launch the embedded web dashboard (127.0.0.1, token-gated)",
      argsHint: "[stop]",
    },
    update: { description: "show current vs latest version + the shell command to upgrade" },
    stats: {
      description:
        "cross-session cost dashboard (today / week / month / all-time · cache hit · vs Claude)",
    },
    cost: {
      description:
        "bare → last turn's spend (Usage card); with text → estimate cost of sending it next (worst-case + likely-cache)",
      argsHint: "[text]",
    },
    doctor: { description: "health check (api / config / api-reach / index / hooks / project)" },
    think: { description: "dump the last turn's full R1 reasoning (reasoner only)" },
    context: { description: "show context-window breakdown (system / tools / log / input)" },
    retry: { description: "truncate & resend your last message (fresh sample)" },
    compact: {
      description:
        "shrink oversized tool results AND tool-call args (edit_file search/replace) in the log; cap in tokens, default 4000",
      argsHint: "[tokens]",
    },
    keys: { description: "show all keyboard shortcuts and prompt prefixes" },
    plans: { description: "list this session's active + archived plans, newest first" },
    replay: {
      description: "load an archived plan as a read-only Time Travel snapshot (default: newest)",
      argsHint: "[N]",
    },
    sessions: { description: "list saved sessions (current marked with ▸)" },
    rename: { description: "rename the current session on disk", argsHint: "<new-name>" },
    resume: {
      description: "show the launch command to resume a saved session",
      argsHint: "<name>",
    },
    forget: { description: "delete the current session from disk" },
    "prune-sessions": {
      description: "delete sessions idle ≥N days (default 90) — frees disk on long-time installs",
      argsHint: "[days]",
    },
    setup: { description: "reminds you to exit and run `reasonix setup`" },
    semantic: {
      description: "show semantic_search status — built? Ollama installed? how to enable",
    },
    clear: { description: "clear visible scrollback only (log/context kept)" },
    new: { description: "start a fresh conversation (clear context + scrollback)" },
    loop: {
      description:
        "auto-resubmit <prompt> every <interval> until you type something / Esc / /loop stop",
      argsHint: "<5s..6h> <prompt>  ·  stop  ·  (no args = status)",
    },
    exit: { description: "quit the TUI" },
    init: {
      description:
        "scan the project and synthesize a baseline REASONIX.md (model writes; review with /apply). `force` overwrites an existing file.",
      argsHint: "[force]",
    },
    apply: {
      description:
        "commit pending edit blocks to disk (no arg → all; `1`, `1,3`, or `1-4` → that subset, rest stay pending)",
      argsHint: "[N|N,M|N-M]",
    },
    discard: {
      description: "drop pending edit blocks without writing (no arg → all; indices → that subset)",
      argsHint: "[N|N,M|N-M]",
    },
    walk: {
      description:
        "step through pending edits one block at a time (git-add-p style: y/n per block, a apply rest, A flip AUTO)",
    },
    undo: { description: "roll back the last applied edit batch" },
    history: { description: "list every edit batch this session (ids for /show, undone markers)" },
    show: {
      description: "dump a stored edit diff (omit id for newest non-undone)",
      argsHint: "[id]",
    },
    commit: { description: "git add -A && git commit -m ...", argsHint: '"msg"' },
    checkpoint: {
      description:
        "snapshot every file the session has touched (Cursor-style internal store, not git). /checkpoint alone lists.",
      argsHint: "[name|list|forget <id>]",
    },
    restore: {
      description: "roll back files to a named checkpoint (see /checkpoint list)",
      argsHint: "<name|id>",
    },
    plan: {
      description: "toggle read-only plan mode (writes bounced until submit_plan + approval)",
      argsHint: "[on|off]",
    },
    "apply-plan": {
      description: "force-approve a pending / in-text plan (fallback if picker was missed)",
    },
    mode: {
      description:
        "edit-gate: review (queue) · auto (apply+undo) · yolo (apply+auto-shell). Shift+Tab cycles.",
      argsHint: "[review|auto|yolo]",
    },
    jobs: { description: "list background jobs started by run_background" },
    kill: {
      description: "stop a background job by id (SIGTERM → SIGKILL after grace)",
      argsHint: "<id>",
    },
    logs: {
      description: "tail a background job's output (default last 80 lines)",
      argsHint: "<id> [lines]",
    },
  },
  prompts: {
    defaultSystem:
      "You are Reasonix, a helpful DeepSeek-powered assistant. Be concise and accurate. Use tools when available.\n\n# Cite or shut up — non-negotiable\n\nEvery factual claim about a codebase must be backed by evidence...",
    formattingRules: "Formatting (rendered in a TUI with a real markdown renderer):...",
    escalationContract: "Cost-aware escalation (when you're running on deepseek-v4-flash):...",
    negativeClaimRule:
      'Negative claims ("X is missing", "Y isn\'t implemented", "there\'s no Z") are the #1 hallucination shape...',
    commitSystem:
      "You are an expert software engineer drafting a concise, high-signal git commit message...",
  },
  loop: {
    budgetWarning: "▲ session budget reached 80% ($${used} / $${cap})",
    budgetRefusal:
      "▲ session budget reached 100% ($${used} / $${cap}) — turn refused. Bump or clear via /budget.",
    contextWarning: "▲ context window pressure: {ratio}% ({tokens} / {cap})",
    escalationWarning: "⇧ flash requested escalation — {reason}",
    toolFailure: "▸ tool {name} failed: {reason}",
    interrupted: "▸ turn interrupted by user.",
    loopStopped: "▸ loop stopped (after {count} iter{s}).",
  },
  handlers: {
    basic: {
      clearInfo:
        "▸ terminal cleared (viewport + scrollback). Context (message log) is intact — next turn still sees everything. Use /new to start fresh, or /forget to delete the session entirely.",
      newInfo:
        "▸ new conversation — dropped {count} message(s) from context. Same session, fresh slate.",
      helpTitle: "Commands:",
      helpHelp: "  /help                    this message",
      helpKeys: "  /keys                    keyboard shortcuts + prompt prefixes (!, @, /)",
      helpStatus: "  /status                  show current settings",
      helpPreset: "  /preset <auto|flash|pro> model bundle — see below",
      helpModel: "  /model <id>              deepseek-v4-flash or deepseek-v4-pro",
      helpPro: "  /pro [off]               arm v4-pro for NEXT turn only (one-shot, auto-disarms)",
      helpHarvest:
        "  /harvest [on|off]        Pillar 2: structured plan-state extraction (OPT-IN — costs extra)",
      helpBranch: "  /branch <N|off>          run N parallel samples (N>=2) — MANUAL ONLY, N× cost",
      helpEffort:
        "  /effort <high|max>       reasoning_effort cap (max=full thinking, high=cheaper/faster)",
      helpMcp: "  /mcp                     list MCP servers + tools attached to this session",
      helpResource:
        "  /resource [uri]          browse + read MCP resources (no arg → list URIs; <uri> → fetch)",
      helpPrompt:
        "  /prompt [name]           browse + fetch MCP prompts (no arg → list names; <name> → render)",
      helpSetup: "  /setup                   (exit + reconfigure) → run `reasonix setup`",
      helpCompact:
        "  /compact [tokens]        shrink large tool results in history (default 4000 tokens/result)",
      helpThink:
        "  /think                   dump the most recent turn's full R1 reasoning (reasoner only)",
      helpTool:
        "  /tool [N]                list tool calls (or dump full output of #N, 1=most recent)",
      helpCost:
        "  /cost [text]             bare → last turn's spend; with text → estimate cost of sending it next",
      helpMemory:
        "  /memory [sub]            show pinned memory (REASONIX.md + ~/.reasonix/memory).",
      helpMemorySub:
        "                            subs: list | show <name> | forget <name> | clear <scope> confirm",
      helpSkill:
        "  /skill [sub]             list / run user skills (project/.reasonix/skills + ~/.reasonix/skills).",
      helpSkillSub:
        "                            subs: list | show <name> | <name> [args] (injects skill body as user turn)",
      helpRetry:
        "  /retry                   truncate & resend your last message (fresh sample from the model)",
      helpApply:
        "  /apply [N|1,3|1-4]       (code mode) commit pending edit blocks (no arg → all; index → subset)",
      helpDiscard:
        "  /discard [N|1,3|1-4]     (code mode) drop pending edits (no arg → all; index → subset)",
      helpWalk:
        "  /walk                    (code mode) step through pending edits one block at a time (y/n per block, a apply rest, A flip AUTO)",
      helpUndo: "  /undo                    (code mode) roll back the latest non-undone edit batch",
      helpHistory: "  /history                 (code mode) list every edit batch this session",
      helpShow:
        "  /show [id]               (code mode) dump a stored edit diff (newest when id omitted)",
      helpCommit: '  /commit "msg"            (code mode) git add -A && git commit -m "msg"',
      helpPlan:
        "  /plan [on|off]           (code mode) toggle read-only plan mode; writes gated behind submit_plan + your approval",
      helpApplyPlan:
        "  /apply-plan              (code mode) force-approve pending/in-text plan (fallback)",
      helpMode:
        "  /mode [review|auto|yolo] (code mode) review = queue · auto = apply+undo banner · yolo = apply+auto-shell. Shift+Tab cycles all three.",
      helpJobs:
        "  /jobs                    (code mode) list background processes (run_background) — running and exited",
      helpKill:
        "  /kill <id>               (code mode) stop a background job by id (SIGTERM → SIGKILL)",
      helpLogs:
        "  /logs <id> [lines]       (code mode) tail a background job's output (default 80 lines)",
      helpSessions: "  /sessions                list saved sessions (current is marked with ▸)",
      helpForget: "  /forget                  delete the current session from disk",
      helpNew: "  /new                     start fresh: drop all context + clear scrollback",
      helpClear:
        "  /clear                   clear displayed scrollback only (context kept — model still sees it)",
      helpLoop:
        "  /loop <interval> <prompt> auto-resubmit <prompt> every <interval> (5s..6h). /loop stop · type anything to cancel.",
      helpExit: "  /exit                    quit",
      helpShellTitle: "Shell shortcut:",
      helpShell: "  !<cmd>                   run <cmd> in the sandbox root; output goes into",
      helpShellDetail:
        "                             the conversation so the model sees it next turn.",
      helpShellConsent:
        "                             No allowlist gate — user-typed = explicit consent.",
      helpShellExample: "                             Example: !git status   !ls src/   !npm test",
      helpMemoryTitle: "Quick memory:",
      helpMemoryPin:
        "  #<note>                  append <note> to <project>/REASONIX.md (committable).",
      helpMemoryPinEx:
        "                             Example: #findByEmail must be case-insensitive",
      helpMemoryGlobal:
        "  #g <note>                append <note> to ~/.reasonix/REASONIX.md (global, never committed).",
      helpMemoryGlobalEx: "                             Example: #g always run pnpm not npm",
      helpMemoryPinBoth:
        "                             Both pin into every future session's prefix. Faster than /memory.",
      helpMemoryEscape:
        "                             Use `\\#text` to send a literal `#text` to the model.",
      helpFileTitle: "File references (code mode):",
      helpFile: "  @path/to/file            inline file content under [Referenced files] on send.",
      helpFilePicker:
        "                             Type `@` to open the picker (↑↓ navigate, Tab/Enter pick).",
      helpUrlTitle: "URL references:",
      helpUrl:
        "  @https://example.com     fetch the URL, strip HTML, inline under [Referenced URLs].",
      helpUrlCache:
        "                             Same URL twice in one session fetches once (in-mem cache).",
      helpUrlPunct:
        "                             Trailing sentence punctuation (./,/)) is stripped automatically.",
      helpPresetsTitle: "Presets (branch + harvest are NEVER auto-enabled — opt-in only):",
      helpPresetAuto:
        "  auto   v4-flash → v4-pro on hard turns  ← default · cheap when easy, smart when hard",
      helpPresetFlash:
        "  flash  v4-flash always                  cheapest · predictable per-turn cost",
      helpPresetPro:
        "  pro    v4-pro   always                  ~3× flash (5/31) · hard multi-turn work",
      helpSessionsTitle: "Sessions (auto-enabled by default, named 'default'):",
      helpSessionCustom: "  reasonix chat --session <name>   use a different named session",
      helpSessionNone: "  reasonix chat --no-session       disable persistence for this run",
      helpLimitationTitle: "Known limitation:",
      helpLimitation1: "  Resizing the terminal mid-session may stack ghost header frames in",
      helpLimitation2: "  scrollback (Ink library's live-region clear doesn't account for line",
      helpLimitation3: "  re-wrapping at the new width). Scroll-up history is unaffected; the",
      helpLimitation4: "  artifact is purely visual and clears the next time you /clear.",
      keysTitle: "Keyboard & prompt shortcuts:",
      keysEnter: "  Enter                  submit the current prompt",
      keysNewline: "  Shift+Enter  /  Ctrl+J  insert a newline (multi-line prompt)",
      keysContinue: "  \\<Enter>               bash-style line continuation",
      keysArrow: "  ← → ↑ ↓                move cursor / recall history at buffer boundary",
      keysPage:
        "  PageUp / PageDown      jump to top / bottom of the WHOLE buffer (handy after a big paste)",
      keysHomeEnd: "  Ctrl+A / Ctrl+E        jump to start / end of the CURRENT line",
      keysClearLine: "  Ctrl+U                 clear the entire input buffer",
      keysDeleteWord: "  Ctrl+W                 delete the word before the cursor",
      keysBackspace: "  Backspace              delete left;  Delete   delete under cursor",
      keysEsc: "  Esc                    abort the in-flight turn",
      keysEditYn: "  y / n                  accept / reject pending edits (code mode)",
      keysEditTab:
        "  Shift+Tab              cycle edit gate: review ↔ AUTO (code mode, persists to config)",
      keysEditUndo:
        "  u                      undo the latest non-undone edit batch (session-wide, not just banner)",
      keysPromptTitle: "Prompt prefixes:",
      keysSlash: "  /<name>                slash command; Tab/Enter picks from the suggestion list",
      keysAtFile: "  @<path>                inline a file under [Referenced files] (code mode).",
      keysAtFilePicker:
        "                           Trailing `@…` opens a file picker; ↑/↓ navigate, Tab/Enter pick.",
      keysAtUrl:
        "  @https://...           fetch the URL, strip HTML, inline under [Referenced URLs].",
      keysAtUrlCache:
        "                           Cached per session — same URL twice fetches once.",
      keysBang:
        "  !<cmd>                 run <cmd> as shell in the sandbox root; output goes into context",
      keysBangDetail:
        "                           so the model sees it next turn. No allowlist gate.",
      keysHash:
        "  #<note>                append <note> to <project>/REASONIX.md (committable, team-shared).",
      keysHashGlobal:
        "  #g <note>              append <note> to ~/.reasonix/REASONIX.md (global, never committed).",
      keysHashBoth:
        "                           Both pin into the immutable prefix every future session.",
      keysHashEscape:
        "                           Use `\\#literal` if you actually want a `#` heading sent to the model.",
      keysPickersTitle: "Pickers (slash + @-mention):",
      keysPickerNav: "  ↑ / ↓                  navigate the suggestion list",
      keysPickerTab: "  Tab                    insert the highlighted item without submitting",
      keysPickerEnter: "  Enter                  insert and (slash) run it, (@) keep editing",
      keysMcpTitle: "MCP exploration:",
      keysMcpServers: "  /mcp                   servers + tool/resource/prompt counts",
      keysMcpResource:
        "  /resource [uri]        browse & read resources exposed by your MCP servers",
      keysMcpPrompt: "  /prompt [name]         browse & fetch prompts exposed by your MCP servers",
      keysUseful: "Useful slashes: /help · /context · /stats · /compact · /new · /exit",
      setupInfo:
        "To reconfigure (preset, MCP servers, API key), exit this chat and run `reasonix setup`. Changes take effect on next launch.",
      retryNone: "nothing to retry — no prior user message in this session's log.",
      retryInfo: '▸ retrying: "{preview}"',
      loopTuiOnly: "/loop is only available in the interactive TUI (not in run/replay).",
      loopStopped: "▸ loop stopped.",
      loopNoActive: "no active loop to stop.",
      loopNoActiveHint:
        "no active loop. Start one with `/loop <interval> <prompt>` (e.g. /loop 30s npm test).\nCancels on: /loop stop · Esc · /clear /new · any user-typed prompt.",
      loopStarted:
        '▸ loop started — re-submitting "{prompt}" every {duration}. Type anything (or /loop stop) to cancel.',
    },
    admin: {
      doctorNeedsTui: "/doctor needs a TUI context (postDoctor wired).",
      doctorRunning: "⚕ Doctor — running health checks…",
      hooksReloadUnavailable:
        "/hooks reload is not available in this context (no reload callback wired).",
      hooksReloaded: "▸ reloaded hooks · {count} active",
      hooksUsage:
        "usage: /hooks            list active hooks\n       /hooks reload     re-read settings.json files",
      hooksNone: "no hooks configured.",
      hooksDropHint: "drop a settings.json with a `hooks` key into either of:",
      hooksProject: "  · {path} (project)",
      hooksProjectFallback: "  · <project>/.reasonix/settings.json (project)",
      hooksGlobal: "  · {path} (global)",
      hooksEvents: "events: PreToolUse, PostToolUse, UserPromptSubmit, Stop",
      hooksExitCodes: "exit 0 = pass · exit 2 = block (Pre*) · other = warn",
      hooksLoaded: "▸ {count} hook(s) loaded",
      hooksSources: "sources: project={project} · global={global}",
      updateCurrent: "current: reasonix {version}",
      updateLatestPending: "latest:  (not yet resolved — background check in flight or offline)",
      updateRetryHint: "triggered a fresh registry fetch — retry `/update` in a few seconds,",
      updateRetryHint2: "or run `reasonix update` in another terminal to force it synchronously.",
      updateLatest: "latest:  reasonix {version}",
      updateUpToDate: "you're on the latest. nothing to do.",
      updateNpxHint: "you're running via npx — the next `npx reasonix ...` launch will auto-fetch.",
      updateNpxForce: "to force a refresh sooner: `npm cache clean --force`.",
      updateUpgradeHint: "to upgrade, exit this session and run:",
      updateUpgradeCmd1:
        "  reasonix update           (interactive, dry-run supported via --dry-run)",
      updateUpgradeCmd2: "  npm install -g reasonix@latest   (direct)",
      updateInSessionDisabled: "in-session install is deliberately disabled — the npm spawn would",
      updateInSessionDisabled2:
        "corrupt this TUI's rendering and Windows can lock the running binary.",
      statsNoData: "no usage data yet.",
      statsEveryTurn: "every turn you run here appends one record — this session's turns",
      statsWillAppear: "will show up in the dashboard once you send a message.",
    },
    edits: {
      undoCodeOnly:
        "/undo is only available inside `reasonix code` — chat mode doesn't apply edits.",
      historyCodeOnly: "/history is only available inside `reasonix code`.",
      showCodeOnly: "/show is only available inside `reasonix code`.",
      applyCodeOnly: "/apply is only available inside `reasonix code` (nothing to apply here).",
      discardCodeOnly: "/discard is only available inside `reasonix code`.",
      planCodeOnly:
        "/plan is only available inside `reasonix code` — chat mode doesn't gate tool writes.",
      planOn:
        "▸ plan mode ON — write tools are gated; the model MUST call `submit_plan` before anything executes. (The model can also call submit_plan on its own for big tasks even when plan mode is off — this toggle is the stronger, explicit constraint.) Type /plan off to leave.",
      planOff:
        "▸ plan mode OFF — write tools are live again. Model can still propose plans autonomously for large tasks.",
      applyPlanCodeOnly: "/apply-plan is only available inside `reasonix code`.",
      applyPlanInfo: "▸ plan approved — implementing",
      applyPlanResubmit:
        "The plan above has been approved. Implement it now. You are out of plan mode — use edit_file / write_file / run_command as needed. Stick to the plan unless you discover a concrete reason to deviate; if you do, tell me and wait for a response before making that deviation.",
      modeCodeOnly: "/mode is only available inside `reasonix code`.",
      modeUsage: "usage: /mode <review|auto|yolo>   (Shift+Tab also cycles)",
      modeYolo:
        "▸ edit mode: YOLO — edits AND shell commands auto-run with no prompt. /undo still rolls back edits. Use carefully.",
      modeAuto:
        "▸ edit mode: AUTO — edits apply immediately; press u within 5s to undo, or /undo later. Shell commands still ask.",
      modeReview: "▸ edit mode: review — edits queue for /apply (or y) / /discard (or n)",
      commitCodeOnly: "/commit is only available inside `reasonix code` (needs a rooted git repo).",
      commitUsage:
        'usage: /commit "your commit message"  — runs `git add -A && git commit -m "…"` in {root}',
      walkCodeOnly: "/walk is only available inside `reasonix code`.",
      checkpointCodeOnly:
        "/checkpoint is only available inside `reasonix code` — chat mode doesn't apply edits.",
      checkpointNone:
        "no checkpoints yet — `/checkpoint <name>` snapshots every file the session has touched. Restore later with `/restore <name>`.",
      checkpointHeader: "◈ checkpoints · {count} stored",
      checkpointRestoreHint:
        "  /restore <name|id> · /checkpoint forget <id> · /checkpoint <name> to add",
      checkpointForgetUsage: "usage: /checkpoint forget <id|name>",
      checkpointNoMatch: '▸ no checkpoint matching "{name}" — see /checkpoint list',
      checkpointDeleted: "▸ deleted checkpoint {id} ({name})",
      checkpointDeleteFailed: "▸ failed to delete {id} (already gone?)",
      checkpointSaveUsage: "usage: /checkpoint <name>   (or /checkpoint list to see existing)",
      checkpointSavedEmpty:
        '▸ checkpoint "{name}" saved ({id}) — but no files have been touched yet, so it\'s an empty baseline. Edits made after this point will be revertable.',
      checkpointSaved:
        '▸ checkpoint "{name}" saved ({id}) — {files} file{s}, {size} KB. Restore: /restore {name}',
      restoreCodeOnly: "/restore is only available inside `reasonix code`.",
      restoreUsage: "usage: /restore <name|id>   (see /checkpoint list for ids)",
      restoreNoMatch: '▸ no checkpoint matching "{target}" — try /checkpoint list',
      restoreInfo: '▸ restored "{name}" ({id}) from {when}',
      restoreWrote: "  · wrote back {count} file{s}",
      restoreRemoved: "  · removed {count} file{s} (didn't exist at checkpoint time)",
      restoreSkipped: "  ✗ {count} file{s} skipped:",
    },
    model: {
      modelHint: "try deepseek-v4-flash or deepseek-v4-pro — run /models to fetch the live list",
      modelUsage: "usage: /model <id>   ({hint})",
      modelNotInCatalog:
        "model → {id}   (⚠ not in the fetched catalog: {list}. If this is wrong the next call will 400 — run /models to refresh.)",
      modelSet: "model → {id}",
      modelsFetching:
        "fetching /models from DeepSeek… run /models again in a moment. If it stays empty, your API key may lack permission or the network is blocked.",
      modelsEmpty:
        "DeepSeek /models returned an empty list. Try /models again, or check your account status at api-docs.deepseek.com.",
      modelsHeader: "Available models (DeepSeek /models · {count} total):",
      modelsCurrent: "▸ {id}  (current)",
      modelsSwitch: "Switch with: /model <id>",
      harvestOn:
        "harvest → on  (Pillar-2 plan-state extraction · +1 cheap flash call per turn · opt-in only; no preset turns it on)",
      harvestOff: "harvest → off",
      presetAuto: "preset → auto  (v4-flash → v4-pro on hard turns · default)",
      presetFlash: "preset → flash  (v4-flash always · cheapest · /pro still bumps one turn)",
      presetPro: "preset → pro  (v4-pro always · ~3× flash · for hard multi-turn work)",
      presetUsage: "usage: /preset <auto|flash|pro>",
      branchOff: "branch → off",
      branchUsage: "usage: /branch <N>   (N>=2, or 'off')",
      branchCapped: "branch budget capped at 8 to prevent runaway cost",
      branchSet:
        "branch → {n}  (runs {n} parallel samples per turn · {n}× per-turn cost · streaming disabled · manual only, no preset enables branching)",
      effortStatus:
        "reasoning_effort → {effort}  (use /effort high for cheaper/faster, /effort max for the agent-class default · persisted across relaunches)",
      effortUsage: "usage: /effort <high|max>",
      effortSet: "reasoning_effort → {effort} (persisted)",
      proNothingArmed: "nothing armed — /pro with no args will arm pro for your next turn",
      proDisarmed: "▸ /pro disarmed — next turn falls back to the current preset",
      proUsage:
        "usage: /pro       arm pro for the next turn (one-shot, auto-disarms after)\n       /pro off  cancel armed state before the next turn",
      proArmed:
        "▸ /pro armed — your NEXT message runs on {model} regardless of preset. Auto-disarms after one turn. Use /preset max for a persistent switch.",
      budgetNoCap:
        "no session budget set — Reasonix will keep going until you stop it. Set one with: /budget <usd>   (e.g. /budget 5)",
      budgetStatus:
        "budget: ${spent} of ${cap} ({pct}%) · /budget off to clear, /budget <usd> to change",
      budgetOff: "budget → off (no cap)",
      budgetUsage:
        'usage: /budget <usd>   (got "{arg}" — must be a positive number, e.g. /budget 5 or /budget 12.50)',
      budgetExhausted:
        "▲ budget → ${cap} but already spent ${spent}. Next turn will be refused — bump the cap higher to keep going, or end the session.",
      budgetSet:
        "budget → ${cap}  (so far: ${spent} · warns at 80%, refuses next turn at 100% · /budget off to clear)",
    },
    sessions: {
      forgetNoSession: "not in a session — nothing to forget",
      forgetInfo:
        '▸ deleted session "{name}" — current screen still shows the conversation, but next launch starts fresh',
      forgetFailed: 'could not delete session "{name}" (already gone?)',
      pruneUsage: "▸ usage: /prune-sessions [days]   — defaults to {default}, must be ≥1",
      pruneNone: "▸ nothing to prune — no sessions idle ≥{days} days",
      pruneInfo: "▸ pruned {count} session{s} idle ≥{days} days: {names}",
      renameUsage: "usage: /rename <new-name>",
      renameNoSession: "not in a session — nothing to rename",
      renameFailed:
        'could not rename — "{name}" already exists or sanitises to the same id as the current session',
      renameInfo: '▸ renamed session → "{name}". Restart the TUI to pick it up under its new name.',
      resumeUsage: "usage: /resume <session-name>  — list with /sessions",
      resumeNotFound: 'no session named "{name}" — list with /sessions',
      resumeInfo:
        '▸ to resume "{name}", quit and run: reasonix chat --session {name}\n  (mid-session swap requires a restart so the message log can rewind cleanly)',
    },
    permissions: {
      mutateCodeOnly:
        "/permissions add / remove / clear are only available inside `reasonix code` — they edit the project-scoped allowlist (`~/.reasonix/config.json` projects[<root>].shellAllowed).",
      addUsage:
        'usage: /permissions add <prefix>   (multi-token OK: /permissions add "git push origin")',
      addAlready: "▸ already allowed: {prefix}",
      addBuiltin:
        "▸ `{prefix}` is already in the builtin allowlist — no per-project entry needed. (Builtin entries are always on.)",
      addInfo:
        "▸ added: {prefix}\n  → next `{prefix}` invocation runs without prompting in this project.",
      removeUsage:
        "usage: /permissions remove <prefix-or-index>   (e.g. /permissions remove 3, or /permissions remove npm)",
      removeEmpty: "▸ no project allowlist entries to remove.",
      removeIndexOob: "▸ index out of range: {idx} (project list has {count} entries)",
      removeNothing: "▸ nothing to remove.",
      removeBuiltin:
        "▸ `{prefix}` is in the builtin allowlist (read-only). Builtin entries can't be removed at runtime — they're baked into the binary.",
      removeInfo: "▸ removed: {prefix}",
      removeNotFound:
        "▸ no such project entry: {prefix}   (try /permissions list to see what's stored)",
      clearAlready: "▸ project allowlist is already empty.",
      clearConfirm:
        "about to drop {count} project allowlist entr{plural} for {root}. Re-run with the word 'confirm' to proceed: /permissions clear confirm",
      clearedNone: "▸ project allowlist was already empty — nothing changed.",
      cleared: "▸ cleared {count} project allowlist entr{plural}.",
      usage:
        'usage: /permissions [list]                   show current state\n       /permissions add <prefix>            persist (e.g. "npm run build")\n       /permissions remove <prefix-or-N>    drop one entry\n       /permissions clear confirm           wipe every project entry',
      modeYolo:
        "▸ edit mode: YOLO  — every shell command auto-runs, allowlist is bypassed. /mode review to re-enable prompts.",
      modeAuto:
        "▸ edit mode: auto  — edits auto-apply, shell still gated by allowlist (or ShellConfirm prompt for non-allowlisted).",
      modeReview:
        "▸ edit mode: review — both edits and non-allowlisted shell commands ask before running.",
      projectHeader: "Project allowlist ({count}) — {root}",
      projectNone1: '  (none — pick "always allow" on a ShellConfirm prompt to add one,',
      projectNone2: "   or `/permissions add <prefix>` directly.)",
      projectNoRoot: "Project allowlist — (no project root; chat mode shows builtin entries only)",
      builtinHeader: "Builtin allowlist ({count}) — read-only, baked in",
      subcommands:
        "Subcommands: /permissions add <prefix> · /permissions remove <prefix-or-N> · /permissions clear confirm",
    },
    dashboard: {
      notAvailable:
        "/dashboard is not available in this context (no startDashboard callback wired).",
      stopNoCallback: "/dashboard stop: no stop callback wired.",
      notRunning: "▸ dashboard is not running.",
      stopping: "▸ dashboard stopping…",
      alreadyRunning: "▸ dashboard is already running:",
      alreadyRunningHint: "Open it in any browser. Type `/dashboard stop` to tear it down.",
      ready: "▸ dashboard ready:",
      readyHint: "127.0.0.1 only · token-gated. Type `/dashboard stop` to shut down.",
      failed: "▸ dashboard failed to start: {reason}",
      starting: "▸ starting dashboard server…",
    },
    observability: {
      thinkEmpty:
        "no reasoning cached. `/think` shows the full thinking-mode thought for the most recent turn — only thinking-mode models (deepseek-v4-flash / -v4-pro / -reasoner) produce it, and only once the turn completes.",
      thinkInfo: "↳ full thinking ({count} chars):",
      toolEmpty:
        "no tool calls yet in this session. `/tool` lists them once the model has actually used a tool; `/tool N` dumps the full (untruncated) output of the Nth-most-recent.",
      toolUsage:
        "usage: /tool [N]   (no arg → list; N=1 → most recent result in full, N=2 → previous, …)",
      toolOob:
        "only {count} tool call(s) in history — asked for #{n}. Try /tool with no arg to see the list.",
      toolNotFound: "could not read tool call #{n}",
      toolInfo: "↳ tool<{name}> #{n} ({chars} chars):",
      contextInfo: "context: ~{total} of {max} ({pct}%) · system {sys} · tools {tools} · log {log}",
      compactNone:
        "▸ nothing to compact — no tool result or tool-call args in history exceed {cap} tokens.",
      compactInfo:
        "▸ compacted {count} payload(s) to {cap} tokens each (tool results + tool-call args), saved {tokens} tokens ({chars} chars). Session file rewritten.",
      costNoTurn: "no turn yet — `/cost` shows the most recent turn's token + spend breakdown.",
      costNeedsTui: "/cost needs a TUI context (postUsage wired).",
      costNoPricing:
        '▸ /cost: no pricing table for model "{model}". Add one to telemetry/stats.ts.',
      costEstimate:
        "▸ /cost estimate · {model} · {prompt} prompt tokens (sys {sys} + tools {tools} + log {log} + msg {msg})",
      costWorstCase:
        "  worst case (full miss): {input} input + ~{output} output ({avg} avg) ≈ {total}",
      costLikely: "  likely ({pct}% session cache hit): {input} input + ~{output} output ≈ {total}",
      costLikelyCold: "  likely: matches worst case until cache fills (no completed turns yet)",
      statusModel: "  model   {model}",
      statusFlags:
        "  flags   harvest={harvest} · branch={branch} · stream={stream} · effort={effort}",
      statusCtx: "  ctx     {bar} {used}/{max} ({pct}%)",
      statusCtxNone: "  ctx     no turns yet",
      statusCost: "  cost    ${cost} · cache {bar} {pct}% · turns {turns}",
      statusCostCold: "  cost    ${cost} · turns {turns} (cache warming up)",
      statusBudget: "  budget  ${spent} / ${cap} ({pct}%){tag}",
      statusSession: '  session "{name}" · {count} messages in log (resumed {resumed})',
      statusSessionEphemeral: "  session (ephemeral — no persistence)",
      statusMcp: "  mcp     {servers} server(s), {tools} tool(s) in registry",
      statusEdits: "  edits   {count} pending (/apply to commit, /discard to drop)",
      statusPlan: "  plan    ON — writes gated (submit_plan + approval)",
      statusModeYolo:
        "  mode    YOLO — edits + shell auto-run with no prompt (/undo still rolls back · Shift+Tab to flip)",
      statusModeAuto:
        "  mode    AUTO — edits apply immediately (u to undo within 5s · Shift+Tab to flip)",
      statusModeReview: "  mode    review — edits queue for /apply or y  (Shift+Tab to flip)",
      statusDash: "  dash    {url} (open in browser · /dashboard stop)",
    },
    plans: {
      noSession:
        "no session attached — `/plans` is per-session. Run `reasonix code` in a project to get a session.",
      activePlan: "▸ active plan{label} — {done}/{total} step{s} done · last touched {when}",
      activeNone: "▸ active plan: (none)",
      noArchives:
        "no archived plans yet for this session — they auto-archive when every step is done",
      archivedHeader: "Archived ({count}):",
      replayNoSession:
        "no session attached — `/replay` is per-session. Run `reasonix code` in a project to get a session.",
      replayNoArchives:
        "no archived plans yet for this session — `/replay` lights up once a plan completes (auto-archives when every step is done).",
      replayInvalidIndex:
        "invalid index — `/replay` takes 1..{max} (newest = 1). Use `/plans` to see the list.",
    },
    jobs: {
      codeOnly: "/jobs is only available inside `reasonix code`.",
      killCodeOnly: "/kill is only available inside `reasonix code`.",
      logsCodeOnly: "/logs is only available inside `reasonix code`.",
      empty:
        "◈ jobs · 0 running · 0 total\n  (run_background spawns one — dev servers, watchers, long-running scripts)",
      header: "◈ jobs · {running} running · {total} total",
      footer: "  /logs <id> tail · /kill <id> SIGTERM → SIGKILL",
      killUsage: "usage: /kill <id>   (see /jobs for ids)",
      killNotFound: "job {id}: not found",
      killAlreadyExited: "job {id} already exited ({code})",
      killStopping:
        "▸ stopping job {id} (tree kill: SIGTERM → SIGKILL after 2s grace; Windows: taskkill /T /F)",
      killStatus: "▸ job {id} {status}",
      killStillAlive: "still alive after SIGKILL (!) — report this as a bug",
      logsUsage: "usage: /logs <id> [lines]   (default last 80 lines)",
      logsNotFound: "job {id}: not found",
      logsStatus: "[job {id} · {status}]\n$ {command}",
      logsRunning: "running · pid {pid}",
      logsExited: "exited {code}",
      logsFailed: "failed ({reason})",
      logsStopped: "stopped",
    },
    memory: {
      disabled:
        "memory is disabled (REASONIX_MEMORY=off in env). Unset the var to re-enable — no REASONIX.md or ~/.reasonix/memory content will be pinned in the meantime.",
      noRoot:
        "no working directory on this session — `/memory` needs a root to resolve REASONIX.md from. (Running in a test harness?)",
      listEmpty:
        "no user memories yet. The model can call `remember` to save one, or you can create files by hand in ~/.reasonix/memory/global/ or the per-project subdir.",
      listHeader: "User memories ({count}):",
      listFooter: "View body: /memory show <name>   Delete: /memory forget <name>",
      showUsage: "usage: /memory show <name>  or  /memory show <scope>/<name>",
      showNotFound: "no memory found: {target}",
      showFailed: "show failed: {reason}",
      forgetUsage: "usage: /memory forget <name>  or  /memory forget <scope>/<name>",
      forgetNotFound: "no memory found: {target}",
      forgetInfo: "▸ forgot {scope}/{name}. Next /new or launch won't see it.",
      forgetFailed: "could not forget {scope}/{name} (already gone?)",
      forgetError: "forget failed: {reason}",
      clearUsage: "usage: /memory clear <global|project> confirm",
      clearConfirm:
        "about to delete every memory in scope={scope}. Re-run with the word 'confirm' to proceed: /memory clear {scope} confirm",
      cleared: "▸ cleared scope={scope} — deleted {count} memory file(s).",
      noMemory: "no memory pinned in {root}.",
      layers: "Three layers are available:",
      layerProject: "  1. {file} — committable team memory (in the repo).",
      layerGlobal: "  2. ~/.reasonix/memory/global/ — your cross-project private memory.",
      layerProjectHash: "  3. ~/.reasonix/memory/<project-hash>/ — this project's private memory.",
      askModel: "Ask the model to `remember` something, or hand-edit files directly.",
      changesNote:
        "Changes take effect on next /new or launch — the system prompt is hashed once per session to keep the prefix cache warm.",
      subcommands:
        "Subcommands: /memory list | /memory show <name> | /memory forget <name> | /memory clear <scope> confirm",
      changesNoteShort:
        "Changes take effect on next /new or launch. Subcommands: /memory list | show | forget | clear",
    },
    mcp: {
      noServers:
        'no MCP servers attached. Run `reasonix setup` to pick some, or launch with --mcp "<spec>". `reasonix mcp list` shows the catalog.',
      toolsLabel: "  tools     {count}",
      resourcesHint: "`/resource` to browse+read",
      promptsHint: "`/prompt` to browse+fetch",
      awarenessOnly:
        "Chat mode consumes tools today; resources+prompts are surfaced here for awareness.",
      catalogHint:
        "Full catalog: `reasonix mcp list` · deeper diagnosis: `reasonix mcp inspect <spec>`.",
      fallbackServers: "MCP servers ({count}):",
      fallbackTools: "Tools in registry ({count}):",
      fallbackChange: "To change this set, exit and run `reasonix setup`.",
    },
    init: {
      codeOnly:
        "/init only works in code mode (it needs filesystem tools).\nRun `reasonix code [path]` to start a session rooted at the\nproject you want to initialize, then run /init.",
      exists: "▸ REASONIX.md already exists at {path}",
      existsForce: "  /init force   regenerate from scratch (overwrites)",
      existsEdit: "  Or edit it by hand — it's just markdown. The current file is",
      existsPinned: "  pinned into the system prompt every launch as-is.",
      info: "▸ /init — model will scan the project and synthesize REASONIX.md.\n  The result lands as a pending edit; review with /apply or /walk.",
    },
    skill: {
      listEmpty: "no skills found. Reasonix reads skills from:",
      listProjectScope:
        "  · <project>/.reasonix/skills/<name>/SKILL.md  (or <name>.md)  — project scope",
      listGlobalScope: "  · ~/.reasonix/skills/<name>/SKILL.md  (or <name>.md)  — global scope",
      listProjectOnly: "  (project scope is only active in `reasonix code`)",
      listFrontmatter: "Each file's frontmatter needs at least `name` and `description`.",
      listInvoke:
        "Invoke a skill with `/skill <name> [args]` or by asking the model to call `run_skill`.",
      listHeader: "User skills ({count}):",
      listFooter: "View body: /skill show <name>   Run: /skill <name> [args]",
      showUsage: "usage: /skill show <name>",
      showNotFound: "no skill found: {name}",
      runNotFound: "no skill found: {name}  (try /skill list)",
      runInfo: "▸ running skill: {name}{args}",
    },
  },
};
