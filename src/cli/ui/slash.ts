import { spawnSync } from "node:child_process";
import type { CacheFirstLoop } from "../../loop.js";
import type { InspectionReport } from "../../mcp/inspect.js";
import { deleteSession, listSessions } from "../../session.js";
import { DEEPSEEK_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS } from "../../telemetry.js";

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
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { cmd: "help", summary: "show the full command reference" },
  { cmd: "status", summary: "current model, flags, context, session" },
  {
    cmd: "preset",
    argsHint: "<fast|smart|max>",
    summary: "one-tap model + harvest + branch bundle",
  },
  { cmd: "model", argsHint: "<id>", summary: "switch DeepSeek model id" },
  { cmd: "harvest", argsHint: "[on|off]", summary: "toggle Pillar-2 plan-state extraction" },
  { cmd: "branch", argsHint: "<N|off>", summary: "run N parallel samples per turn (N>=2)" },
  { cmd: "mcp", summary: "list MCP servers + tools attached to this session" },
  { cmd: "tool", argsHint: "[N]", summary: "dump full output of the Nth tool call (1=latest)" },
  { cmd: "think", summary: "dump the last turn's full R1 reasoning (reasoner only)" },
  { cmd: "retry", summary: "truncate & resend your last message (fresh sample)" },
  { cmd: "compact", argsHint: "[cap]", summary: "shrink oversized tool results in the log" },
  { cmd: "sessions", summary: "list saved sessions (current marked with ▸)" },
  { cmd: "forget", summary: "delete the current session from disk" },
  { cmd: "setup", summary: "reminds you to exit and run `reasonix setup`" },
  { cmd: "clear", summary: "clear visible scrollback only (log/context kept)" },
  { cmd: "new", summary: "start a fresh conversation (clear context + scrollback)" },
  { cmd: "exit", summary: "quit the TUI" },
  // Code-mode only
  { cmd: "apply", summary: "commit pending edit blocks to disk", contextual: "code" },
  { cmd: "discard", summary: "drop pending edit blocks without writing", contextual: "code" },
  { cmd: "undo", summary: "roll back the last applied edit batch", contextual: "code" },
  {
    cmd: "commit",
    argsHint: '"msg"',
    summary: "git add -A && git commit -m ...",
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

    case "help":
    case "?":
      return {
        info: [
          "Commands:",
          "  /help                    this message",
          "  /status                  show current settings",
          "  /preset <fast|smart|max> one-tap presets — see below",
          "  /model <id>              deepseek-chat or deepseek-reasoner",
          "  /harvest [on|off]        Pillar 2: structured plan-state extraction",
          "  /branch <N|off>          run N parallel samples (N>=2), pick most confident",
          "  /mcp                     list MCP servers + tools attached to this session",
          "  /setup                   (exit + reconfigure) → run `reasonix setup`",
          "  /compact [cap]           shrink large tool results in history (default 4k/result)",
          "  /think                   dump the most recent turn's full R1 reasoning (reasoner only)",
          "  /tool [N]                list tool calls (or dump full output of #N, 1=most recent)",
          "  /retry                   truncate & resend your last message (fresh sample from the model)",
          "  /apply                   (code mode) commit the pending edit blocks to disk",
          "  /discard                 (code mode) drop pending edits without writing",
          "  /undo                    (code mode) roll back the last applied edit batch",
          '  /commit "msg"            (code mode) git add -A && git commit -m "msg"',
          "  /sessions                list saved sessions (current is marked with ▸)",
          "  /forget                  delete the current session from disk",
          "  /new                     start fresh: drop all context + clear scrollback",
          "  /clear                   clear displayed scrollback only (context kept — model still sees it)",
          "  /exit                    quit",
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
      // Manual companion to the automatic heal-on-load. Re-applies
      // truncation with a tighter cap (4k chars per tool result) and
      // rewrites the session file so the shrink persists. Useful when
      // the ctx gauge in StatsPanel goes yellow/red mid-session and
      // the user wants to keep chatting without /forget'ing everything.
      const tight = Number.parseInt(args[0] ?? "", 10);
      const cap = Number.isFinite(tight) && tight >= 500 ? tight : 4000;
      const { healedCount, charsSaved } = loop.compact(cap);
      if (healedCount === 0) {
        return {
          info: `▸ nothing to compact — no tool result in history exceeds ${cap.toLocaleString()} chars.`,
        };
      }
      return {
        info: `▸ compacted ${healedCount} tool result(s), saved ${charsSaved.toLocaleString()} chars (~${Math.round(charsSaved / 4).toLocaleString()} tokens). Session file rewritten.`,
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
      const lines = [
        `  model   ${loop.model}`,
        `  flags   harvest=${loop.harvestEnabled ? "on" : "off"} · branch=${branchBudget > 1 ? branchBudget : "off"} · stream=${loop.stream ? "on" : "off"}`,
        ctxLine,
        mcpLine,
        sessionLine,
      ];
      if (pendingLine) lines.push(pendingLine);
      return { info: lines.join("\n") };
    }

    case "model": {
      const id = args[0];
      if (!id) return { info: "usage: /model <id>   (try deepseek-chat or deepseek-reasoner)" };
      loop.configure({ model: id });
      return { info: `model → ${id}` };
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

function compactNum(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
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
