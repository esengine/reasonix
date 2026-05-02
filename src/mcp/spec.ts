/** Plain http:// stays HTTP+SSE for back-compat; Streamable HTTP is opt-in via the `streamable+` URL prefix. */

import { shellSplit } from "./shell-split.js";

export interface StdioMcpSpec {
  transport: "stdio";
  /** Namespace prefix applied to each registered tool, or null if anonymous. */
  name: string | null;
  /** Argv[0]. */
  command: string;
  /** Remaining argv. */
  args: string[];
}

export interface SseMcpSpec {
  transport: "sse";
  name: string | null;
  /** Fully qualified SSE endpoint URL. */
  url: string;
}

export interface StreamableHttpMcpSpec {
  transport: "streamable-http";
  name: string | null;
  /** Fully qualified Streamable HTTP endpoint URL (no `streamable+` prefix). */
  url: string;
}

export type McpSpec = StdioMcpSpec | SseMcpSpec | StreamableHttpMcpSpec;

const NAME_PREFIX = /^([a-zA-Z_][a-zA-Z0-9_-]*)=(.*)$/;
const HTTP_URL = /^https?:\/\//i;
const STREAMABLE_PREFIX = /^streamable\+(https?:\/\/.+)$/i;

export function parseMcpSpec(input: string): McpSpec {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("empty MCP spec");
  }

  const nameMatch = NAME_PREFIX.exec(trimmed);
  const name = nameMatch ? nameMatch[1]! : null;
  const body = (nameMatch ? nameMatch[2]! : trimmed).trim();

  if (!body) {
    throw new Error(`MCP spec has name but no command: ${input}`);
  }

  const streamMatch = STREAMABLE_PREFIX.exec(body);
  if (streamMatch) {
    return { transport: "streamable-http", name, url: streamMatch[1]! };
  }

  if (HTTP_URL.test(body)) {
    return { transport: "sse", name, url: body };
  }

  const argv = shellSplit(body);
  if (argv.length === 0) {
    throw new Error(`MCP spec has name but no command: ${input}`);
  }
  const [command, ...args] = argv;
  return { transport: "stdio", name, command: command!, args };
}
