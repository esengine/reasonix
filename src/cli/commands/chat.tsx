import { existsSync, statSync } from "node:fs";
import { render } from "ink";
import React, { useState } from "react";
import { loadApiKey, searchEnabled } from "../../config.js";
import { loadDotenv } from "../../env.js";
import { McpClient } from "../../mcp/client.js";
import { type InspectionReport, inspectMcpServer } from "../../mcp/inspect.js";
import { bridgeMcpTools } from "../../mcp/registry.js";
import { parseMcpSpec } from "../../mcp/spec.js";
import { SseTransport } from "../../mcp/sse.js";
import { type McpTransport, StdioTransport } from "../../mcp/stdio.js";
import { StreamableHttpTransport } from "../../mcp/streamable-http.js";
import {
  loadSessionMessages,
  rewriteSession,
  sessionPath as sessionPathOf,
} from "../../session.js";
import { ToolRegistry } from "../../tools.js";
import { registerChoiceTool } from "../../tools/choice.js";
import { registerMemoryTools } from "../../tools/memory.js";
import { registerWebTools } from "../../tools/web.js";
import { App } from "../ui/App.js";
import { SessionPicker } from "../ui/SessionPicker.js";
import { Setup } from "../ui/Setup.js";
import { KeystrokeProvider } from "../ui/keystroke-context.js";
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
  /**
   * Shared ref the bridge's `onProgress` callback writes through.
   * App sets `.current` to its own handler on mount so every
   * progress frame from any bridged tool lands in the UI's
   * `OngoingToolRow`. Ref keeps the wire-up synchronous with
   * React reconciliation (no effect-timing surprises).
   */
  progressSink: { current: ((info: ProgressInfo) => void) | null };
  /** Present when the session has prior messages; drives the picker. */
  sessionPreview?: { messageCount: number; lastActive: Date };
}

function Root({
  initialKey,
  tools,
  mcpSpecs,
  mcpServers,
  progressSink,
  sessionPreview,
  ...appProps
}: RootProps) {
  const [key, setKey] = useState<string | undefined>(initialKey);
  // `null` once the picker is resolved (or was never needed). Starts as
  // the preview so we can render the picker once before mounting App.
  const [pending, setPending] = useState<typeof sessionPreview>(sessionPreview);

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

  // KeystrokeProvider must wrap App from OUTSIDE — App.tsx itself
  // calls `useKeystroke` in its function body for global hotkeys
  // (Ctrl+C, Esc abort, Shift+Tab edit-mode cycle, @-mention picker,
  // slash-suggestion navigation). If the provider lives inside App's
  // render, `useContext(KeystrokeContext)` returns `null` at hook
  // call time and those handlers silently never subscribe.
  if (pending && appProps.session) {
    return (
      <KeystrokeProvider>
        <SessionPicker
          sessionName={appProps.session}
          messageCount={pending.messageCount}
          lastActive={pending.lastActive}
          onChoose={(choice) => {
            if (choice === "new" || choice === "delete") {
              // Wipe the session file. "new" and "delete" do the same thing
              // at this step — the distinction is only in the picker's
              // wording. A future enhancement could archive on "new".
              rewriteSession(appProps.session!, []);
            }
            setPending(undefined);
          }}
        />
      </KeystrokeProvider>
    );
  }

  return (
    <KeystrokeProvider>
      <App
        model={appProps.model}
        system={appProps.system}
        transcript={appProps.transcript}
        harvest={appProps.harvest}
        branch={appProps.branch}
        session={appProps.session}
        tools={tools}
        mcpSpecs={mcpSpecs}
        mcpServers={mcpServers}
        progressSink={progressSink}
        codeMode={appProps.codeMode}
        noDashboard={appProps.noDashboard}
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

  if (requestedSpecs.length > 0) {
    if (!tools) tools = new ToolRegistry();
    for (const raw of requestedSpecs) {
      try {
        const spec = parseMcpSpec(raw);
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
          onProgress: (info) => progressSink.current?.(info),
        });
        // Collect resources + prompts once at startup so the /mcp
        // slash can render them synchronously. Servers that don't
        // support these fall through as `{supported: false}` instead
        // of throwing — see inspectMcpServer.
        let report: InspectionReport;
        try {
          report = await inspectMcpServer(mcp);
        } catch {
          // If the inspect call itself fails (rare — shouldn't happen
          // since inspectMcpServer swallows -32601), synthesize a
          // minimal report so `/mcp` still has something to render.
          report = {
            protocolVersion: mcp.protocolVersion,
            serverInfo: mcp.serverInfo,
            capabilities: mcp.serverCapabilities ?? {},
            tools: { supported: true, items: [] },
            resources: { supported: false, reason: "inspect failed" },
            prompts: { supported: false, reason: "inspect failed" },
          };
        }
        const label = spec.name ?? "anon";
        const source =
          spec.transport === "sse" || spec.transport === "streamable-http"
            ? spec.url
            : `${spec.command} ${spec.args.join(" ")}`;
        process.stderr.write(
          `▸ MCP[${label}]: ${bridge.registeredNames.length} tool(s) from ${source}\n`,
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
        // kill a chat that has working servers configured. We record
        // the failure, show a visible warning, and keep going. User
        // can fix via `reasonix setup` (unchecks the broken entry)
        // without losing their other servers.
        const reason = (err as Error).message;
        failedSpecs.push({ spec: raw, reason });
        process.stderr.write(
          `▸ MCP setup SKIPPED for "${raw}": ${reason}\n  → this server will not be available this session. Run \`reasonix setup\` to remove it, or fix the underlying issue (missing npm package, network, etc.).\n`,
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

  // Decide whether to show the session picker. It's gated on: session
  // persistence is on, the session file already has prior messages, and
  // the caller didn't pre-commit to one of the choices via --resume /
  // --new flags. `--new` wipes the file now (before the loop opens),
  // so the App mounts against a fresh log.
  let sessionPreview: { messageCount: number; lastActive: Date } | undefined;
  if (opts.session && !opts.forceResume && !opts.forceNew) {
    const prior = loadSessionMessages(opts.session);
    if (prior.length > 0) {
      const p = sessionPathOf(opts.session);
      const mtime = existsSync(p) ? statSync(p).mtime : new Date();
      sessionPreview = { messageCount: prior.length, lastActive: mtime };
    }
  } else if (opts.session && opts.forceNew) {
    rewriteSession(opts.session, []);
  }

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
      sessionPreview={sessionPreview}
      {...opts}
    />,
    // patchConsole:false — we never log to console during the TUI, and the
    // patch is a known redraw-glitch source on winpty/MINTTY terminals.
    { exitOnCtrlC: true, patchConsole: false },
  );
  try {
    await waitUntilExit();
  } finally {
    for (const c of clients) await c.close();
  }
}
