/** Formats one-liner MCP lifecycle events per `docs/design/agent-tui-terminal.html` §37. */

export type McpLifecycleEvent =
  | { state: "handshake"; name: string }
  | {
      state: "connected";
      name: string;
      tools: number;
      resources?: number;
      prompts?: number;
      ms: number;
    }
  | { state: "failed"; name: string; reason: string }
  | { state: "disabled"; name: string };

const STATE: Record<McpLifecycleEvent["state"], { glyph: string; label: string }> = {
  handshake: { glyph: "↻", label: "handshake…" },
  connected: { glyph: "✓", label: "connected" },
  failed: { glyph: "✖", label: "failed" },
  disabled: { glyph: "○", label: "disabled" },
};

const NAME_COL = 22;
const STATE_COL = 15;

export function formatMcpLifecycleEvent(ev: McpLifecycleEvent): string {
  const { glyph, label } = STATE[ev.state];
  const namePart = `MCP · ${ev.name}`;
  const namePad = " ".repeat(Math.max(1, NAME_COL - namePart.length));
  const stateField = `${glyph} ${label}`.padEnd(STATE_COL);
  return `⌘ ${namePart}${namePad}${stateField}${describeDetail(ev)}`;
}

function describeDetail(ev: McpLifecycleEvent): string {
  if (ev.state === "handshake") return "initialise → tools/list → resources/list";
  if (ev.state === "failed") return ev.reason;
  if (ev.state === "disabled") return `via /mcp disable ${ev.name}`;
  const parts: string[] = [`${ev.tools} tools`];
  if (ev.resources && ev.resources > 0) parts.push(`${ev.resources} resources`);
  if (ev.prompts && ev.prompts > 0) parts.push(`${ev.prompts} prompts`);
  parts.push(`${ev.ms}ms`);
  return parts.join(" · ");
}
