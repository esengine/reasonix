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
import { ToolRegistry } from "../../tools.js";
import { registerWebTools } from "../../tools/web.js";
import { App } from "../ui/App.js";
import { Setup } from "../ui/Setup.js";
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
  codeMode?: { rootDir: string };
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
}

function Root({ initialKey, tools, mcpSpecs, mcpServers, progressSink, ...appProps }: RootProps) {
  const [key, setKey] = useState<string | undefined>(initialKey);
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
  return (
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
    />
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
          spec.transport === "sse" ? spec.url : `${spec.command} ${spec.args.join(" ")}`;
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

  const { waitUntilExit } = render(
    <Root
      initialKey={initialKey}
      tools={tools}
      mcpSpecs={mcpSpecs}
      mcpServers={mcpServers}
      progressSink={progressSink}
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
