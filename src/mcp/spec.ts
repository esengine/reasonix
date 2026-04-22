/**
 * Parse the `--mcp` CLI argument into a transport-tagged spec.
 *
 * Accepted forms:
 *   "name=command args..."      → stdio, namespaced (tools prefixed with `name_`)
 *   "command args..."           → stdio, anonymous
 *   "name=https://host/sse"     → SSE, namespaced
 *   "https://host/sse"          → SSE, anonymous
 *   ("http://" is also honored — useful for local dev servers.)
 *
 * The identifier regex before `=` is deliberately narrow
 * (`[a-zA-Z_][a-zA-Z0-9_]*`) so Windows drive letters ("C:\\...") and
 * other strings containing `=` or `:` don't accidentally trigger the
 * namespace branch. If a user ever wants their command to literally start
 * with `foo=...` as a bare command, they can wrap it in quotes inside the
 * shell command string.
 *
 * Transport is selected solely by whether the body begins with `http://`
 * or `https://`. Anything else is stdio — including ws:// (unsupported)
 * which will surface later as a spawn error, keeping the rule local.
 */

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

export type McpSpec = StdioMcpSpec | SseMcpSpec;

const NAME_PREFIX = /^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/;
const HTTP_URL = /^https?:\/\//i;

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
