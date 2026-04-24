import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import {
  NeedsConfirmationError,
  detectShellOperator,
  formatCommandResult,
  injectPowerShellUtf8,
  isAllowed,
  prepareSpawn,
  quoteForCmdExe,
  registerShellTools,
  resolveExecutable,
  runCommand,
  tokenizeCommand,
} from "../src/tools/shell.js";

describe("tokenizeCommand", () => {
  it("splits on whitespace", () => {
    expect(tokenizeCommand("git status -s")).toEqual(["git", "status", "-s"]);
  });

  it("keeps double-quoted spans as single tokens", () => {
    expect(tokenizeCommand('grep "hello world" src')).toEqual(["grep", "hello world", "src"]);
  });

  it("keeps single-quoted spans as single tokens (literal, no backslash escapes)", () => {
    expect(tokenizeCommand("echo 'a \\\\ b'")).toEqual(["echo", "a \\\\ b"]);
  });

  it("supports \\ escapes inside double quotes", () => {
    expect(tokenizeCommand('echo "a \\"b\\" c"')).toEqual(["echo", 'a "b" c']);
  });

  it("rejects unclosed quotes", () => {
    expect(() => tokenizeCommand('grep "unclosed')).toThrow(/unclosed/);
    expect(() => tokenizeCommand("grep 'unclosed")).toThrow(/unclosed/);
  });

  it("collapses runs of whitespace", () => {
    expect(tokenizeCommand("   git   status   ")).toEqual(["git", "status"]);
  });

  it("returns an empty array for an empty command", () => {
    expect(tokenizeCommand("")).toEqual([]);
    expect(tokenizeCommand("   ")).toEqual([]);
  });
});

describe("detectShellOperator", () => {
  it("flags a standalone pipe", () => {
    expect(detectShellOperator("dir /b *.ts | findstr foo")).toBe("|");
  });

  it("flags standalone redirects (>, >>, <, <<)", () => {
    expect(detectShellOperator("echo hi > out.txt")).toBe(">");
    expect(detectShellOperator("echo hi >> out.txt")).toBe(">>");
    expect(detectShellOperator("sort < in.txt")).toBe("<");
    expect(detectShellOperator("cat << EOF")).toBe("<<");
  });

  it("flags &&, ||, and single &", () => {
    expect(detectShellOperator("a && b")).toBe("&&");
    expect(detectShellOperator("a || b")).toBe("||");
    expect(detectShellOperator("long_task &")).toBe("&");
  });

  it("flags fd-prefixed redirects", () => {
    expect(detectShellOperator("cmd 2> err.log")).toBe("2>");
    expect(detectShellOperator("cmd 2>> err.log")).toBe("2>>");
    expect(detectShellOperator("cmd 2>&1")).toBe("2>&1");
    expect(detectShellOperator("cmd &> all.log")).toBe("&>");
  });

  it("flags redirects stuck to the next token", () => {
    expect(detectShellOperator("echo hi >out.txt")).toBe(">");
    expect(detectShellOperator("sort <in.txt")).toBe("<");
  });

  it("does NOT flag operators inside double quotes", () => {
    expect(detectShellOperator('grep "a|b" file.txt')).toBeNull();
    expect(detectShellOperator('echo "a > b"')).toBeNull();
    expect(detectShellOperator('git commit -m "feat & fix"')).toBeNull();
  });

  it("does NOT flag operators inside single quotes", () => {
    expect(detectShellOperator("grep 'a|b' file.txt")).toBeNull();
    expect(detectShellOperator("awk '{print $1 > $2}' file")).toBeNull();
  });

  it("does NOT flag operator characters embedded in larger unquoted tokens", () => {
    // `--flag=1&2` is a single token; the `&` is a literal byte, not a
    // shell operator. Same for regex-style args passed without quotes.
    expect(detectShellOperator("cargo run -- --flag=1&2")).toBeNull();
    expect(detectShellOperator("grep a|b file")).toBeNull();
  });

  it("returns null for plain commands", () => {
    expect(detectShellOperator("git status")).toBeNull();
    expect(detectShellOperator("ls -la")).toBeNull();
    expect(detectShellOperator("")).toBeNull();
  });

  it("returns the FIRST operator when multiple are present", () => {
    expect(detectShellOperator("a | b > c")).toBe("|");
  });
});

describe("runCommand pipe/redirect rejection", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-shell-pipe-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects a pipe command with a helpful error", async () => {
    await expect(runCommand("echo hi | cat", { cwd: tmp })).rejects.toThrow(
      /shell operator "\|" is not supported/,
    );
  });

  it("rejects a redirect command with a helpful error", async () => {
    await expect(runCommand("echo hi > out.txt", { cwd: tmp })).rejects.toThrow(
      /shell operator ">" is not supported/,
    );
  });

  it("error message points the model at splitting the call", async () => {
    try {
      await runCommand("a && b", { cwd: tmp });
    } catch (err) {
      expect((err as Error).message).toMatch(/Split into separate run_command calls/i);
      return;
    }
    throw new Error("expected runCommand to reject");
  });
});

describe("isAllowed", () => {
  it("matches exact prefix and prefix+args", () => {
    expect(isAllowed("git status")).toBe(true);
    expect(isAllowed("git status -s")).toBe(true);
    expect(isAllowed("git statuses")).toBe(false); // no trailing space → not a prefix match
  });

  it("normalizes internal whitespace", () => {
    expect(isAllowed("git   status   -s")).toBe(true);
  });

  it("rejects mutating operations not on the list", () => {
    expect(isAllowed("git commit -m hi")).toBe(false);
    expect(isAllowed("npm install lodash")).toBe(false);
    expect(isAllowed("rm -rf dist")).toBe(false);
    expect(isAllowed("curl http://example.com")).toBe(false);
  });

  it("accepts test-runner commands", () => {
    expect(isAllowed("pytest tests/")).toBe(true);
    expect(isAllowed("cargo test --release")).toBe(true);
    expect(isAllowed("npm test")).toBe(true);
  });

  it("respects extra allowed prefixes", () => {
    expect(isAllowed("my-lint src/")).toBe(false);
    expect(isAllowed("my-lint src/", ["my-lint"])).toBe(true);
  });
});

describe("runCommand", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-shell-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("captures stdout and reports exit 0 on success", async () => {
    // `node -e '...'` is cross-platform; avoids cmd/bash differences.
    const r = await runCommand("node -e \"process.stdout.write('hello')\"", { cwd: tmp });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("hello");
    expect(r.timedOut).toBe(false);
  });

  it("captures stderr and reports non-zero exit on failure", async () => {
    const r = await runCommand("node -e \"process.stderr.write('oops'); process.exit(2)\"", {
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("oops");
  });

  it("runs inside the given cwd, not the test's cwd", async () => {
    writeFileSync(join(tmp, "marker.txt"), "present");
    const r = await runCommand(
      "node -e \"const fs=require('fs');process.stdout.write(fs.readFileSync('marker.txt','utf8'))\"",
      { cwd: tmp },
    );
    expect(r.output).toContain("present");
  });

  it("kills a command that exceeds the timeout", async () => {
    // Sleep longer than timeout; 500ms sleep, 100ms timeout.
    const r = await runCommand('node -e "setTimeout(()=>{},5000)"', {
      cwd: tmp,
      timeoutSec: 0.1 as unknown as number, // cast: the function accepts seconds; 0.1s = 100ms
    });
    expect(r.timedOut).toBe(true);
  });

  it("truncates long output with a marker", async () => {
    const r = await runCommand("node -e \"process.stdout.write('x'.repeat(50000))\"", {
      cwd: tmp,
      maxOutputChars: 1000,
    });
    expect(r.output).toMatch(/\[… truncated \d+ chars …\]$/);
  });

  it("rejects empty commands", async () => {
    await expect(runCommand("", { cwd: tmp })).rejects.toThrow(/empty command/);
  });

  it("rejects commands with unclosed quotes", async () => {
    await expect(runCommand('echo "unclosed', { cwd: tmp })).rejects.toThrow(/unclosed/);
  });
});

describe("registerShellTools — dispatch integration", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-shell-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registers run_command + background tools", () => {
    const registry = new ToolRegistry();
    registerShellTools(registry, { rootDir: tmp });
    // run_command (sync) + run_background / job_output / stop_job /
    // list_jobs (background family).
    expect(registry.size).toBe(5);
    expect(registry.has("run_command")).toBe(true);
    expect(registry.has("run_background")).toBe(true);
    expect(registry.has("job_output")).toBe(true);
    expect(registry.has("stop_job")).toBe(true);
    expect(registry.has("list_jobs")).toBe(true);
  });

  it("auto-runs allowlisted commands and returns formatted output", async () => {
    const registry = new ToolRegistry();
    registerShellTools(registry, { rootDir: tmp, extraAllowed: ["node"] });
    const out = await registry.dispatch(
      "run_command",
      JSON.stringify({ command: "node --version" }),
    );
    expect(out).toMatch(/\$ node --version/);
    expect(out).toMatch(/\[exit 0\]/);
  });

  it("refuses non-allowlisted commands with NeedsConfirmationError", async () => {
    const registry = new ToolRegistry();
    registerShellTools(registry, { rootDir: tmp });
    const out = await registry.dispatch(
      "run_command",
      JSON.stringify({ command: "rm -rf node_modules" }),
    );
    expect(out).toMatch(/NeedsConfirmationError/);
    expect(out).toMatch(/rm -rf node_modules/);
  });

  it("allowAll:true bypasses the allowlist entirely", async () => {
    const registry = new ToolRegistry();
    registerShellTools(registry, { rootDir: tmp, allowAll: true, extraAllowed: [] });
    const out = await registry.dispatch(
      "run_command",
      JSON.stringify({ command: "node -e \"process.stdout.write('ok')\"" }),
    );
    expect(out).toMatch(/\[exit 0\]/);
    expect(out).toContain("ok");
  });

  it("extraAllowed as a getter is re-read on every dispatch", async () => {
    // Regression: picking "always allow" in ShellConfirm wrote to disk
    // but the running run_command captured a stale snapshot, so the
    // same command got re-prompted until the next launch. Getter form
    // fixes this by re-resolving the allowlist on each call.
    //
    // `node -e` is deliberately NOT in BUILTIN_ALLOWLIST — only
    // `node --version` / `node -v` are — so the "before" call must go
    // through the extraAllowed path to succeed.
    const cmd = "node -e \"process.stdout.write('ok')\"";
    const registry = new ToolRegistry();
    const list: string[] = [];
    registerShellTools(registry, { rootDir: tmp, extraAllowed: () => list });

    const before = await registry.dispatch("run_command", JSON.stringify({ command: cmd }));
    expect(before).toMatch(/NeedsConfirmationError/);

    // Simulate the TUI's "always allow" click — mutate the source the
    // getter reads. No re-registration; the live tool instance picks
    // it up.
    list.push("node -e");

    const after = await registry.dispatch("run_command", JSON.stringify({ command: cmd }));
    expect(after).not.toMatch(/NeedsConfirmationError/);
    expect(after).toMatch(/\[exit 0\]/);
    expect(after).toContain("ok");
  });
});

describe("formatCommandResult", () => {
  it("marks the exit code on success", () => {
    expect(formatCommandResult("ls", { exitCode: 0, output: "a\nb", timedOut: false })).toBe(
      "$ ls\n[exit 0]\na\nb",
    );
  });

  it("marks a killed-on-timeout run", () => {
    expect(formatCommandResult("sleep 10", { exitCode: null, output: "", timedOut: true })).toBe(
      "$ sleep 10\n[killed after timeout]",
    );
  });

  it("elides the body when output is empty", () => {
    expect(formatCommandResult("true", { exitCode: 0, output: "", timedOut: false })).toBe(
      "$ true\n[exit 0]",
    );
  });
});

describe("resolveExecutable", () => {
  it("returns the input unchanged on non-Windows platforms", () => {
    expect(resolveExecutable("npm", { platform: "linux" })).toBe("npm");
    expect(resolveExecutable("pytest", { platform: "darwin" })).toBe("pytest");
  });

  it("returns empty input unchanged", () => {
    expect(resolveExecutable("", { platform: "win32" })).toBe("");
  });

  it("walks PATH × PATHEXT on Windows and returns the first hit", () => {
    // PATHEXT case is preserved into the joined path, so the mock
    // "filesystem" keys must match that case verbatim.
    const hits = new Set(["C:\\tools\\npm.CMD"]);
    const out = resolveExecutable("npm", {
      platform: "win32",
      env: { PATH: "C:\\nope;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      pathDelimiter: ";",
      isFile: (p) => hits.has(p),
    });
    expect(out).toBe("C:\\tools\\npm.CMD");
  });

  it("honors PATHEXT ordering (.EXE beats .CMD when both exist)", () => {
    const hits = new Set(["C:\\bin\\foo.EXE", "C:\\bin\\foo.CMD"]);
    const out = resolveExecutable("foo", {
      platform: "win32",
      env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      pathDelimiter: ";",
      isFile: (p) => hits.has(p),
    });
    expect(out).toBe("C:\\bin\\foo.EXE");
  });

  it("falls back to the raw cmd when PATH × PATHEXT yields nothing", () => {
    const out = resolveExecutable("doesnotexist", {
      platform: "win32",
      env: { PATH: "C:\\bin", PATHEXT: ".EXE" },
      pathDelimiter: ";",
      isFile: () => false,
    });
    expect(out).toBe("doesnotexist");
  });

  it("skips lookup for absolute paths (\\ or /)", () => {
    const called: string[] = [];
    const out1 = resolveExecutable("C:\\tools\\npm.cmd", {
      platform: "win32",
      env: { PATH: "C:\\bin", PATHEXT: ".CMD" },
      isFile: (p) => {
        called.push(p);
        return true;
      },
    });
    expect(out1).toBe("C:\\tools\\npm.cmd");
    const out2 = resolveExecutable("src/tool.js", {
      platform: "win32",
      env: { PATH: "C:\\bin", PATHEXT: ".CMD" },
      isFile: () => true,
    });
    expect(out2).toBe("src/tool.js");
    expect(called).toEqual([]);
  });

  it("skips lookup when the cmd already has an extension", () => {
    const called: string[] = [];
    const out = resolveExecutable("npm.cmd", {
      platform: "win32",
      env: { PATH: "C:\\bin", PATHEXT: ".CMD" },
      isFile: (p) => {
        called.push(p);
        return true;
      },
    });
    expect(out).toBe("npm.cmd");
    expect(called).toEqual([]);
  });

  it("tolerates missing PATH / PATHEXT — returns cmd unchanged", () => {
    const out = resolveExecutable("npm", {
      platform: "win32",
      env: {},
      pathDelimiter: ";",
      isFile: () => false,
    });
    expect(out).toBe("npm");
  });

  it("handles whitespace inside PATHEXT entries (' .CMD ' → '.CMD')", () => {
    const hits = new Set(["C:\\bin\\npm.CMD"]);
    const out = resolveExecutable("npm", {
      platform: "win32",
      env: { PATH: "C:\\bin", PATHEXT: " .CMD ; .EXE " },
      pathDelimiter: ";",
      isFile: (p) => hits.has(p),
    });
    expect(out).toBe("C:\\bin\\npm.CMD");
  });
});

describe("quoteForCmdExe", () => {
  it("leaves simple identifiers alone", () => {
    expect(quoteForCmdExe("install")).toBe("install");
    expect(quoteForCmdExe("foo-bar_123")).toBe("foo-bar_123");
  });

  it("double-quotes whitespace and cmd metacharacters", () => {
    expect(quoteForCmdExe("hello world")).toBe('"hello world"');
    expect(quoteForCmdExe("a&b")).toBe('"a&b"');
    expect(quoteForCmdExe("a|b")).toBe('"a|b"');
    expect(quoteForCmdExe("a>b")).toBe('"a>b"');
    expect(quoteForCmdExe("a<b")).toBe('"a<b"');
    expect(quoteForCmdExe("a^b")).toBe('"a^b"');
    expect(quoteForCmdExe("a;b")).toBe('"a;b"');
  });

  it("doubles embedded quotes (cmd.exe escape rule)", () => {
    expect(quoteForCmdExe('say "hi"')).toBe('"say ""hi"""');
  });

  it("empty string becomes an explicit empty-pair", () => {
    expect(quoteForCmdExe("")).toBe('""');
  });

  it("round-trips `npm install foo` safely", () => {
    const argv = ["C:\\Program Files\\nodejs\\npm.cmd", "install", "foo"];
    const cmdline = argv.map(quoteForCmdExe).join(" ");
    expect(cmdline).toBe('"C:\\Program Files\\nodejs\\npm.cmd" install foo');
  });
});

describe("prepareSpawn", () => {
  it("passes through unchanged on non-Windows", () => {
    const out = prepareSpawn(["npm", "install"], { platform: "linux" });
    expect(out.bin).toBe("npm");
    expect(out.args).toEqual(["install"]);
    expect(out.spawnOverrides).toEqual({});
  });

  it("wraps .cmd files through cmd.exe on Windows (post-CVE-2024-27980)", () => {
    // Real-world install path with a space → quoting required.
    const hits = new Set(["C:\\Program Files\\nodejs\\npm.CMD"]);
    const out = prepareSpawn(["npm", "install", "foo"], {
      platform: "win32",
      env: { PATH: "C:\\Program Files\\nodejs", PATHEXT: ".EXE;.CMD" },
      pathDelimiter: ";",
      isFile: (p) => hits.has(p),
    });
    expect(out.bin).toBe("cmd.exe");
    expect(out.args).toEqual([
      "/d",
      "/s",
      "/c",
      'chcp 65001 >nul & "C:\\Program Files\\nodejs\\npm.CMD" install foo',
    ]);
    expect(out.spawnOverrides.windowsVerbatimArguments).toBe(true);
  });

  it("wraps .cmd files without quoting when the resolved path has no metacharacters", () => {
    const hits = new Set(["C:\\tools\\npm.CMD"]);
    const out = prepareSpawn(["npm", "install"], {
      platform: "win32",
      env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
      pathDelimiter: ";",
      isFile: (p) => hits.has(p),
    });
    // No spaces in the path ⇒ no surrounding quotes; cmd.exe parses
    // backslashes literally. UTF-8 codepage prefix is always inserted.
    expect(out.args[3]).toBe("chcp 65001 >nul & C:\\tools\\npm.CMD install");
  });

  it("wraps .bat files too", () => {
    const hits = new Set(["C:\\bin\\gradle.BAT"]);
    const out = prepareSpawn(["gradle", "build"], {
      platform: "win32",
      env: { PATH: "C:\\bin", PATHEXT: ".BAT" },
      pathDelimiter: ";",
      isFile: (p) => hits.has(p),
    });
    expect(out.bin).toBe("cmd.exe");
    expect(out.args[3]).toMatch(/^chcp 65001 >nul & .*gradle\.BAT/);
  });

  it("spawns .exe directly (no cmd.exe wrapping)", () => {
    const hits = new Set(["C:\\Program Files\\nodejs\\node.EXE"]);
    const out = prepareSpawn(["node", "--version"], {
      platform: "win32",
      env: { PATH: "C:\\Program Files\\nodejs", PATHEXT: ".EXE;.CMD" },
      pathDelimiter: ";",
      isFile: (p) => hits.has(p),
    });
    expect(out.bin).toBe("C:\\Program Files\\nodejs\\node.EXE");
    expect(out.args).toEqual(["--version"]);
    expect(out.spawnOverrides).toEqual({});
  });

  it("cmd.exe-wrapping quotes args containing metacharacters", () => {
    const hits = new Set(["C:\\tools\\tool.CMD"]);
    const out = prepareSpawn(["tool", "a&b", "c|d"], {
      platform: "win32",
      env: { PATH: "C:\\tools", PATHEXT: ".CMD" },
      pathDelimiter: ";",
      isFile: (p) => hits.has(p),
    });
    expect(out.args[3]).toBe('chcp 65001 >nul & C:\\tools\\tool.CMD "a&b" "c|d"');
  });

  it("routes bare unresolved Windows commands through cmd.exe (builtins)", () => {
    // `dir`, `echo`, `type`, `ver`, … are cmd.exe built-ins — they
    // don't exist as standalone exes, so PATHEXT lookup misses and a
    // direct spawn ENOENTs. Wrapping in cmd.exe lets them resolve,
    // and gives unknown commands a proper "'x' is not recognized"
    // exit code instead of a raw spawn failure.
    const out = prepareSpawn(["dir", ".reasonix"], {
      platform: "win32",
      env: { PATH: "C:\\nope", PATHEXT: ".EXE" },
      pathDelimiter: ";",
      isFile: () => false,
    });
    expect(out.bin).toBe("cmd.exe");
    expect(out.args).toEqual(["/d", "/s", "/c", "chcp 65001 >nul & dir .reasonix"]);
    expect(out.spawnOverrides.windowsVerbatimArguments).toBe(true);
  });

  it("cmd.exe builtin wrapping quotes metacharacter args", () => {
    const out = prepareSpawn(["echo", "a & b"], {
      platform: "win32",
      env: { PATH: "C:\\nope", PATHEXT: ".EXE" },
      pathDelimiter: ";",
      isFile: () => false,
    });
    expect(out.bin).toBe("cmd.exe");
    expect(out.args[3]).toBe('chcp 65001 >nul & echo "a & b"');
  });

  it("does not wrap paths-with-separators through cmd.exe", () => {
    // Absolute or slash-containing inputs are NOT bare names; they're
    // explicit disk paths — if the user points at a nonexistent one
    // we want the spawn to ENOENT plainly, not through cmd.exe.
    const out = prepareSpawn(["C:\\missing\\tool.exe", "arg"], {
      platform: "win32",
      env: { PATH: "", PATHEXT: ".EXE" },
      pathDelimiter: ";",
      isFile: () => false,
    });
    expect(out.bin).toBe("C:\\missing\\tool.exe");
    expect(out.args).toEqual(["arg"]);
  });

  it("injects UTF-8 prelude into powershell -Command invocations", () => {
    // Uppercase .EXE in the hit set so resolveExecutable's PATHEXT
    // probe finds it (matches existing .CMD test convention).
    const hits = new Set(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE"]);
    const out = prepareSpawn(["powershell", "-Command", "Get-ChildItem -Path tests"], {
      platform: "win32",
      env: {
        PATH: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
        PATHEXT: ".EXE",
      },
      pathDelimiter: ";",
      isFile: (p) => hits.has(p),
    });
    expect(out.bin).toMatch(/powershell\.exe$/i);
    // args = [-Command, "<prelude>Get-ChildItem -Path tests"]
    expect(out.args[0]).toBe("-Command");
    expect(out.args[1]).toMatch(/^\[Console\]::OutputEncoding=/);
    expect(out.args[1]).toContain("Get-ChildItem -Path tests");
    // No cmd.exe wrapping for powershell — direct spawn.
    expect(out.spawnOverrides).toEqual({});
  });

  it("injectPowerShellUtf8 leaves unrelated invocations untouched", () => {
    // No -Command flag → can't safely inject; we leave it alone.
    expect(injectPowerShellUtf8(["-File", "script.ps1"])).toBeNull();
    // -c (alias) still gets the prelude.
    const out = injectPowerShellUtf8(["-c", "Write-Host hi"]);
    expect(out).not.toBeNull();
    expect(out![1]).toMatch(/^\[Console\]::OutputEncoding=.*Write-Host hi$/);
  });

  it("does not wrap already-extensioned commands", () => {
    // `node.exe` with no PATH hit → user passed an explicit name;
    // pass it straight to spawn (will ENOENT if truly absent).
    const out = prepareSpawn(["node.exe", "-v"], {
      platform: "win32",
      env: { PATH: "", PATHEXT: ".EXE" },
      pathDelimiter: ";",
      isFile: () => false,
    });
    expect(out.bin).toBe("node.exe");
    expect(out.args).toEqual(["-v"]);
  });
});

describe("NeedsConfirmationError", () => {
  it("carries the rejected command on the instance", () => {
    const e = new NeedsConfirmationError("rm -rf /");
    expect(e.command).toBe("rm -rf /");
    expect(e.name).toBe("NeedsConfirmationError");
    expect(e.message).toMatch(/rm -rf \//);
  });

  it("tells the model to stop and wait, not to retry", () => {
    const e = new NeedsConfirmationError("npm install");
    expect(e.message).toMatch(/STOP calling tools/i);
    expect(e.message).toMatch(/y.*run.*n.*deny/i);
    expect(e.message).not.toMatch(/apply-shell/);
  });
});
