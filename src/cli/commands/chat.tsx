import { render } from "ink";
import React, { useState } from "react";
import { loadApiKey } from "../../config.js";
import { loadDotenv } from "../../env.js";
import { McpClient } from "../../mcp/client.js";
import { bridgeMcpTools } from "../../mcp/registry.js";
import { parseMcpSpec } from "../../mcp/spec.js";
import { SseTransport } from "../../mcp/sse.js";
import { type McpTransport, StdioTransport } from "../../mcp/stdio.js";
import { ToolRegistry } from "../../tools.js";
import { App } from "../ui/App.js";
import { Setup } from "../ui/Setup.js";

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
}

interface RootProps extends ChatOptions {
  initialKey: string | undefined;
  tools: ToolRegistry | undefined;
}

function Root({ initialKey, tools, ...appProps }: RootProps) {
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
    />
  );
}

export async function chatCommand(opts: ChatOptions): Promise<void> {
  loadDotenv();
  const initialKey = loadApiKey();

  const mcpSpecs = opts.mcp ?? [];
  const clients: McpClient[] = [];
  let tools: ToolRegistry | undefined;

  if (mcpSpecs.length > 0) {
    tools = new ToolRegistry();
    for (const raw of mcpSpecs) {
      try {
        const spec = parseMcpSpec(raw);
        const prefix = spec.name
          ? `${spec.name}_`
          : mcpSpecs.length === 1 && opts.mcpPrefix
            ? opts.mcpPrefix
            : "";
        const transport: McpTransport =
          spec.transport === "sse"
            ? new SseTransport({ url: spec.url })
            : new StdioTransport({ command: spec.command, args: spec.args });
        const mcp = new McpClient({ transport });
        await mcp.initialize();
        const bridge = await bridgeMcpTools(mcp, { registry: tools, namePrefix: prefix });
        const label = spec.name ?? "anon";
        const source =
          spec.transport === "sse" ? spec.url : `${spec.command} ${spec.args.join(" ")}`;
        process.stderr.write(
          `▸ MCP[${label}]: ${bridge.registeredNames.length} tool(s) from ${source}\n`,
        );
        clients.push(mcp);
      } catch (err) {
        process.stderr.write(`MCP setup failed for "${raw}": ${(err as Error).message}\n`);
        for (const c of clients) await c.close();
        process.exit(1);
      }
    }
  }

  const { waitUntilExit } = render(<Root initialKey={initialKey} tools={tools} {...opts} />, {
    exitOnCtrlC: true,
  });
  try {
    await waitUntilExit();
  } finally {
    for (const c of clients) await c.close();
  }
}
