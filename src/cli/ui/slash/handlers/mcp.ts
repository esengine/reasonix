import type { SlashHandler } from "../dispatch.js";
import { appendSection } from "../helpers.js";

const mcp: SlashHandler = (args, loop, ctx) => {
  const servers = ctx.mcpServers ?? [];
  const specs = ctx.mcpSpecs ?? [];
  const toolSpecs = loop.prefix.toolSpecs ?? [];
  // `/mcp text` (or non-TTY) falls through to the printed-card path. The
  // default `/mcp` opens the interactive browser modal.
  const wantsTextDump = args[0] === "text";
  if (servers.length === 0 && specs.length === 0 && toolSpecs.length === 0) {
    return {
      info:
        "no MCP servers attached. Run `reasonix setup` to pick some, " +
        'or launch with --mcp "<spec>". `reasonix mcp list` shows the catalog.',
    };
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
      lines.push(`  tools     ${s.toolCount}`);
      appendSection(lines, "resources", report.resources);
      appendSection(lines, "prompts  ", report.prompts);
      if (report.resources.supported && report.resources.items.length > 0) anyResources = true;
      if (report.prompts.supported && report.prompts.items.length > 0) anyPrompts = true;
      lines.push("");
    }
    if (anyResources || anyPrompts) {
      const hints: string[] = [];
      if (anyResources) hints.push("`/resource` to browse+read");
      if (anyPrompts) hints.push("`/prompt` to browse+fetch");
      lines.push(hints.join(" · "));
    } else {
      lines.push(
        "Chat mode consumes tools today; resources+prompts are surfaced here for awareness.",
      );
    }
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
};

function healthBadge(elapsedMs: number): string {
  if (elapsedMs < 500) return `● healthy · ${elapsedMs}ms`;
  if (elapsedMs < 3000) return `◌ slow · ${elapsedMs}ms`;
  return `✗ very slow · ${elapsedMs}ms`;
}

export const handlers: Record<string, SlashHandler> = { mcp };
