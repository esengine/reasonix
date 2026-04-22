/**
 * Stdio transport for MCP.
 *
 * MCP's stdio wire format is **newline-delimited JSON** (one JSON-RPC
 * message per line). We spawn the server as a child process, write
 * frames to its stdin, parse its stdout line-by-line as they arrive.
 *
 * Transport is abstracted behind an interface so unit tests can fake it
 * with an in-process duplex pair — spawning real servers in unit tests
 * is flaky and slow.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { JsonRpcMessage } from "./types.js";

/**
 * A transport sends JSON-RPC messages upstream and surfaces messages
 * arriving downstream via an async iterator. One instance per server
 * connection.
 */
export interface McpTransport {
  /** Send one JSON-RPC message. Resolves when the bytes are accepted. */
  send(message: JsonRpcMessage): Promise<void>;
  /** Async iterator over incoming messages. Ends when the connection closes. */
  messages(): AsyncIterableIterator<JsonRpcMessage>;
  /** Close the underlying resource (kill child process, close streams). */
  close(): Promise<void>;
}

export interface StdioTransportOptions {
  /** Argv to spawn. First element is the command. */
  command: string;
  args?: string[];
  /** Env overlay — merged over process.env unless replaceEnv=true. */
  env?: Record<string, string>;
  /** When true, only the env above is visible to the child. Default false. */
  replaceEnv?: boolean;
  /** CWD for the child. Default: process.cwd(). */
  cwd?: string;
}

/**
 * Spawn `command args...` as a child process and use its stdin/stdout as
 * an MCP transport. Stderr is forwarded to the parent's stderr so server
 * diagnostics are still visible.
 */
export class StdioTransport implements McpTransport {
  private readonly child: ChildProcess;
  private readonly queue: JsonRpcMessage[] = [];
  private readonly waiters: Array<(m: JsonRpcMessage | null) => void> = [];
  private closed = false;
  private stdoutBuffer = "";

  constructor(opts: StdioTransportOptions) {
    const env = opts.replaceEnv ? { ...(opts.env ?? {}) } : { ...process.env, ...(opts.env ?? {}) };
    this.child = spawn(opts.command, opts.args ?? [], {
      env,
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.on("close", () => this.onClose());
    this.child.on("error", (err) => {
      // Surface spawn errors as a synthetic JsonRpcError so callers don't
      // hang on a stream that never emits anything.
      this.push({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: `transport error: ${err.message}` },
      });
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("MCP transport is closed");
    return new Promise((resolve, reject) => {
      const line = `${JSON.stringify(message)}\n`;
      this.child.stdin!.write(line, "utf8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async *messages(): AsyncIterableIterator<JsonRpcMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<JsonRpcMessage | null>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next === null) return; // closed while we were waiting
      yield next;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Signal any pending waiters.
    while (this.waiters.length > 0) this.waiters.shift()!(null);
    try {
      this.child.stdin!.end();
    } catch {
      /* already ended */
    }
    if (this.child.exitCode === null && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  /** Parse incoming stdout chunks into NDJSON messages. */
  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIdx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic loop shape
    while ((newlineIdx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        this.push(msg);
      } catch {
        // Malformed lines are dropped — some servers emit startup banners
        // before the JSON-RPC loop begins. We surface the noise to stderr
        // via the inherited stderr stream, not our event queue.
      }
    }
  }

  private onClose(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }

  private push(msg: JsonRpcMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(msg);
    else this.queue.push(msg);
  }
}
