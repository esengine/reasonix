import { render } from "ink";
import React, { useState } from "react";
import { loadApiKey, readConfig, searchEnabled } from "../../config.js";
import { loadDotenv } from "../../env.js";
import { McpClient } from "../../mcp/client.js";
import { type InspectionReport, inspectMcpServer } from "../../mcp/inspect.js";
import { bridgeMcpTools } from "../../mcp/registry.js";
import { parseMcpSpec } from "../../mcp/spec.js";
import { SseTransport } from "../../mcp/sse.js";
import { type McpTransport, StdioTransport } from "../../mcp/stdio.js";
import { StreamableHttpTransport } from "../../mcp/streamable-http.js";
import {
  deleteSession,
  listSessionsForWorkspace,
  renameSession,
  resolveSession,
} from "../../memory/session.js";
import { ToolRegistry } from "../../tools.js";
import { registerChoiceTool } from "../../tools/choice.js";
import { registerMemoryTools } from "../../tools/memory.js";
import { registerWebTools } from "../../tools/web.js";
import { App } from "../ui/App.js";
import { SessionPicker } from "../ui/SessionPicker.js";
import { Setup } from "../ui/Setup.js";
import { KeystrokeProvider } from "../ui/keystroke-context.js";
import { formatMcpLifecycleEvent } from "../ui/mcp-lifecycle.js";
import { formatMcpSlowToast } from "../ui/mcp-toast.js";
import type { McpServerSummary } from "../ui/slash.js";

export interface ProgressInfo {
  toolName: string;
  progress: number;
  total?: number;
  message?: string;
}

export interface ChatOptions {
  model: string;
  system: string;
  transcript?: string;
  harvest?: boolean;
  branch?: number;
  /**
   * Soft USD cap on session spend. Undefined → no cap (default).
   * The loop warns once at 80% and refuses to start a new turn at
   * 100%. Users can bump or clear via `/budget <usd>` / `/budget off`
   * mid-session.
   */
  budgetUsd?: number;
  session?: string;
  /** Zero or more MCP server specs. Each: `"name=cmd args..."` or `"cmd args..."`. */
  mcp?: string[];
  /** Global prefix — only used when a single anonymous server is given. */
  mcpPrefix?: string;
  /**
   * Pre-built ToolRegistry used as a seed. MCP bridges (if any) are
   * layered on top of whatever's already registered. Used by
   * `reasonix code` to register native filesystem tools in place of
   * the old `npx -y @modelcontextprotocol/server-filesystem` subprocess.
   */
  seedTools?: ToolRegistry;
  /**
   * Enable SEARCH/REPLACE edit-block processing after each assistant turn.
   * Set by `reasonix code`; plain `reasonix chat` leaves this off.
   */
  codeMode?: {
    rootDir: string;
    jobs?: import("../../tools/jobs.js").JobRegistry;
    /**
     * `/cwd <path>` callback — re-registers every rootDir-dependent
     * native tool against the new path. Optional so embedders that
     * don't want live cwd switching can omit it (the slash command
     * then falls back to non-tool updates only).
     */
    reregisterTools?: (rootDir: string) => void;
  };
  /** Skip the session picker — assume "Resume" (backwards-compatible auto-continue). */
  forceResume?: boolean;
  /** Skip the session picker — assume "New" (wipe the session file and start fresh). */
  forceNew?: boolean;
  /**
   * When true, suppress auto-launch of the embedded web dashboard.
   * Default behavior (false/undefined) is to boot it on mount so the
   * URL is visible in the status bar.
   */
  noDashboard?: boolean;
}

interface RootProps extends ChatOptions {
  initialKey: string | undefined;
  tools: ToolRegistry | undefined;
  mcpSpecs: string[];
  mcpServers: McpServerSummary[];
  /** App.tsx writes its progress handler here on mount so MCP frames flow into OngoingToolRow. */
  progressSink: { current: ((info: ProgressInfo) => void) | null };
  /** Show the SessionPicker (full list) when no --session was specified and saved sessions exist. */
  showPicker: boolean;
}

function Root({
  initialKey,
  tools,
  mcpSpecs,
  mcpServers,
  progressSink,
  showPicker,
  ...appProps
}: RootProps) {
  const [key, setKey] = useState<string | undefined>(initialKey);
  const [pickerOpen, setPickerOpen] = useState(showPicker);
  const [activeSession, setActiveSession] = useState<string | undefined>(appProps.session);
  const workspaceRoot = appProps.codeMode?.rootDir ?? process.cwd();
  const [sessions, setSessions] = useState(() => listSessionsForWorkspace(workspaceRoot));

  if (!key) {
    return (
      <Setup
        onReady={(k) => {
          process.env.DEEPSEEK_API_KEY = k;
          setKey(k);
        }}
      />
    );
  }
  process.env.DEEPSEEK_API_KEY = key;

  if (pickerOpen) {
    return (
      <KeystrokeProvider>
        <SessionPicker
          sessions={sessions}
          workspace={workspaceRoot}
          onChoose={(outcome) => {
            if (outcome.kind === "open") {
              setActiveSession(outcome.name);
              setPickerOpen(false);
              return;
            }
            if (outcome.kind === "new") {
              setActiveSession(undefined);
              setPickerOpen(false);
              return;
            }
            if (outcome.kind === "delete") {
              deleteSession(outcome.name);
              setSessions(listSessionsForWorkspace(workspaceRoot));
              return;
            }
            if (outcome.kind === "rename") {
              renameSession(outcome.name, outcome.newName);
              setSessions(listSessionsForWorkspace(workspaceRoot));
              return;
            }
            if (outcome.kind === "quit") {
              process.exit(0);
            }
          }}
        />
      </KeystrokeProvider>
    );
  }

  return (
    <KeystrokeProvider>
      <App
        // key forces a full remount (and fresh transcript / scrollback / cards) on switch.
        key={activeSession ?? "__new__"}
        model={appProps.model}
        system={appProps.system}
        transcript={appProps.transcript}
        harvest={appProps.harvest}
        branch={appProps.branch}
        budgetUsd={appProps.budgetUsd}
        session={activeSession}
        tools={tools}
        mcpSpecs={mcpSpecs}
        mcpServers={mcpServers}
        progressSink={progressSink}
        codeMode={appProps.codeMode}
        noDashboard={appProps.noDashboard}
        onSwitchSession={setActiveSession}
      />
    </KeystrokeProvider>
  );
}

export async function chatCommand(opts: ChatOptions): Promise<void> {
  loadDotenv();
  const initialKey = loadApiKey();

  const requestedSpecs = opts.mcp ?? [];
  const clients: McpClient[] = [];
  const successfulSpecs: string[] = [];
  const failedSpecs: Array<{ spec: string; reason: string }> = [];
  const mcpServers: McpServerSummary[] = [];
  // Shared progress sink: the bridge's onProgress callback writes
  // through `progressSink.current`, which App.tsx sets to its UI
  // updater on mount. Started null so early progress frames (before
  // the App has mounted) are dropped rather than buffered.
  const progressSink: { current: ((info: ProgressInfo) => void) | null } = { current: null };
  // Seed registry from the caller (e.g. reasonix code's native
  // filesystem tools) — MCP bridges layer on top rather than
  // replacing. When no seed AND no MCP, tools stays undefined and
  // the loop runs as a bare chat.
  let tools: ToolRegistry | undefined = opts.seedTools;

  const disabledNames = new Set(readConfig().mcpDisabled ?? []);
  if (requestedSpecs.length > 0) {
    if (!tools) tools = new ToolRegistry();
    for (const raw of requestedSpecs) {
      let label = "anon";
      try {
        const spec = parseMcpSpec(raw);
        label = spec.name ?? "anon";
        if (spec.name && disabledNames.has(spec.name)) {
          process.stderr.write(`${formatMcpLifecycleEvent({ state: "disabled", name: label })}\n`);
          continue;
        }
        process.stderr.write(`${formatMcpLifecycleEvent({ state: "handshake", name: label })}\n`);
        const t0 = Date.now();
        const prefix = spec.name
          ? `${spec.name}_`
          : requestedSpecs.length === 1 && opts.mcpPrefix
            ? opts.mcpPrefix
            : "";
        const transport: McpTransport =
          spec.transport === "sse"
            ? new SseTransport({ url: spec.url })
            : spec.transport === "streamable-http"
              ? new StreamableHttpTransport({ url: spec.url })
              : new StdioTransport({ command: spec.command, args: spec.args });
        const mcp = new McpClient({ transport });
        await mcp.initialize();
        const bridge = await bridgeMcpTools(mcp, {
          registry: tools,
          namePrefix: prefix,
          serverName: label,
          onProgress: (info) => progressSink.current?.(info),
          onSlow: (info) =>
            process.stderr.write(
              `${formatMcpSlowToast({ name: info.serverName, p95Ms: info.p95Ms, sampleSize: info.sampleSize })}\n`,
            ),
        });
        // Inspect collects resources + prompts once so `/mcp` can render them
        // synchronously. Servers that don't support these fall through as
        // `{supported: false}` instead of throwing.
        let report: InspectionReport;
        try {
          report = await inspectMcpServer(mcp);
        } catch {
          report = {
            protocolVersion: mcp.protocolVersion,
            serverInfo: mcp.serverInfo,
            capabilities: mcp.serverCapabilities ?? {},
            tools: { supported: true, items: [] },
            resources: { supported: false, reason: "inspect failed" },
            prompts: { supported: false, reason: "inspect failed" },
            elapsedMs: 0,
          };
        }
        const ms = Date.now() - t0;
        const resourceCount = report.resources.supported ? report.resources.items.length : 0;
        const promptCount = report.prompts.supported ? report.prompts.items.length : 0;
        process.stderr.write(
          `${formatMcpLifecycleEvent({
            state: "connected",
            name: label,
            tools: bridge.registeredNames.length,
            resources: resourceCount,
            prompts: promptCount,
            ms,
          })}\n`,
        );
        clients.push(mcp);
        successfulSpecs.push(raw);
        mcpServers.push({
          label,
          spec: raw,
          toolCount: bridge.registeredNames.length,
          report,
          client: mcp,
        });
      } catch (err) {
        // Per-server failure is non-fatal: one broken server shouldn't
        // kill a chat that has working servers configured. Recover by
        // recording the failure and continuing; user fixes via `reasonix
        // setup` without losing their other servers.
        const reason = (err as Error).message;
        failedSpecs.push({ spec: raw, reason });
        process.stderr.write(
          `${formatMcpLifecycleEvent({ state: "failed", name: label, reason })}\n  → run \`reasonix setup\` to remove this entry, or fix the underlying issue (missing npm package, network, etc.).\n`,
        );
      }
    }
    // If every requested server failed AND no seed registry was
    // provided, drop the empty registry so the loop still runs as a
    // bare chat instead of advertising zero tools. If the caller
    // passed seedTools we keep the registry — the seed tools are
    // still there and usable.
    if (successfulSpecs.length === 0 && !opts.seedTools) {
      tools = undefined;
    }
  }
  const mcpSpecs = successfulSpecs;

  // Register web search/fetch tools unless explicitly disabled. DDG
  // backs them with no key required; the model invokes them whenever
  // a question needs info fresher than its training data.
  if (searchEnabled()) {
    if (!tools) tools = new ToolRegistry();
    registerWebTools(tools);
  }

  // Memory tools — available in every session, not just code mode.
  // Chat-mode callers get global scope only; project scope requires
  // the seedTools path from `reasonix code` (which registers its own
  // MemoryStore bound to rootDir before chatCommand runs).
  // `run_skill` is registered later in App.tsx (where the client
  // exists) so it can wire the subagent runner for runAs:subagent
  // skills.
  if (!opts.seedTools) {
    if (!tools) tools = new ToolRegistry();
    registerMemoryTools(tools, {});
    // `ask_choice` — branching primitive, useful in chat too (stylistic
    // preferences, doc language, library picks). Independent of plan
    // mode, which chat doesn't have anyway.
    registerChoiceTool(tools);
  }

  // resolveSession handles --new (timestamped name, old session preserved)
  // and --resume (latest prefixed). Default falls through to the latest
  // prefixed-or-base.
  const { resolved: resolvedSession } = resolveSession(
    opts.session,
    opts.forceNew,
    opts.forceResume,
  );
  const launchWorkspace = opts.codeMode?.rootDir ?? process.cwd();
  const showPicker =
    !opts.session && !opts.forceResume && listSessionsForWorkspace(launchWorkspace).length > 0;

  // No startup clear, no resize listener. Earlier attempts wrote
  // various combinations of \x1b[2J / \x1b[3J / cursor-home to
  // present a 'clean canvas' on launch and to neutralize Ink's
  // eraseLines miscount on resize, but on xterm.js-based terminals
  // (VSCode integrated terminal in particular) those sequences
  // interfere with scrollback in ways that make wheel-up scroll
  // dead. Letting Ink mount directly leaves the user's previous
  // shell prompt visible above (scrolling up just works) and
  // accepts the resize-ghost / launch-noise tradeoffs as known
  // limitations — `/clear` is the manual reset.

  const { waitUntilExit } = render(
    <Root
      initialKey={initialKey}
      tools={tools}
      mcpSpecs={mcpSpecs}
      mcpServers={mcpServers}
      progressSink={progressSink}
      showPicker={showPicker}
      {...opts}
      session={resolvedSession}
    />,
    // patchConsole:false — winpty/MINTTY redraw-glitch source.
    { exitOnCtrlC: true, patchConsole: false },
  );
  try {
    await waitUntilExit();
  } finally {
    for (const c of clients) await c.close();
  }
}
