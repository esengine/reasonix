/**
 * Gather a full inspection report from an initialized MCP client:
 * server info, capabilities, tools, resources, prompts. Methods the
 * server doesn't support come back as `{ supported: false }` instead
 * of throwing, so a CLI or UI can render a consistent "what this
 * server exposes" summary even against minimal implementations.
 *
 * Pure with respect to I/O beyond the passed-in client — the CLI
 * layer owns argument parsing, connection setup, and printing.
 */

import type { McpClient } from "./client.js";
import type { McpPrompt, McpResource, McpTool } from "./types.js";

export interface InspectionReport {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
  instructions?: string;
  tools: SectionResult<McpTool>;
  resources: SectionResult<McpResource>;
  prompts: SectionResult<McpPrompt>;
}

export type SectionResult<T> =
  | { supported: true; items: T[] }
  | { supported: false; reason: string };

/**
 * Run an inspection against a **already-initialized** client. Caller
 * is responsible for `initialize()` before this and `close()` after.
 * We keep this pure so unit tests can feed in a FakeMcpTransport and
 * verify the aggregate shape without spinning up a real process.
 */
export async function inspectMcpServer(client: McpClient): Promise<InspectionReport> {
  // We always *try* the three listings so the client learns whether a
  // server without explicit capability flags still serves them —
  // some servers omit capabilities but still respond to the methods.
  const tools = await trySection<McpTool>(() => client.listTools().then((r) => r.tools));
  const resources = await trySection<McpResource>(() =>
    client.listResources().then((r) => r.resources),
  );
  const prompts = await trySection<McpPrompt>(() => client.listPrompts().then((r) => r.prompts));

  return {
    protocolVersion: client.protocolVersion || "(unknown)",
    serverInfo: client.serverInfo,
    capabilities: client.serverCapabilities ?? {},
    instructions: client.serverInstructions,
    tools,
    resources,
    prompts,
  };
}

async function trySection<T>(load: () => Promise<T[]>): Promise<SectionResult<T>> {
  try {
    const items = await load();
    return { supported: true, items };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // -32601 is JSON-RPC "method not found" — the canonical response
    // from a server that doesn't implement this family. Treat it as
    // "not supported" rather than a hard error, so the CLI can render
    // a clean summary instead of aborting on the first missing method.
    if (/-32601/.test(msg) || /method not found/i.test(msg)) {
      return { supported: false, reason: "method not found (-32601)" };
    }
    return { supported: false, reason: msg };
  }
}
