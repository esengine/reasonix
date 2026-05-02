/** `/mcp` browser modal — keyboard-driven server list per design §24. */

import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React, { useState } from "react";
import { useKeystroke } from "./keystroke-context.js";
import { kickOffMcpReconnect } from "./mcp-reconnect-kickoff.js";
import type { McpServerSummary } from "./slash/types.js";
import { COLOR } from "./theme.js";

export interface McpBrowserProps {
  servers: McpServerSummary[];
  configPath: string;
  onClose: () => void;
  /** Pushed by the modal when a key triggers async work (`r` reconnect). */
  postInfo: (text: string) => void;
}

export function McpBrowser({ servers, configPath, onClose, postInfo }: McpBrowserProps) {
  const [index, setIndex] = useState(0);
  const max = Math.max(0, servers.length - 1);

  useKeystroke((ev) => {
    if (ev.paste) return;
    if (ev.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (ev.downArrow) setIndex((i) => Math.min(max, i + 1));
    else if (ev.escape) onClose();
    else if (ev.input === "r") {
      const target = servers[index];
      if (!target) return;
      // Hand the "starting" lifecycle line to scrollback and let the
      // kickoff schedule the result line via postInfo. Close the modal
      // so the line is visible immediately.
      postInfo(kickOffMcpReconnect(target, postInfo));
      onClose();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color={COLOR.brand}>
          ◈ MCP browser
        </Text>
        <Text
          dimColor
        >{`  ·  ${configPath}  ·  ${servers.length} server${servers.length === 1 ? "" : "s"}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {servers.length === 0 ? (
          <Text dimColor>
            No MCP servers attached. Run `reasonix setup` to pick some, or launch with --mcp.
          </Text>
        ) : (
          servers.map((s, i) => (
            <ServerRow key={s.label + s.spec} server={s} active={i === index} />
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ pick · [r] reconnect · [d] disable (TBD) · esc quit</Text>
      </Box>
    </Box>
  );
}

function ServerRow({ server, active }: { server: McpServerSummary; active: boolean }) {
  const { label, toolCount, report } = server;
  const resourceCount = report.resources.supported ? report.resources.items.length : 0;
  const promptCount = report.prompts.supported ? report.prompts.items.length : 0;
  const elapsed = report.elapsedMs;
  const health = healthBadge(elapsed);
  const counts = `${toolCount} tools · ${resourceCount} resources · ${promptCount} prompts`;

  return (
    <Box flexDirection="column" marginBottom={active ? 1 : 0}>
      <Box>
        <Text color={active ? COLOR.brand : undefined}>{active ? "▸  " : "   "}</Text>
        <Text bold={active} color={active ? "#e6edf3" : undefined}>
          {label.padEnd(14)}
        </Text>
        <Text color={health.color}>{`${health.glyph} ${health.label}`}</Text>
        <Text dimColor>{`      ${counts}`}</Text>
      </Box>
      {active ? (
        <Box>
          <Text dimColor>{`     ${capabilityList(server)}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function healthBadge(elapsedMs: number): { glyph: string; label: string; color: string } {
  if (elapsedMs === 0) return { glyph: "✗", label: "no inspect data", color: COLOR.err };
  if (elapsedMs < 500) return { glyph: "●", label: `healthy · ${elapsedMs}ms`, color: COLOR.ok };
  if (elapsedMs < 3000) return { glyph: "◌", label: `slow · ${elapsedMs}ms`, color: COLOR.warn };
  return { glyph: "✗", label: `very slow · ${elapsedMs}ms`, color: COLOR.err };
}

function capabilityList(s: McpServerSummary): string {
  const caps: string[] = ["tools/list", "tools/call"];
  if (s.report.resources.supported) caps.push("resources/list");
  if (s.report.prompts.supported) caps.push("prompts/list");
  return caps.join("  ");
}
