/**
 * Long-running process registry — the "background run" counterpart to
 * `run_command`. `run_command` spawns a child, waits for it to exit,
 * then returns combined output; perfect for tests / builds / one-shots
 * but useless for `npm run dev` / `python -m http.server` / watchers,
 * which never exit and just time the tool out.
 *
 * JobRegistry lets the model fire-and-almost-forget: we spawn the
 * child, wait at most `waitSec` (default 3s) OR until output matches
 * a readiness regex, then return the startup preview plus a job id.
 * The child keeps running in the background; later tool calls tail
 * its output, stop it, or list what's still alive.
 *
 * Shape-wise this is modeled on Claude Code's `BashOutput` / `KillBash`
 * pair. We diverge on one point: ready-signal detection is on by default
 * because dev servers almost universally print "Local:", "listening on",
 * "ready in N ms", "compiled successfully" when they come up — short-
 * circuiting the wait on those keeps the model's first tool-result
 * useful ("server is up at http://localhost:5173") instead of spending
 * the full 3s on a stabilization timer.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import * as pathMod from "node:path";
import { detectShellOperator, prepareSpawn, tokenizeCommand } from "./shell.js";

/**
 * Kill an entire process tree rooted at `pid`.
 *
 * Why plain `child.kill(signal)` isn't enough:
 *   - Windows: Node maps signals to `TerminateProcess(handle)`, which
 *     only targets the direct child. `npm.cmd` spawned via cmd.exe
 *     launches `node`, which spawns Vite / Webpack / etc. Killing the
 *     npm wrapper leaves the whole JS server orphaned and still bound
 *     to the port. `taskkill /T /F /PID` walks the tree and terminates
 *     every descendant.
 *   - POSIX: a normal signal goes to the child process only. If we
 *     spawn with `detached:true` the child becomes a process-group
 *     leader; `process.kill(-pid, signal)` then reaches every process
 *     in that group, including grandchildren spawned after startup.
 *
 * Graceful vs forceful: SIGTERM gives the app a chance to cleanup; if
 * it ignores the signal we follow up with SIGKILL after a grace window
 * (handled by the caller, not here).
 */
function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    // taskkill: /T = tree, /F = force (TerminateProcess, no cleanup).
    // Graceful path still uses /F on Windows because there's no signal
    // in the POSIX sense — the closest equivalent is Ctrl+Break, which
    // is unreliable from another console. /F with /T is what most
    // process managers ship on Windows.
    const args = ["/pid", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      const killer = spawn("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
      });
      // Swallow ENOENT / EACCES — we did our best. Not awaiting is
      // intentional: taskkill can take a few hundred ms and the caller
      // already has its own deadline.
      killer.on("error", () => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
    return;
  }
  // POSIX: negative pid signals the whole process group. Requires the
  // spawn to have been detached (which `start()` does below).
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* group-kill failed — fall back to direct */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* ignore — already dead */
  }
}

/** Per-job output ring. Capped so a chatty dev server doesn't OOM. */
const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1024; // 64 KB

/**
 * Regexes that signal "the server is up / the watcher has stabilized."
 * Case-insensitive. Matched against the accumulated stdout+stderr; first
 * hit cuts the startup wait short. Patterns are conservative — false
 * positives waste nothing (we'd have returned at waitSec anyway), but
 * a false negative costs the model a real stall.
 */
const READY_SIGNALS: ReadonlyArray<RegExp> = [
  // HTTP server banners
  /\blistening on\b/i,
  /\blocal:\s+https?:\/\//i,
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b/i,
  /\b(?:ready|server started|started server|app listening)\b/i,
  // Bundlers / compilers
  /\bcompiled successfully\b/i,
  /\bbuild complete(?:d)?\b/i,
  /\bwatching for (?:file )?changes\b/i,
  /\bready in \d+/i,
  // Generic
  /\bstartup (?:complete|finished)\b/i,
];

export interface JobStartOptions {
  /** Absolute path to cwd for the spawned child. */
  cwd: string;
  /**
   * Max seconds to wait for the initial burst before returning. Capped
   * at 30. A ready-signal match short-circuits this. Default 3.
   */
  waitSec?: number;
  /** Signal plumbed through from the calling tool's AbortSignal. */
  signal?: AbortSignal;
  /** Total per-job output buffer cap (bytes). Default 64 KB. */
  maxBufferBytes?: number;
}

export interface JobStartResult {
  jobId: number;
  pid: number | null;
  /** True iff the child was still running at the point we returned. */
  stillRunning: boolean;
  /** True iff a READY_SIGNALS pattern matched during the wait window. */
  readyMatched: boolean;
  /** Preview of combined stdout+stderr accumulated during the wait. */
  preview: string;
  /** If the child exited during the wait, its exit code; else null. */
  exitCode: number | null;
}

export interface JobRecord {
  id: number;
  command: string;
  pid: number | null;
  startedAt: number;
  /** Exit code once the process terminates; null while running. */
  exitCode: number | null;
  /** Combined stdout+stderr, ring-trimmed. */
  output: string;
  /**
   * Total bytes ever written by the child (not just what's in `output`).
   * Useful for "how much got dropped" diagnostics.
   */
  totalBytesWritten: number;
  /** True iff the child is still alive. */
  running: boolean;
  /** Error from spawn() itself (ENOENT, etc.) once surfaced. */
  spawnError?: string;
}

export class JobRegistry {
  private readonly jobs = new Map<number, InternalJob>();
  private nextId = 1;

  /**
   * Spawn a background child. Resolves after `waitSec` OR on ready
   * signal OR on early exit, whichever comes first. The child continues
   * to run (and buffer output) regardless of which path fires.
   */
  async start(command: string, opts: JobStartOptions): Promise<JobStartResult> {
    const trimmed = command.trim();
    if (!trimmed) throw new Error("run_background: empty command");
    const op = detectShellOperator(trimmed);
    if (op !== null) {
      throw new Error(
        `run_background: shell operator "${op}" is not supported — spawn one process per background job. Compose via your orchestration, not the shell.`,
      );
    }
    const argv = tokenizeCommand(trimmed);
    if (argv.length === 0) throw new Error("run_background: empty command");
    const waitMs = Math.max(0, Math.min(30, opts.waitSec ?? 3)) * 1000;
    const maxBytes = opts.maxBufferBytes ?? DEFAULT_OUTPUT_CAP_BYTES;

    const { bin, args, spawnOverrides } = prepareSpawn(argv);
    const spawnOpts: SpawnOptions = {
      cwd: pathMod.resolve(opts.cwd),
      shell: false,
      windowsHide: true,
      env: process.env,
      // POSIX: detach so the child becomes its own process-group leader.
      // Required for `process.kill(-pid, …)` later — without it a group
      // kill fails and we end up only signaling the wrapper, leaving
      // grandchildren (node → vite → esbuild …) orphaned.
      // Windows: detached would spawn a new console window; leave the
      // default and use taskkill /T for tree termination.
      detached: process.platform !== "win32",
      ...spawnOverrides,
    };

    let child: ChildProcess;
    try {
      child = spawn(bin, args, spawnOpts);
    } catch (err) {
      // Can't even spawn — record a dead job so the model sees the
      // failure in list_jobs, and return a synthetic result.
      const id = this.nextId++;
      const job: InternalJob = {
        id,
        command: trimmed,
        pid: null,
        startedAt: Date.now(),
        exitCode: null,
        output: `[spawn failed] ${(err as Error).message}`,
        totalBytesWritten: 0,
        running: false,
        spawnError: (err as Error).message,
        child: null,
        readyPromise: Promise.resolve(),
        signalReady: () => {},
      };
      this.jobs.set(id, job);
      return {
        jobId: id,
        pid: null,
        stillRunning: false,
        readyMatched: false,
        preview: job.output,
        exitCode: null,
      };
    }

    const id = this.nextId++;
    let readyResolve: () => void = () => {};
    const readyPromise = new Promise<void>((res) => {
      readyResolve = res;
    });
    const job: InternalJob = {
      id,
      command: trimmed,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      exitCode: null,
      output: "",
      totalBytesWritten: 0,
      running: true,
      child,
      readyPromise,
      signalReady: readyResolve,
    };
    this.jobs.set(id, job);

    let readyMatched = false;
    const onData = (chunk: Buffer | string) => {
      const s = chunk.toString();
      job.totalBytesWritten += s.length;
      job.output += s;
      if (job.output.length > maxBytes) {
        // Drop the oldest bytes, but keep a marker so the model can see
        // output was truncated. Trim on a rough line boundary to avoid
        // chopping a line mid-sentence.
        const overflow = job.output.length - maxBytes;
        const cut = job.output.indexOf("\n", overflow);
        const start = cut >= 0 ? cut + 1 : overflow;
        job.output = `[… older output dropped …]\n${job.output.slice(start)}`;
      }
      if (!readyMatched) {
        for (const re of READY_SIGNALS) {
          if (re.test(s) || re.test(job.output)) {
            readyMatched = true;
            job.signalReady();
            break;
          }
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      job.running = false;
      job.spawnError = err.message;
      job.signalReady();
    });
    child.on("close", (code) => {
      job.running = false;
      job.exitCode = code;
      job.signalReady();
    });

    const onAbort = () => this.stop(id, { graceMs: 100 });
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // Race: (a) ready signal, (b) child exit, (c) wait deadline.
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      readyPromise,
      new Promise<void>((res) => {
        timer = setTimeout(res, waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    return {
      jobId: id,
      pid: job.pid,
      stillRunning: job.running,
      readyMatched,
      preview: job.output,
      exitCode: job.exitCode,
    };
  }

  /**
   * Read a job's accumulated output. `since` lets a caller poll
   * incrementally: pass the byte count returned from the last call to
   * get only newly-written content. Returns both full output and a
   * running snapshot so the caller can use whichever.
   */
  read(id: number, opts: { since?: number; tailLines?: number } = {}): JobReadResult | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const full = job.output;
    let slice = full;
    if (typeof opts.since === "number" && opts.since >= 0 && opts.since < full.length) {
      slice = full.slice(opts.since);
    }
    if (typeof opts.tailLines === "number" && opts.tailLines > 0) {
      const lines = slice.split("\n");
      const keep = lines.slice(Math.max(0, lines.length - opts.tailLines));
      slice = keep.join("\n");
    }
    return {
      output: slice,
      byteLength: full.length,
      running: job.running,
      exitCode: job.exitCode,
      command: job.command,
      pid: job.pid,
      spawnError: job.spawnError,
    };
  }

  /**
   * Send SIGTERM, wait `graceMs`, then SIGKILL if still alive. Returns
   * the final job record (or null when the job id is unknown). Safe to
   * call on an already-exited job — returns the record unchanged.
   */
  async stop(id: number, opts: { graceMs?: number } = {}): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!job.running || !job.child) return snapshot(job);
    const graceMs = Math.max(0, opts.graceMs ?? 2000);
    // Tree kill — reaches grandchildren (vite, esbuild, etc.) instead
    // of just the npm/cmd.exe wrapper that our direct child represents.
    // Falls back to child.kill() only when we somehow don't have a pid.
    if (job.pid !== null) {
      killProcessTree(job.pid, "SIGTERM");
    } else {
      try {
        job.child.kill("SIGTERM");
      } catch {
        /* already dead — fall through */
      }
    }
    // Wait for the close event or graceMs, then SIGKILL.
    await Promise.race([
      job.readyPromise,
      new Promise<void>((res) => setTimeout(res, graceMs)),
    ]);
    if (job.running) {
      if (job.pid !== null) {
        killProcessTree(job.pid, "SIGKILL");
      } else {
        try {
          job.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      // Give the OS a moment to reap the tree so our exitCode field
      // catches it before we return. Windows taskkill can take up to
      // ~700ms to propagate on a three-level tree (npm → node → vite).
      await new Promise<void>((res) => setTimeout(res, 800));
    }
    return snapshot(job);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map(snapshot);
  }

  /**
   * Best-effort kill of every still-running job. Called on TUI shutdown
   * so dev servers don't outlive the Reasonix process. Resolves after
   * every child has closed or a hard deadline passes (3s total).
   */
  async shutdown(deadlineMs = 5000): Promise<void> {
    const start = Date.now();
    const runningJobs = [...this.jobs.values()].filter((j) => j.running && j.child);
    if (runningJobs.length === 0) return;

    for (const job of runningJobs) {
      if (job.pid !== null) killProcessTree(job.pid, "SIGTERM");
      else
        try {
          job.child?.kill("SIGTERM");
        } catch {
          /* ignore */
        }
    }
    const allClose = Promise.all(runningJobs.map((j) => j.readyPromise));
    const elapsed = () => Date.now() - start;
    // Grace window: give well-behaved apps time to clean up, capped at
    // half the deadline so we always leave room for a SIGKILL pass +
    // reap confirmation.
    const graceMs = Math.min(1500, Math.max(0, deadlineMs / 2));
    await Promise.race([
      allClose,
      new Promise<void>((res) => setTimeout(res, graceMs)),
    ]);
    // Force-kill everything still alive.
    for (const job of runningJobs) {
      if (!job.running) continue;
      if (job.pid !== null) killProcessTree(job.pid, "SIGKILL");
      else
        try {
          job.child?.kill("SIGKILL");
        } catch {
          /* ignore */
        }
    }
    // Wait for close events post-SIGKILL. taskkill /T on Windows is
    // async — without this final wait, shutdown() can return while
    // grandchildren are still mid-teardown, which is what "runningCount
    // non-zero after shutdown" looks like.
    const remaining = Math.max(800, deadlineMs - elapsed());
    await Promise.race([
      allClose,
      new Promise<void>((res) => setTimeout(res, remaining)),
    ]);
  }

  /** Count of still-running jobs — drives the TUI status-bar indicator. */
  runningCount(): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.running) n++;
    return n;
  }
}

interface InternalJob extends JobRecord {
  /** Underlying Node child process. Null only on spawn failure. */
  child: ChildProcess | null;
  /** Resolved when ready-signal fires OR the child exits. */
  readyPromise: Promise<void>;
  /** Fires readyPromise — called by ready-signal OR close/error handlers. */
  signalReady: () => void;
}

export interface JobReadResult {
  output: string;
  /** Total bytes ever in the buffer (pre-slice). Caller passes back as `since`. */
  byteLength: number;
  running: boolean;
  exitCode: number | null;
  command: string;
  pid: number | null;
  spawnError?: string;
}

function snapshot(job: InternalJob): JobRecord {
  return {
    id: job.id,
    command: job.command,
    pid: job.pid,
    startedAt: job.startedAt,
    exitCode: job.exitCode,
    output: job.output,
    totalBytesWritten: job.totalBytesWritten,
    running: job.running,
    spawnError: job.spawnError,
  };
}
