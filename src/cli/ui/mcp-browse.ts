/** `/resource` + `/prompt` handlers — async (round-trip to MCP server), so App.tsx calls directly instead of `handleSlash`. */

import type { McpClient } from "../../mcp/client.js";
import type {
  GetPromptResult,
  McpPromptMessage,
  McpResourceContents,
  ReadResourceResult,
} from "../../mcp/types.js";
import type { Scrollback } from "./hooks/useScrollback.js";
import type { McpServerSummary } from "./slash.js";

export function formatResourceList(servers: readonly McpServerSummary[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const s of servers) {
    if (!s.report.resources.supported) continue;
    const items = s.report.resources.items;
    if (items.length === 0) continue;
    lines.push(`[${s.label}] ${items.length} resource(s):`);
    for (const r of items.slice(0, 20)) {
      const name = r.name && r.name !== r.uri ? `  ${r.name}` : "";
      const mime = r.mimeType ? ` · ${r.mimeType}` : "";
      lines.push(`  · ${r.uri}${name}${mime}`);
      total++;
    }
    if (items.length > 20) lines.push(`  (+${items.length - 20} more)`);
    lines.push("");
  }
  if (total === 0) {
    return "No resources on any connected MCP server (or no servers connected). `/mcp` shows the current set.";
  }
  lines.push("Read one: `/resource <uri>` — or use Tab in the picker.");
  return lines.join("\n");
}

export function formatPromptList(servers: readonly McpServerSummary[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const s of servers) {
    if (!s.report.prompts.supported) continue;
    const items = s.report.prompts.items;
    if (items.length === 0) continue;
    lines.push(`[${s.label}] ${items.length} prompt(s):`);
    for (const p of items.slice(0, 20)) {
      const desc = p.description ? ` — ${p.description}` : "";
      const argHint =
        p.arguments && p.arguments.length > 0
          ? ` (args: ${p.arguments.map((a) => a.name + (a.required ? "*" : "?")).join(", ")})`
          : "";
      lines.push(`  · ${p.name}${argHint}${desc}`);
      total++;
    }
    if (items.length > 20) lines.push(`  (+${items.length - 20} more)`);
    lines.push("");
  }
  if (total === 0) {
    return "No prompts on any connected MCP server (or no servers connected). `/mcp` shows the current set.";
  }
  lines.push(
    "Fetch one: `/prompt <name>` — args are not supported yet; prompts with required args will surface an error from the server.",
  );
  return lines.join("\n");
}

export function findServerForResource(
  servers: readonly McpServerSummary[],
  uri: string,
): McpServerSummary | null {
  for (const s of servers) {
    if (!s.report.resources.supported) continue;
    if (s.report.resources.items.some((r) => r.uri === uri)) return s;
  }
  return null;
}

export function findServerForPrompt(
  servers: readonly McpServerSummary[],
  name: string,
): McpServerSummary | null {
  for (const s of servers) {
    if (!s.report.prompts.supported) continue;
    if (s.report.prompts.items.some((p) => p.name === name)) return s;
  }
  return null;
}

export function formatResourceContents(uri: string, result: ReadResourceResult): string {
  const lines: string[] = [`Resource ${uri} (${result.contents.length} content block(s)):`, ""];
  for (let i = 0; i < result.contents.length; i++) {
    const c = result.contents[i]!;
    const header = `— block ${i + 1}${c.mimeType ? ` · ${c.mimeType}` : ""}`;
    lines.push(header);
    lines.push(formatOneResourceContent(c));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function formatOneResourceContent(c: McpResourceContents): string {
  if ("text" in c) {
    const MAX = 8_000;
    if (c.text.length > MAX) {
      return `${c.text.slice(0, MAX)}\n\n[…truncated ${c.text.length - MAX} chars; full contents available via McpClient.readResource in library mode.]`;
    }
    return c.text;
  }
  // blob — we can't render arbitrary binary in the TUI; give the size.
  const bytes = typeof c.blob === "string" ? approximateBase64ByteSize(c.blob) : 0;
  return `[binary · ~${bytes.toLocaleString()} bytes · base64]`;
}

function approximateBase64ByteSize(b64: string): number {
  // 4 base64 chars encode 3 bytes; padding `=` trims the output.
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export function formatPromptMessages(name: string, result: GetPromptResult): string {
  const lines: string[] = [
    `Prompt ${name}${result.description ? ` — ${result.description}` : ""}`,
    `(${result.messages.length} message(s))`,
    "",
  ];
  for (let i = 0; i < result.messages.length; i++) {
    const m = result.messages[i]!;
    lines.push(`— ${i + 1}. ${m.role}`);
    lines.push(formatOnePromptMessage(m));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function formatOnePromptMessage(m: McpPromptMessage): string {
  const block = m.content as { type?: string; text?: string; resource?: McpResourceContents };
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource" && block.resource) {
    return `[resource: ${block.resource.uri}]\n${formatOneResourceContent(block.resource)}`;
  }
  return `[non-text content: ${block.type ?? "unknown"}]`;
}

export async function handleMcpBrowseSlash(
  kind: "resource" | "prompt",
  arg: string,
  servers: readonly McpServerSummary[],
  log: Scrollback,
): Promise<void> {
  // No arg → list mode.
  if (!arg) {
    log.pushInfo(kind === "resource" ? formatResourceList(servers) : formatPromptList(servers));
    return;
  }

  if (kind === "resource") {
    const server = findServerForResource(servers, arg);
    if (!server) {
      log.pushWarning(
        `no server exposes resource "${arg}"`,
        "`/resource` with no arg lists what's available.",
      );
      return;
    }
    const client: McpClient = server.host.client;
    try {
      const result = await client.readResource(arg);
      log.pushInfo(formatResourceContents(arg, result));
    } catch (err) {
      log.pushWarning("readResource failed", (err as Error).message);
    }
    return;
  }

  // prompt
  const server = findServerForPrompt(servers, arg);
  if (!server) {
    log.pushWarning(
      `no server exposes prompt "${arg}"`,
      "`/prompt` with no arg lists what's available.",
    );
    return;
  }
  const client: McpClient = server.host.client;
  try {
    const result = await client.getPrompt(arg);
    log.pushInfo(formatPromptMessages(arg, result));
  } catch (err) {
    log.pushWarning("getPrompt failed", (err as Error).message);
  }
}
