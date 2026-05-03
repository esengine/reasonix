import { t } from "../../../../i18n/index.js";
import type { CacheFirstLoop } from "../../../../loop.js";
import { applyMcpAppend } from "../../mcp-append.js";
import { toggleMcpDisabled } from "../../mcp-disable.js";
import { kickOffMcpReconnect } from "../../mcp-reconnect-kickoff.js";
import type { SlashHandler } from "../dispatch.js";
import { appendSection } from "../helpers.js";
import type { McpServerSummary } from "../types.js";

const mcp: SlashHandler = (args, loop, ctx) => {
  const servers = ctx.mcpServers ?? [];
  const specs = ctx.mcpSpecs ?? [];
  const toolSpecs = loop.prefix.toolSpecs ?? [];
  const sub = args[0];
  if (sub === "disable" || sub === "enable") {
    return toggleDisabled(sub, args[1], { servers, specs });
  }
  if (sub === "reconnect") {
    return triggerReconnect(args[1], servers, ctx.postInfo, loop);
  }
  // `/mcp text` (or non-TTY) falls through to the printed-card path. The
  // default `/mcp` opens the interactive browser modal.
  const wantsTextDump = sub === "text";
  if (servers.length === 0 && specs.length === 0 && toolSpecs.length === 0) {
    return { info: t("handlers.mcp.noServers") };
  }
  if (!wantsTextDump && servers.length > 0) {
    return { openMcpBrowser: true };
  }
  // Rich path — we have full inspection reports, so show each server
  // with its tools / resources / prompts grouped together.
  if (servers.length > 0) {
    const lines: string[] = [];
    let anyResources = false;
    let anyPrompts = false;
    for (const s of servers) {
      const { report } = s;
      const serverName = report.serverInfo.name || "(unknown)";
      const serverVer = report.serverInfo.version ? ` v${report.serverInfo.version}` : "";
      const health = healthBadge(report.elapsedMs);
      lines.push(`${health}  [${s.label}] ${serverName}${serverVer}  —  ${s.spec}`);
      lines.push(t("handlers.mcp.toolsLabel", { count: s.toolCount }));
      appendSection(lines, "resources", report.resources);
      appendSection(lines, "prompts  ", report.prompts);
      if (report.resources.supported && report.resources.items.length > 0) anyResources = true;
      if (report.prompts.supported && report.prompts.items.length > 0) anyPrompts = true;
      lines.push("");
    }
    if (anyResources || anyPrompts) {
      const hints: string[] = [];
      if (anyResources) hints.push(t("handlers.mcp.resourcesHint"));
      if (anyPrompts) hints.push(t("handlers.mcp.promptsHint"));
      lines.push(hints.join(" · "));
    } else {
      lines.push(t("handlers.mcp.awarenessOnly"));
    }
    lines.push(t("handlers.mcp.catalogHint"));
    return { info: lines.join("\n") };
  }
  const lines: string[] = [];
  if (specs.length > 0) {
    lines.push(t("handlers.mcp.fallbackServers", { count: specs.length }));
    for (const spec of specs) lines.push(`  · ${spec}`);
    lines.push("");
  }
  if (toolSpecs.length > 0) {
    lines.push(t("handlers.mcp.fallbackTools", { count: toolSpecs.length }));
    for (const tool of toolSpecs) lines.push(`  · ${tool.function.name}`);
  }
  lines.push("");
  lines.push(t("handlers.mcp.fallbackChange"));
  return { info: lines.join("\n") };
};

function healthBadge(elapsedMs: number): string {
  if (elapsedMs < 500) return `● healthy · ${elapsedMs}ms`;
  if (elapsedMs < 3000) return `◌ slow · ${elapsedMs}ms`;
  return `✗ very slow · ${elapsedMs}ms`;
}

function toggleDisabled(
  action: "disable" | "enable",
  rawName: string | undefined,
  ctx: { servers: ReadonlyArray<{ label: string }>; specs: ReadonlyArray<string> },
): { info: string } {
  const name = rawName?.trim();
  if (!name) {
    return {
      info: `usage: /mcp ${action} <name>  ·  pick a name shown in /mcp (anonymous servers can't be named-toggled).`,
    };
  }
  const known = new Set<string>([
    ...ctx.servers.map((s) => s.label),
    ...ctx.specs.map((spec) => parseLabelFromSpec(spec)).filter((n): n is string => n !== null),
  ]);
  if (!known.has(name)) {
    const list = [...known].sort().join(", ") || "(none)";
    return { info: `unknown MCP server "${name}". Known: ${list}.` };
  }
  return { info: toggleMcpDisabled(action, name) };
}

function parseLabelFromSpec(spec: string): string | null {
  const match = spec.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)=/);
  return match ? (match[1] ?? null) : null;
}

function triggerReconnect(
  rawName: string | undefined,
  servers: ReadonlyArray<McpServerSummary>,
  postInfo: ((text: string) => void) | undefined,
  loop: CacheFirstLoop,
): { info: string } {
  const name = rawName?.trim();
  if (!name) {
    return {
      info: "usage: /mcp reconnect <name>  ·  pick a name shown in /mcp.",
    };
  }
  const target = servers.find((s) => s.label === name);
  if (!target) {
    const list = servers
      .map((s) => s.label)
      .sort()
      .join(", ");
    return { info: `unknown MCP server "${name}". Known: ${list || "(none)"}.` };
  }
  if (!postInfo) {
    return { info: "/mcp reconnect requires the interactive TUI (postInfo not wired)." };
  }
  // Append-drift accepted automatically: server added new tools, we register them
  // and call addTool on the prefix (cache miss only on the appended chunks per the
  // benchmarks/spike-mcp-reconnect data — typically <5% loss).
  return {
    info: kickOffMcpReconnect(target, postInfo, (t, addedTools) =>
      applyMcpAppend(loop, t, addedTools),
    ),
  };
}

export const handlers: Record<string, SlashHandler> = { mcp };
