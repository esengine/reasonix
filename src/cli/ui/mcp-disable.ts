/** Persists `mcpDisabled` to ~/.reasonix/config.json — shared between `/mcp disable / enable` slash and the McpBrowser `d` keybind. */

import { readConfig, writeConfig } from "../../config.js";

export function toggleMcpDisabled(action: "disable" | "enable", name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return `usage: /mcp ${action} <name>  ·  pick a name shown in /mcp (anonymous servers can't be named-toggled).`;
  }
  const cfg = readConfig();
  const current = new Set(cfg.mcpDisabled ?? []);
  if (action === "disable") {
    if (current.has(trimmed)) {
      return `▸ ${trimmed} is already disabled — restart to apply, or /mcp enable ${trimmed}.`;
    }
    current.add(trimmed);
    writeConfig({ ...cfg, mcpDisabled: [...current].sort() });
    return `▸ ${trimmed} disabled — takes effect on next launch. /mcp enable ${trimmed} to revert.`;
  }
  if (!current.has(trimmed)) {
    return `▸ ${trimmed} is not disabled.`;
  }
  current.delete(trimmed);
  writeConfig({ ...cfg, mcpDisabled: current.size > 0 ? [...current].sort() : undefined });
  return `▸ ${trimmed} re-enabled — takes effect on next launch.`;
}
