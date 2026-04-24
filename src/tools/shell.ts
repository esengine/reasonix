/**
 * Native shell tool — lets the model run commands inside the sandbox
 * root so it can actually verify its own work (run tests, check git
 * status, inspect a lockfile, etc.). Without this the coding-mode
 * loop is "write code, hope it works, ask the user to run it" —
 * defeats the purpose.
 *
 * Safety model:
 *   - Commands run with `cwd` pinned to the registered root. No
 *     path traversal via the command itself is enforced (users can
 *     `cat ../outside.txt`); the trust boundary is the directory
 *     you opened Reasonix from.
 *   - Commands are matched against a read-only / testing allowlist.
 *     Allowlisted commands execute immediately and return stdout +
 *     stderr merged. Everything else throws with a clear message —
 *     the UI translates that into an `/apply`-style confirm gate so
 *     the user sees the exact command before it runs.
 *   - Default timeout: 60s. Output cap: matches tool-result budget.
 *   - Every command that DOES run is spawned with `shell: false` and
 *     a tokenized argv — no string-to-shell interpolation, so the
 *     model can't accidentally construct a chained `rm` via quoting.
 *
 * This is intentionally narrower than what Claude Code / Aider ship:
 * we gate more commands behind confirmation by default. Users who
 * trust the model can widen the allowlist by instantiating their
 * own tool registry.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as pathMod from "node:path";
import type { ToolRegistry } from "../tools.js";
import { JobRegistry } from "./jobs.js";

export interface ShellToolsOptions {
  /** Directory to run commands in. Must be an absolute path. */
  rootDir: string;
  /** Seconds before an individual command is killed. Default: 60. */
  timeoutSec?: number;
  /**
   * Per-command stdout+stderr cap in characters. Default: 32_000 to
   * match the tool-result budget.
   */
  maxOutputChars?: number;
  /**
   * Extra command-name prefixes the user explicitly trusts. Added on
   * top of the built-in allowlist. Examples: `["my-ci-script", "lint"]`.
   *
   * Accepts either a fixed array (captured once at registration) or a
   * getter called on every dispatch. The getter form is load-bearing:
   * when the TUI's `ShellConfirm` writes a new prefix to config mid-
   * session, the running `run_command` must pick it up immediately —
   * otherwise the same command gets re-prompted until the next launch.
   */
  extraAllowed?: readonly string[] | (() => readonly string[]);
  /**
   * When true, skip the allowlist entirely and auto-run every command.
   * Off by default — this is an escape hatch for non-interactive use
   * (CI, benchmarks) where a human can't be in the loop to confirm.
   */
  allowAll?: boolean;
  /**
   * Background-process registry shared between `run_background`,
   * `job_output`, `stop_job`, `list_jobs`, and the /jobs /kill slashes.
   * When omitted, the registrar builds its own — but the caller
   * usually wants to provide one so the TUI can tail it too.
   */
  jobs?: JobRegistry;
}

const DEFAULT_TIMEOUT_SEC = 60;
const DEFAULT_MAX_OUTPUT_CHARS = 32_000;

/**
 * Command prefixes we consider safe to run without asking the user.
 * Rule of thumb: read-only reports, or test runners whose failure mode
 * is "exit 1 with output." Nothing that can rewrite state, escalate,
 * or touch the network.
 */
const BUILTIN_ALLOWLIST: ReadonlyArray<string> = [
  // Repo inspection
  "git status",
  "git diff",
  "git log",
  "git show",
  "git blame",
  "git branch",
  "git remote",
  "git rev-parse",
  "git config --get",
  // Filesystem inspection
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "tree",
  "find",
  "grep",
  "rg",
  // Language version probes
  "node --version",
  "node -v",
  "npm --version",
  "npx --version",
  "python --version",
  "python3 --version",
  "cargo --version",
  "go version",
  "rustc --version",
  "deno --version",
  "bun --version",
  // Test runners (non-destructive by convention)
  "npm test",
  "npm run test",
  "npx vitest run",
  "npx vitest",
  "npx jest",
  "pytest",
  "python -m pytest",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "go test",
  "go vet",
  "deno test",
  "bun test",
  // Linters / typecheckers (read-only by convention)
  "npm run lint",
  "npm run typecheck",
  "npx tsc --noEmit",
  "npx biome check",
  "npx eslint",
  "npx prettier --check",
  "ruff",
  "mypy",
];

/**
 * Tokenize a shell-ish command string into argv. Handles single/double
 * quoting; rejects unclosed quotes. Does NOT expand env vars, globs,
 * backticks, or `$(…)` — the goal is to prevent the model from
 * accidentally (or not) sneaking arbitrary shells past the allowlist
 * via concatenation. Exported for testing.
 */
export function tokenizeCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
        cur += cmd[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (quote) throw new Error(`unclosed ${quote} in command`);
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Scan `cmd` for a shell operator (`|`, `||`, `>`, `>>`, `<`, `<<`,
 * `&`, `&&`, `2>`, `2>>`, `2>&1`, `&>`) that appears unquoted at a
 * token boundary. Returns the operator string, or null if none.
 *
 * Why this exists: `run_command` documents "no shell expansion, no
 * pipes, no redirects" (the tool spawns argv directly, not through a
 * shell), but when the model writes `dir | findstr foo` the `|`
 * survives tokenization as a standalone token and gets quoted as the
 * literal string `"|"` by `quoteForCmdExe` — cmd.exe sees it as an
 * argument, not an operator, so the pipe silently fails. Detecting
 * operators up front lets us throw a clear error ("split into separate
 * calls") instead of letting the command run with surprising results.
 *
 * Quoted operators (`grep "a|b"`) and operator characters embedded in
 * larger tokens (`--flag=1&2`) are NOT flagged — those are literal
 * argv bytes and are safe to pass through.
 *
 * Exported for testing.
 */
export function detectShellOperator(cmd: string): string | null {
  const opPrefix = /^(?:2>&1|&>|\|{1,2}|&{1,2}|2>{1,2}|>{1,2}|<{1,2})/;
  let cur = "";
  let curQuoted = false;
  let quote: '"' | "'" | null = null;
  const check = (): string | null => {
    if (cur.length === 0 && !curQuoted) return null;
    if (!curQuoted) {
      const m = opPrefix.exec(cur);
      if (m) return m[0] ?? null;
    }
    return null;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
        cur += cmd[++i];
        curQuoted = true;
      } else {
        cur += ch;
        curQuoted = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      curQuoted = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      const op = check();
      if (op) return op;
      cur = "";
      curQuoted = false;
      continue;
    }
    cur += ch;
  }
  if (quote) return null; // let tokenizeCommand throw the unclosed-quote error
  return check();
}

/**
 * Return true when `cmd` matches an allowlisted prefix. Exported for
 * testing. Match is on the space-normalized leading tokens so
 * `git   status  -s ` and `git status` both match `git status`.
 */
export function isAllowed(cmd: string, extra: readonly string[] = []): boolean {
  const normalized = cmd.trim().replace(/\s+/g, " ");
  const allowlist = [...BUILTIN_ALLOWLIST, ...extra];
  for (const prefix of allowlist) {
    if (normalized === prefix) return true;
    if (normalized.startsWith(`${prefix} `)) return true;
  }
  return false;
}

export interface RunCommandResult {
  exitCode: number | null;
  /** Combined stdout+stderr, truncated to `maxOutputChars` with a marker. */
  output: string;
  /** True when the process was killed for exceeding `timeoutSec`. */
  timedOut: boolean;
}

export async function runCommand(
  cmd: string,
  opts: {
    cwd: string;
    timeoutSec?: number;
    maxOutputChars?: number;
    signal?: AbortSignal;
  },
): Promise<RunCommandResult> {
  const argv = tokenizeCommand(cmd);
  if (argv.length === 0) throw new Error("run_command: empty command");
  const operator = detectShellOperator(cmd);
  if (operator !== null) {
    throw new Error(
      `run_command: shell operator "${operator}" is not supported — this tool spawns one process, no shell expansion. Split into separate run_command calls and combine the output in your reasoning (e.g. instead of \`grep foo *.ts | wc -l\`, call \`grep -c foo *.ts\` or two separate commands). To pass "${operator}" as a literal argument, wrap it in quotes.`,
    );
  }
  const timeoutMs = (opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    shell: false, // no shell-expansion — see header comment
    windowsHide: true,
    env: process.env,
  };

  // Windows: two layered fixes on top of shell:false —
  //   1. Resolve bare command names via PATH × PATHEXT (CreateProcess
  //      ignores PATHEXT, so `npm` alone misses `npm.cmd`).
  //   2. Node 21.7.3+ (CVE-2024-27980) refuses to spawn `.cmd`/`.bat`
  //      directly even with shell:false and safe args — throws
  //      EINVAL at invocation time. Wrap those via `cmd.exe /d /s /c`
  //      with verbatim args + manual quoting, so shell metacharacters
  //      in arguments stay literal.
  // Unix path is unchanged.
  const { bin, args, spawnOverrides } = prepareSpawn(argv);
  const effectiveSpawnOpts = { ...spawnOpts, ...spawnOverrides };

  return await new Promise<RunCommandResult>((resolve, reject) => {
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn(bin, args, effectiveSpawnOpts);
    } catch (err) {
      reject(err);
      return;
    }
    let buf = "";
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      // Soft cap: we let the process keep running (killing early could
      // hide a real failure), but we stop growing the buffer past 2×
      // the cap so a chatty test can't OOM us.
      if (buf.length > maxChars * 2) buf = `${buf.slice(0, maxChars * 2)}`;
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      const output =
        buf.length > maxChars
          ? `${buf.slice(0, maxChars)}\n\n[… truncated ${buf.length - maxChars} chars …]`
          : buf;
      resolve({ exitCode: code, output, timedOut });
    });
  });
}

/**
 * Test/override hooks for {@link resolveExecutable}. Omitting any field
 * falls through to the real process globals — the runtime call path
 * uses defaults; tests inject `platform` + `env` + `isFile` to exercise
 * Windows-specific lookup from a Linux CI runner without touching
 * actual fs.
 */
export interface ResolveExecutableOptions {
  platform?: NodeJS.Platform;
  env?: { PATH?: string; PATHEXT?: string };
  /** Predicate swapped in by tests to avoid creating real files. */
  isFile?: (path: string) => boolean;
  /** Path.join used for the lookup. Defaults to Windows semantics on Windows. */
  pathDelimiter?: string;
}

/**
 * Resolve a bare command name (e.g. `npm`) to its on-disk path via
 * PATH × PATHEXT on Windows. Returns the input unchanged on non-Windows
 * platforms, when the input is already a path (contains `/`, `\`, or is
 * absolute), or when no match is found in PATH × PATHEXT (caller gets a
 * natural ENOENT from spawn, which surfaces cleanly).
 *
 * Why this exists: `child_process.spawn` with `shell: false` invokes
 * Windows `CreateProcess`, which does not honor `PATHEXT` and does not
 * search for `.cmd` / `.bat` wrappers. Node-ecosystem tools ship as
 * `npm.cmd`, `npx.cmd`, `yarn.cmd`, etc., so a bare `npm` fails with
 * ENOENT under `shell: false`. Flipping to `shell: true` would work
 * but reintroduces shell-expansion (pipes, redirects, chained cmds)
 * that the tool was explicitly designed to forbid. This resolver
 * threads the needle.
 */
export function resolveExecutable(cmd: string, opts: ResolveExecutableOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return cmd;
  if (!cmd) return cmd;
  // Already a path fragment — spawn handles these natively.
  if (cmd.includes("/") || cmd.includes("\\") || pathMod.isAbsolute(cmd)) return cmd;
  // If the model wrote `npm.cmd` explicitly, respect that verbatim.
  if (pathMod.extname(cmd)) return cmd;

  const env = opts.env ?? process.env;
  const pathExt = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const delimiter = opts.pathDelimiter ?? (platform === "win32" ? ";" : pathMod.delimiter);
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const isFile = opts.isFile ?? defaultIsFile;

  for (const dir of pathDirs) {
    for (const ext of pathExt) {
      // Force win32 join so CI tests that pass `platform: "win32"`
      // from a Linux runner get backslash-joined paths; the real-
      // Windows runtime path lands here too and gets the correct
      // separator regardless of where pathMod defaults.
      const full = pathMod.win32.join(dir, cmd + ext);
      if (isFile(full)) return full;
    }
  }
  return cmd;
}

function defaultIsFile(full: string): boolean {
  try {
    return existsSync(full) && statSync(full).isFile();
  } catch {
    return false;
  }
}

/**
 * Prepare `(bin, args, spawnOpts)` for the runCommand spawn call,
 * applying Windows-specific workarounds for (a) PATHEXT lookup and
 * (b) the CVE-2024-27980 prohibition on direct `.cmd`/`.bat` spawns.
 *
 * Exported so tests can assert the transformation without booting an
 * actual child process.
 */
export function prepareSpawn(
  argv: readonly string[],
  opts: ResolveExecutableOptions = {},
): { bin: string; args: string[]; spawnOverrides: SpawnOptions } {
  const head = argv[0] ?? "";
  const tail = argv.slice(1);
  const platform = opts.platform ?? process.platform;
  const resolved = resolveExecutable(head, opts);

  if (platform !== "win32") {
    return { bin: resolved, args: [...tail], spawnOverrides: {} };
  }

  // `.cmd` / `.bat` wrappers require cmd.exe on post-CVE Node.
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const cmdline = [resolved, ...tail].map(quoteForCmdExe).join(" ");
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", withUtf8Codepage(cmdline)],
      // windowsVerbatimArguments prevents Node from re-quoting the /c
      // payload — we've already composed an exact cmd.exe command
      // line. Without this Node wraps our already-quoted string in
      // another round of quotes and cmd.exe can't parse it.
      spawnOverrides: { windowsVerbatimArguments: true },
    };
  }

  // Bare command names that PATH × PATHEXT couldn't resolve to an
  // on-disk file — these are almost always cmd.exe built-ins (`dir`,
  // `echo`, `type`, `ver`, `vol`, `where`, `help`, …) which don't
  // exist as standalone executables. Direct spawn crashes with ENOENT;
  // routing through cmd.exe lets the built-in resolve, and if it's
  // genuinely unknown the user gets the standard "'foo' is not
  // recognized" message instead of a raw spawn failure.
  if (isBareWindowsName(resolved) && resolved === head) {
    const cmdline = [head, ...tail].map(quoteForCmdExe).join(" ");
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", withUtf8Codepage(cmdline)],
      spawnOverrides: { windowsVerbatimArguments: true },
    };
  }

  // PowerShell variants: chcp 65001 doesn't help here because PowerShell
  // sets its own [Console]::OutputEncoding at startup — usually system
  // codepage (CP936/CP932/CP949 on CJK Windows) or UTF-16. The result
  // is mojibake when our `chunk.toString()` UTF-8-decodes its stdout.
  // Inject a UTF-8 setup prelude into the `-Command` (or `-c`) arg so
  // any output produced thereafter is UTF-8.
  if (isPowerShellExe(resolved)) {
    const patched = injectPowerShellUtf8(tail);
    if (patched) {
      return { bin: resolved, args: patched, spawnOverrides: {} };
    }
  }

  return { bin: resolved, args: [...tail], spawnOverrides: {} };
}

/** Resolved bin path looks like Windows PowerShell or PowerShell Core. */
function isPowerShellExe(resolved: string): boolean {
  return /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(resolved);
}

/**
 * Locate `-Command` / `-c` in `args` and prepend the UTF-8 setup prelude
 * to its value. Returns the patched args, or `null` when no `-Command`
 * arg is present (in which case we leave the invocation untouched —
 * inline-expression and script-file modes have their own conventions
 * we don't want to silently rewrite).
 *
 * Why not always wrap: PowerShell's quoting semantics are finicky enough
 * that adding a prelude to a script file invocation could break it.
 * `-Command` is the case the model actually uses, and where mojibake
 * matters; targeting just it keeps the blast radius small.
 *
 * Exported for tests.
 */
export function injectPowerShellUtf8(args: readonly string[]): string[] | null {
  const prelude =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;";
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (/^-(?:Command|c)$/i.test(a) && i + 1 < args.length) {
      const out = [...args];
      out[i + 1] = `${prelude}${args[i + 1] ?? ""}`;
      return out;
    }
  }
  return null;
}

/**
 * Prefix a cmd.exe command line with `chcp 65001 >nul &` so output
 * (from cmd.exe and any child it spawns) is UTF-8-encoded. Without
 * this, on Chinese / Japanese / Korean Windows, `dir`, `findstr`,
 * `where`, etc. emit text in the system codepage (CP936, CP932,
 * CP949, …) and `chunk.toString()` — which decodes as UTF-8 — produces
 * garbled mojibake the model then sees as poisoned input on the next
 * turn.
 *
 * Scope: chcp affects ONLY this cmd.exe instance, which exits after
 * `/c`. No global console state changes. Single `&` (not `&&`) so the
 * command still runs even on the rare Windows builds where chcp
 * itself returns a non-zero exit (Win7 quirks; harmless on Win10+).
 *
 * Exported so tests can verify the wrapping shape.
 */
export function withUtf8Codepage(cmdline: string): string {
  return `chcp 65001 >nul & ${cmdline}`;
}

/**
 * True when `s` looks like a bare executable name — no path separator,
 * no drive letter, no extension. Such names on Windows, when absent
 * from PATH × PATHEXT, are almost always cmd.exe built-ins.
 */
function isBareWindowsName(s: string): boolean {
  if (!s) return false;
  if (s.includes("/") || s.includes("\\")) return false;
  if (pathMod.isAbsolute(s)) return false;
  if (pathMod.extname(s)) return false;
  return true;
}

/**
 * Quote an argument so cmd.exe parses it back as a single token. We
 * always wrap in double quotes when the arg contains whitespace or
 * any cmd.exe metacharacter, doubling embedded quotes per cmd.exe's
 * `""` escape rule. Bare alphanumeric args pass through unquoted for
 * readability in logs.
 *
 * Exported for test coverage of the quoting semantics.
 */
export function quoteForCmdExe(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^%(),;!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Error thrown by `run_command` when the command isn't allowlisted. */
export class NeedsConfirmationError extends Error {
  readonly command: string;
  constructor(command: string) {
    super(
      `run_command: "${command}" needs the user's approval before it runs. STOP calling tools now — the TUI has already prompted the user to press y (run) or n (deny). Wait for their next message; it will either be the command's output (if they approved) or an instruction to continue without it (if they denied). Don't retry the command or call other shell commands in the meantime.`,
    );
    this.name = "NeedsConfirmationError";
    this.command = command;
  }
}

export function registerShellTools(registry: ToolRegistry, opts: ShellToolsOptions): ToolRegistry {
  const rootDir = pathMod.resolve(opts.rootDir);
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const jobs = opts.jobs ?? new JobRegistry();
  // Resolved on every dispatch so newly-persisted "always allow"
  // prefixes take effect inside the session that added them, not just
  // on the next launch. Static arrays are wrapped into a constant
  // getter so the call site below is uniform.
  const getExtraAllowed: () => readonly string[] =
    typeof opts.extraAllowed === "function"
      ? opts.extraAllowed
      : (() => {
          const snapshot = opts.extraAllowed ?? [];
          return () => snapshot;
        })();
  const allowAll = opts.allowAll ?? false;

  registry.register({
    name: "run_command",
    description:
      "Run a shell command in the project root and return its combined stdout+stderr. Common read-only inspection and test/lint/typecheck commands run immediately; anything that could mutate state, install dependencies, or touch the network is refused until the user confirms it in the TUI. Prefer this over asking the user to run a command manually — after edits, run the project's tests to verify.",
    // Plan-mode gate: allow allowlisted commands through (git status,
    // cargo check, ls, grep …) so the model can actually investigate
    // during planning. Anything that would otherwise trigger a
    // confirmation prompt is treated as "not read-only" and bounced.
    readOnlyCheck: (args: { command?: unknown }) => {
      if (allowAll) return true;
      const cmd = typeof args?.command === "string" ? args.command.trim() : "";
      if (!cmd) return false;
      return isAllowed(cmd, getExtraAllowed());
    },
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'Full command line. Tokenized with POSIX-ish quoting; no shell expansion. Pipes (`|`), redirects (`>`, `<`, `2>`), and `&&`/`||` chaining are rejected with an error — split into separate calls instead. To pass an operator character as a literal argument (e.g. a regex), wrap it in quotes: `grep "a|b" file.txt`.',
        },
        timeoutSec: {
          type: "integer",
          description: `Override the default ${timeoutSec}s timeout for a single command.`,
        },
      },
      required: ["command"],
    },
    fn: async (args: { command: string; timeoutSec?: number }, ctx) => {
      const cmd = args.command.trim();
      if (!cmd) throw new Error("run_command: empty command");
      if (!allowAll && !isAllowed(cmd, getExtraAllowed())) {
        throw new NeedsConfirmationError(cmd);
      }
      const effectiveTimeout = Math.max(1, Math.min(600, args.timeoutSec ?? timeoutSec));
      const result = await runCommand(cmd, {
        cwd: rootDir,
        timeoutSec: effectiveTimeout,
        maxOutputChars,
        signal: ctx?.signal,
      });
      return formatCommandResult(cmd, result);
    },
  });

  registry.register({
    name: "run_background",
    description:
      "Spawn a long-running process (dev server, watcher, any command that doesn't naturally exit) and detach. Waits up to `waitSec` seconds for startup (or until the output matches a readiness signal like 'Local:', 'listening on', 'compiled successfully'), then returns the job id + startup preview. The process keeps running; call `job_output` to tail its logs, `stop_job` to kill it, `list_jobs` to see all running jobs. USE THIS — not `run_command` — for: npm/yarn/pnpm run dev, uvicorn / flask run, go run, cargo watch, tsc --watch, webpack serve, anything with 'dev' / 'serve' / 'watch' in the name.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Full command line. Same quoting rules as run_command (no pipes / redirects / chaining).",
        },
        waitSec: {
          type: "integer",
          description:
            "Max seconds to wait for startup before returning. 0..30, default 3. A ready-signal match short-circuits this.",
        },
      },
      required: ["command"],
    },
    fn: async (args: { command: string; waitSec?: number }, ctx) => {
      const cmd = args.command.trim();
      if (!cmd) throw new Error("run_background: empty command");
      if (!allowAll && !isAllowed(cmd, getExtraAllowed())) {
        throw new NeedsConfirmationError(cmd);
      }
      const result = await jobs.start(cmd, {
        cwd: rootDir,
        waitSec: args.waitSec,
        signal: ctx?.signal,
      });
      return formatJobStart(result);
    },
  });

  registry.register({
    name: "job_output",
    description:
      "Read the latest output of a background job started with `run_background`. By default returns the tail of the buffer (last 80 lines). Pass `since` (the `byteLength` from a previous call) to stream only new content incrementally. Tells you whether the job is still running, so you can stop polling when it's done.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "integer", description: "Job id returned by run_background." },
        since: {
          type: "integer",
          description: "Return only output written past this byte offset (for incremental polling).",
        },
        tailLines: {
          type: "integer",
          description: "Cap the returned slice to the last N lines. Default 80, 0 = unlimited.",
        },
      },
      required: ["jobId"],
    },
    fn: async (args: { jobId: number; since?: number; tailLines?: number }) => {
      const out = jobs.read(args.jobId, {
        since: args.since,
        tailLines: args.tailLines ?? 80,
      });
      if (!out) return `job ${args.jobId}: not found (use list_jobs)`;
      return formatJobRead(args.jobId, out);
    },
  });

  registry.register({
    name: "stop_job",
    description:
      "Stop a background job started with `run_background`. SIGTERM first; SIGKILL after a short grace period if it doesn't exit cleanly. Returns the final output + exit code. Safe to call on an already-exited job.",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "integer" },
      },
      required: ["jobId"],
    },
    fn: async (args: { jobId: number }) => {
      const rec = await jobs.stop(args.jobId);
      if (!rec) return `job ${args.jobId}: not found`;
      return formatJobStop(rec);
    },
  });

  registry.register({
    name: "list_jobs",
    description:
      "List every background job started this session — running and exited — with id, command, pid, status. Use when you've lost track of which job_id corresponds to which process, or to see what's still alive.",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    fn: async () => {
      const all = jobs.list();
      if (all.length === 0) return "(no background jobs started this session)";
      return all.map(formatJobRow).join("\n");
    },
  });

  return registry;
}

function formatJobStart(r: import("./jobs.js").JobStartResult): string {
  const header = r.stillRunning
    ? `[job ${r.jobId} started · pid ${r.pid ?? "?"} · ${r.readyMatched ? "READY signal matched" : "running (no ready signal yet)"}]`
    : r.exitCode !== null
      ? `[job ${r.jobId} exited during startup · exit ${r.exitCode}]`
      : `[job ${r.jobId} failed to start]`;
  return r.preview ? `${header}\n${r.preview}` : header;
}

function formatJobRead(jobId: number, r: import("./jobs.js").JobReadResult): string {
  const status = r.running
    ? `running · pid ${r.pid ?? "?"}`
    : r.exitCode !== null
      ? `exited ${r.exitCode}`
      : r.spawnError
        ? `failed (${r.spawnError})`
        : "stopped";
  const header = `[job ${jobId} · ${status} · byteLength=${r.byteLength}]\n$ ${r.command}`;
  return r.output ? `${header}\n${r.output}` : header;
}

function formatJobStop(r: import("./jobs.js").JobRecord): string {
  const running = r.running ? "still running (SIGKILL may be pending)" : `exit ${r.exitCode ?? "?"}`;
  const tail = tailLines(r.output, 40);
  const header = `[job ${r.id} stopped · ${running}]\n$ ${r.command}`;
  return tail ? `${header}\n${tail}` : header;
}

function formatJobRow(r: import("./jobs.js").JobRecord): string {
  const age = ((Date.now() - r.startedAt) / 1000).toFixed(1);
  const state = r.running
    ? `running   ·  pid ${r.pid ?? "?"}`
    : r.exitCode !== null
      ? `exit ${r.exitCode}`
      : r.spawnError
        ? `failed`
        : "stopped";
  return `  ${String(r.id).padStart(3)}  ${state.padEnd(24)}  ${age}s ago   $ ${r.command}`;
}

function tailLines(s: string, n: number): string {
  if (!s) return "";
  const lines = s.split("\n");
  if (lines.length <= n) return s;
  const dropped = lines.length - n;
  return [`[… ${dropped} earlier lines …]`, ...lines.slice(-n)].join("\n");
}

export function formatCommandResult(cmd: string, r: RunCommandResult): string {
  const header = r.timedOut
    ? `$ ${cmd}\n[killed after timeout]`
    : `$ ${cmd}\n[exit ${r.exitCode ?? "?"}]`;
  return r.output ? `${header}\n${r.output}` : header;
}
