import type { WriteStream } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  defaultConfigPath,
  isPlausibleKey,
  loadApiKey,
  readConfig,
  saveApiKey,
} from "../../config.js";
import { loadDotenv } from "../../env.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";
import { McpClient } from "../../mcp/client.js";
import { bridgeMcpTools } from "../../mcp/registry.js";
import { parseMcpSpec } from "../../mcp/spec.js";
import { SseTransport } from "../../mcp/sse.js";
import { type McpTransport, StdioTransport } from "../../mcp/stdio.js";
import { StreamableHttpTransport } from "../../mcp/streamable-http.js";
import { appendUsage } from "../../telemetry/usage.js";
import { ToolRegistry } from "../../tools.js";
import { openTranscriptFile, recordFromLoopEvent, writeRecord } from "../../transcript/log.js";
import { formatMcpLifecycleEvent } from "../ui/mcp-lifecycle.js";
import { formatMcpSlowToast } from "../ui/mcp-toast.js";

export interface RunOptions {
  task: string;
  model: string;
  system: string;
  /** Opt into Pillar 2 plan-state harvesting. Adds a cheap V3 call per turn. */
  harvest?: boolean;
  /** Self-consistency budget. > 1 runs N parallel samples and picks the best. */
  branch?: number;
  budgetUsd?: number;
  /** JSONL transcript path — lets `reasonix replay` / `diff` audit this run. */
  transcript?: string;
  /** Zero or more MCP server specs. Each: `"name=cmd args..."` or `"cmd args..."`. */
  mcp?: string[];
  /** Global prefix — only honored when a single anonymous server is given. */
  mcpPrefix?: string;
}

async function ensureApiKey(): Promise<string> {
  const existing = loadApiKey();
  if (existing) return existing;

  if (!stdin.isTTY) {
    process.stderr.write(
      "DEEPSEEK_API_KEY is not set and stdin is not a TTY (cannot prompt).\n" +
        "Set the env var, or run `reasonix chat` once interactively to save a key.\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    "DeepSeek API key not configured.\nGet one at https://platform.deepseek.com/api_keys\n",
  );
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = (await rl.question("API key › ")).trim();
      if (!answer) continue;
      if (!isPlausibleKey(answer)) {
        process.stdout.write("Invalid format. Keys start with 'sk-' and are 30+ chars.\n");
        continue;
      }
      saveApiKey(answer);
      process.stdout.write(`Saved to ${defaultConfigPath()}\n\n`);
      return answer;
    }
  } finally {
    rl.close();
  }
}

export async function runCommand(opts: RunOptions): Promise<void> {
  loadDotenv();
  const apiKey = await ensureApiKey();
  process.env.DEEPSEEK_API_KEY = apiKey;

  // Optional MCP setup — mirrors chat's flow. Must happen before loop
  // construction so the tools make it into the prefix.
  const requestedSpecs = opts.mcp ?? [];
  const clients: McpClient[] = [];
  let tools: ToolRegistry | undefined;
  let successCount = 0;
  const disabledNames = new Set(readConfig().mcpDisabled ?? []);
  if (requestedSpecs.length > 0) {
    tools = new ToolRegistry();
    for (const raw of requestedSpecs) {
      let label = "anon";
      try {
        const spec = parseMcpSpec(raw);
        label = spec.name ?? "anon";
        if (spec.name && disabledNames.has(spec.name)) {
          process.stderr.write(`${formatMcpLifecycleEvent({ state: "disabled", name: label })}\n`);
          continue;
        }
        process.stderr.write(`${formatMcpLifecycleEvent({ state: "handshake", name: label })}\n`);
        const t0 = Date.now();
        const prefix = spec.name
          ? `${spec.name}_`
          : requestedSpecs.length === 1 && opts.mcpPrefix
            ? opts.mcpPrefix
            : "";
        const transport: McpTransport =
          spec.transport === "sse"
            ? new SseTransport({ url: spec.url })
            : spec.transport === "streamable-http"
              ? new StreamableHttpTransport({ url: spec.url })
              : new StdioTransport({ command: spec.command, args: spec.args });
        const mcp = new McpClient({ transport });
        await mcp.initialize();
        const bridge = await bridgeMcpTools(mcp, {
          registry: tools,
          namePrefix: prefix,
          serverName: label,
          onSlow: (info) =>
            process.stderr.write(
              `${formatMcpSlowToast({ name: info.serverName, p95Ms: info.p95Ms, sampleSize: info.sampleSize })}\n`,
            ),
        });
        process.stderr.write(
          `${formatMcpLifecycleEvent({
            state: "connected",
            name: label,
            tools: bridge.registeredNames.length,
            ms: Date.now() - t0,
          })}\n`,
        );
        clients.push(mcp);
        successCount++;
      } catch (err) {
        // Non-fatal — skip and continue, same as `reasonix chat`. A
        // one-shot `run` invocation with a broken MCP server otherwise
        // fails the whole run over a side-concern tool the task might
        // not even touch.
        process.stderr.write(
          `${formatMcpLifecycleEvent({ state: "failed", name: label, reason: (err as Error).message })}\n  → run \`reasonix setup\` to remove broken entries from your saved config.\n`,
        );
      }
    }
    if (successCount === 0) tools = undefined;
  }

  const client = new DeepSeekClient();
  const prefix = new ImmutablePrefix({
    system: opts.system,
    toolSpecs: tools?.specs(),
  });
  const loop = new CacheFirstLoop({
    client,
    prefix,
    tools,
    model: opts.model,
    harvest: opts.harvest,
    branch: opts.branch,
    budgetUsd: opts.budgetUsd,
  });
  const prefixHash = prefix.fingerprint;

  let transcriptStream: WriteStream | null = null;
  if (opts.transcript) {
    transcriptStream = openTranscriptFile(opts.transcript, {
      version: 1,
      source: "reasonix run",
      model: opts.model,
      startedAt: new Date().toISOString(),
    });
    // Also persist the user turn itself (the loop's event stream starts with
    // assistant output, not the prompt we're about to send).
    writeRecord(transcriptStream, {
      ts: new Date().toISOString(),
      turn: 1,
      role: "user",
      content: opts.task,
    });
  }

  try {
    for await (const ev of loop.step(opts.task)) {
      if (ev.role === "assistant_delta" && ev.content) process.stdout.write(ev.content);
      if (ev.role === "tool") process.stdout.write(`\n[tool ${ev.toolName}] ${ev.content}\n`);
      if (ev.role === "error") process.stderr.write(`\n[error] ${ev.error}\n`);
      if (ev.role === "done") process.stdout.write("\n");
      if (ev.role === "assistant_final" && ev.stats?.usage) {
        // `reasonix run` is often used in CI / scripting — we want
        // those turns to show up in `reasonix stats` too so the
        // dashboard reflects all DeepSeek spend, not just TUI sessions.
        appendUsage({ session: null, model: ev.stats.model, usage: ev.stats.usage });
      }
      // Persist every non-streaming event — deltas would flood the file and
      // aren't useful for replay (replay renders final content, not keystrokes).
      if (transcriptStream && ev.role !== "assistant_delta") {
        writeRecord(transcriptStream, recordFromLoopEvent(ev, { model: opts.model, prefixHash }));
      }
    }
  } finally {
    transcriptStream?.end();
  }

  const s = loop.stats.summary();
  process.stdout.write(
    `\n— turns:${s.turns} cache:${(s.cacheHitRatio * 100).toFixed(1)}% ` +
      `cost:$${s.totalCostUsd.toFixed(6)} save-vs-claude:${s.savingsVsClaudePct.toFixed(1)}%\n`,
  );
  if (opts.transcript) {
    process.stdout.write(`\ntranscript: ${opts.transcript}\n`);
    process.stdout.write(`  → npx reasonix replay ${opts.transcript}\n`);
  }

  for (const c of clients) await c.close();
}
