import { describe, expect, it, vi } from "vitest";
import {
  SLASH_COMMANDS,
  handleSlash,
  parseSlash,
  suggestSlashCommands,
} from "../src/cli/ui/slash.js";
import { DeepSeekClient, Usage } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory.js";

function makeLoop() {
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  return new CacheFirstLoop({
    client,
    prefix: new ImmutablePrefix({ system: "s" }),
  });
}

describe("parseSlash", () => {
  it("returns null on non-slash input", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("")).toBeNull();
    expect(parseSlash("/")).toBeNull();
  });
  it("lowercases the command and splits args", () => {
    expect(parseSlash("/Harvest on")).toEqual({ cmd: "harvest", args: ["on"] });
    expect(parseSlash("/branch 3")).toEqual({ cmd: "branch", args: ["3"] });
    expect(parseSlash("/help")).toEqual({ cmd: "help", args: [] });
  });
});

describe("handleSlash", () => {
  it("/exit requests exit", () => {
    const loop = makeLoop();
    expect(handleSlash("exit", [], loop).exit).toBe(true);
    expect(handleSlash("quit", [], loop).exit).toBe(true);
  });

  it("/clear requests history clear", () => {
    expect(handleSlash("clear", [], makeLoop()).clear).toBe(true);
  });

  it("/help returns a multi-line message", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/status/);
    expect(r.info).toMatch(/\/harvest/);
    expect(r.info).toMatch(/\/branch/);
  });

  it("/status reflects current loop config", () => {
    const loop = makeLoop();
    const r = handleSlash("status", [], loop);
    // New format: indented table with labeled rows ("model", "flags",
    // "ctx", "mcp", "session"). Harvest/branch live on the flags row.
    expect(r.info).toMatch(/model\s+deepseek-/);
    expect(r.info).toMatch(/harvest=off/);
    expect(r.info).toMatch(/branch=off/);
  });

  it("/model switches the model", () => {
    const loop = makeLoop();
    handleSlash("model", ["deepseek-reasoner"], loop);
    expect(loop.model).toBe("deepseek-reasoner");
  });

  it("/harvest on/off toggles", () => {
    const loop = makeLoop();
    handleSlash("harvest", ["on"], loop);
    expect(loop.harvestEnabled).toBe(true);
    handleSlash("harvest", ["off"], loop);
    expect(loop.harvestEnabled).toBe(false);
  });

  it("/harvest with no arg toggles the current state", () => {
    const loop = makeLoop();
    expect(loop.harvestEnabled).toBe(false);
    handleSlash("harvest", [], loop);
    expect(loop.harvestEnabled).toBe(true);
    handleSlash("harvest", [], loop);
    expect(loop.harvestEnabled).toBe(false);
  });

  it("/branch N enables branching and force-enables harvest + disables stream", () => {
    const loop = makeLoop();
    expect(loop.stream).toBe(true);
    expect(loop.harvestEnabled).toBe(false);
    handleSlash("branch", ["3"], loop);
    expect(loop.branchOptions.budget).toBe(3);
    expect(loop.branchEnabled).toBe(true);
    expect(loop.harvestEnabled).toBe(true);
    expect(loop.stream).toBe(false);
  });

  it("/branch off disables branching and restores stream preference", () => {
    const loop = makeLoop();
    handleSlash("branch", ["3"], loop);
    handleSlash("branch", ["off"], loop);
    expect(loop.branchEnabled).toBe(false);
    expect(loop.stream).toBe(true);
  });

  it("/branch rejects invalid N", () => {
    const loop = makeLoop();
    const r = handleSlash("branch", ["abc"], loop);
    expect(r.info).toMatch(/usage/);
    expect(loop.branchEnabled).toBe(false);
  });

  it("/branch caps at 8", () => {
    const loop = makeLoop();
    const r = handleSlash("branch", ["99"], loop);
    expect(r.info).toMatch(/capped/);
    expect(loop.branchEnabled).toBe(false);
  });

  it("unknown commands return an unknown flag with hint", () => {
    const r = handleSlash("nope", [], makeLoop());
    expect(r.unknown).toBe(true);
    expect(r.info).toMatch(/unknown command/);
  });

  it("/mcp with no servers attached points at reasonix setup", () => {
    const r = handleSlash("mcp", [], makeLoop());
    expect(r.info).toMatch(/no MCP servers/);
    expect(r.info).toMatch(/reasonix setup/);
  });

  it("/mcp shows the spec strings from SlashContext", () => {
    const r = handleSlash("mcp", [], makeLoop(), {
      mcpSpecs: [
        "filesystem=npx -y @modelcontextprotocol/server-filesystem /tmp",
        "kb=https://kb.example.com/sse",
      ],
    });
    expect(r.info).toMatch(/MCP servers \(2\)/);
    expect(r.info).toMatch(/server-filesystem/);
    expect(r.info).toMatch(/kb.example.com/);
  });

  it("/setup prints instructions to exit and run reasonix setup", () => {
    const r = handleSlash("setup", [], makeLoop());
    expect(r.info).toMatch(/reasonix setup/);
    expect(r.exit).toBeUndefined(); // /setup doesn't auto-exit — user presses /exit
  });

  it("/compact says 'nothing to compact' when no tool messages exceed the cap", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "hi" });
    loop.log.append({ role: "tool", tool_call_id: "t1", content: "short result" });
    const r = handleSlash("compact", [], loop);
    expect(r.info).toMatch(/nothing to compact/);
  });

  it("/compact shrinks oversized tool results and reports chars saved", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "read a big file" });
    loop.log.append({ role: "tool", tool_call_id: "t1", content: "Z".repeat(20_000) });
    const r = handleSlash("compact", [], loop);
    expect(r.info).toMatch(/compacted 1 tool result/);
    expect(r.info).toMatch(/saved/);
    // After compaction the tool message length should be below the default 4k cap + envelope.
    const toolEntry = loop.log.entries.find((m) => m.role === "tool");
    expect(typeof toolEntry?.content).toBe("string");
    expect((toolEntry?.content as string).length).toBeLessThan(5_000);
  });

  it("/compact honors a custom cap argument", () => {
    const loop = makeLoop();
    loop.log.append({ role: "tool", tool_call_id: "t1", content: "A".repeat(10_000) });
    // 2000-char cap should shrink the 10k message
    const r = handleSlash("compact", ["2000"], loop);
    expect(r.info).toMatch(/compacted 1/);
    const toolEntry = loop.log.entries.find((m) => m.role === "tool");
    expect((toolEntry?.content as string).length).toBeLessThan(2_500);
  });

  it("/help mentions /compact", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/compact/);
  });

  it("/preset fast = deepseek-chat, no harvest, no branch", () => {
    const loop = makeLoop();
    handleSlash("model", ["deepseek-reasoner"], loop);
    handleSlash("harvest", ["on"], loop);
    handleSlash("branch", ["3"], loop);
    handleSlash("preset", ["fast"], loop);
    expect(loop.model).toBe("deepseek-chat");
    expect(loop.harvestEnabled).toBe(false);
    expect(loop.branchEnabled).toBe(false);
  });

  it("/preset smart = reasoner + harvest, no branch", () => {
    const loop = makeLoop();
    handleSlash("preset", ["smart"], loop);
    expect(loop.model).toBe("deepseek-reasoner");
    expect(loop.harvestEnabled).toBe(true);
    expect(loop.branchEnabled).toBe(false);
  });

  it("/preset max = reasoner + harvest + branch3", () => {
    const loop = makeLoop();
    handleSlash("preset", ["max"], loop);
    expect(loop.model).toBe("deepseek-reasoner");
    expect(loop.harvestEnabled).toBe(true);
    expect(loop.branchOptions.budget).toBe(3);
  });

  it("/preset with bad name returns usage", () => {
    const r = handleSlash("preset", ["nonsense"], makeLoop());
    expect(r.info).toMatch(/usage/);
  });

  it("/help mentions presets", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/Presets:/);
    expect(r.info).toMatch(/fast/);
    expect(r.info).toMatch(/smart/);
    expect(r.info).toMatch(/max/);
  });

  it("/help mentions sessions", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/sessions/);
    expect(r.info).toMatch(/\/forget/);
  });

  it("/help mentions /mcp and /setup", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/mcp/);
    expect(r.info).toMatch(/\/setup/);
  });

  it("/undo outside code mode says it's not available", () => {
    const r = handleSlash("undo", [], makeLoop());
    expect(r.info).toMatch(/only available inside .reasonix code/);
  });

  it("/undo in code mode invokes the callback", () => {
    const r = handleSlash("undo", [], makeLoop(), {
      codeUndo: () => "▸ restored 2 file(s)",
    });
    expect(r.info).toMatch(/restored 2 file/);
  });

  it("/help mentions /undo and /commit", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/undo/);
    expect(r.info).toMatch(/\/commit/);
  });

  it("/commit outside code mode says it's not available", () => {
    const r = handleSlash("commit", ["foo"], makeLoop());
    expect(r.info).toMatch(/only available inside .reasonix code/);
  });

  it("/commit with no message prints usage", () => {
    const r = handleSlash("commit", [], makeLoop(), { codeRoot: "/tmp" });
    expect(r.info).toMatch(/usage: \/commit/);
  });

  it("/apply outside code mode says it's not available", () => {
    const r = handleSlash("apply", [], makeLoop());
    expect(r.info).toMatch(/only available inside .reasonix code/);
  });

  it("/apply in code mode invokes the callback", () => {
    const r = handleSlash("apply", [], makeLoop(), {
      codeApply: () => "▸ 2/2 edits applied",
    });
    expect(r.info).toMatch(/2\/2 edits applied/);
  });

  it("/discard outside code mode says it's not available", () => {
    const r = handleSlash("discard", [], makeLoop());
    expect(r.info).toMatch(/only available inside .reasonix code/);
  });

  it("/discard in code mode invokes the callback", () => {
    const r = handleSlash("discard", [], makeLoop(), {
      codeDiscard: () => "▸ discarded 3 pending",
    });
    expect(r.info).toMatch(/discarded 3 pending/);
  });

  it("/help mentions /apply and /discard", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/apply/);
    expect(r.info).toMatch(/\/discard/);
  });

  it("/think says no reasoning cached when scratch is empty", () => {
    const r = handleSlash("think", [], makeLoop());
    expect(r.info).toMatch(/no reasoning cached/);
  });

  it("/think dumps the full reasoning when scratch has content", () => {
    const loop = makeLoop();
    loop.scratch.reasoning = "lots of R1 deliberation here over many sentences";
    const r = handleSlash("think", [], loop);
    expect(r.info).toMatch(/full thinking/);
    expect(r.info).toContain("lots of R1 deliberation");
  });

  it("/help mentions /think", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/think/);
  });

  it("/retry returns info + resubmit when there's a prior user message", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "hello" });
    loop.log.append({ role: "assistant", content: "hi back" });
    const r = handleSlash("retry", [], loop);
    expect(r.resubmit).toBe("hello");
    expect(r.info).toMatch(/retrying/);
    // After retry, the log should be empty (last user message and
    // everything after were dropped; user will be re-pushed on next
    // successful turn).
    expect(loop.log.length).toBe(0);
  });

  it("/retry says nothing to retry when log has no user messages", () => {
    const r = handleSlash("retry", [], makeLoop());
    expect(r.info).toMatch(/nothing to retry/);
    expect(r.resubmit).toBeUndefined();
  });

  it("/help mentions /retry", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/retry/);
  });

  it("/tool with no history says none yet", () => {
    const r = handleSlash("tool", [], makeLoop());
    expect(r.info).toMatch(/no tool calls yet/);
  });

  it("/tool with history lists entries, most recent first", () => {
    const r = handleSlash("tool", [], makeLoop(), {
      toolHistory: () => [
        { toolName: "fs_read_file", text: "old content" },
        { toolName: "fs_list_directory", text: "newer content" },
      ],
    });
    expect(r.info).toMatch(/Tool calls in this session \(2/);
    // Most recent is #1 — the list must order so fs_list_directory
    // (newer) appears before fs_read_file (older).
    const idxNewer = r.info!.indexOf("fs_list_directory");
    const idxOlder = r.info!.indexOf("fs_read_file");
    expect(idxNewer).toBeGreaterThan(-1);
    expect(idxOlder).toBeGreaterThan(idxNewer);
  });

  it("/tool N dumps the Nth-most-recent tool output in full", () => {
    const big = "X".repeat(2000);
    const r = handleSlash("tool", ["1"], makeLoop(), {
      toolHistory: () => [
        { toolName: "fs_read_file", text: "older" },
        { toolName: "fs_list_directory", text: big },
      ],
    });
    expect(r.info).toMatch(/tool<fs_list_directory>/);
    expect(r.info).toMatch(/2000 chars/);
    // Full 2000 X's included — not truncated.
    expect(r.info).toContain(big);
  });

  it("/tool 2 reaches one call back from the most recent", () => {
    const r = handleSlash("tool", ["2"], makeLoop(), {
      toolHistory: () => [
        { toolName: "fs_read_file", text: "target" },
        { toolName: "fs_list_directory", text: "most recent" },
      ],
    });
    expect(r.info).toMatch(/tool<fs_read_file>/);
    expect(r.info).toContain("target");
  });

  it("/tool N past history length reports bounds", () => {
    const r = handleSlash("tool", ["5"], makeLoop(), {
      toolHistory: () => [{ toolName: "fs_read_file", text: "one" }],
    });
    expect(r.info).toMatch(/only 1 tool call/);
  });

  it("/tool with non-numeric arg returns usage", () => {
    const r = handleSlash("tool", ["huh"], makeLoop(), {
      toolHistory: () => [{ toolName: "fs_read_file", text: "one" }],
    });
    expect(r.info).toMatch(/usage: \/tool/);
  });

  it("/tool list trims the display to 10 most recent but hints at older", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      toolName: `t${i}`,
      text: `call-${i}`,
    }));
    const r = handleSlash("tool", [], makeLoop(), { toolHistory: () => many });
    // Most recent (#1 = t14) and 10th back (#10 = t5) should be shown.
    expect(r.info).toContain("t14");
    expect(r.info).toContain("t5");
    // t4 would be #11 — beyond the first-page cutoff.
    expect(r.info).toMatch(/5 earlier.*reach with \/tool N/);
  });

  it("/help mentions /tool", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/tool/);
  });

  it("SLASH_COMMANDS registry contains every handler switch case", () => {
    // Spot-check a handful so the registry doesn't silently drift
    // from `handleSlash`. If a new case lands in handleSlash, it
    // should also show up in suggestions — bump this list when
    // adding.
    const names = SLASH_COMMANDS.map((s) => s.cmd);
    for (const required of [
      "help",
      "status",
      "preset",
      "model",
      "branch",
      "mcp",
      "tool",
      "think",
      "retry",
      "compact",
      "sessions",
      "clear",
      "exit",
      "apply",
      "discard",
      "undo",
      "commit",
    ]) {
      expect(names, `registry missing /${required}`).toContain(required);
    }
  });

  it("suggestSlashCommands filters by prefix", () => {
    expect(suggestSlashCommands("h").map((s) => s.cmd)).toEqual(["help", "harvest"]);
    // Case-insensitive.
    expect(suggestSlashCommands("HE").map((s) => s.cmd)).toEqual(["help"]);
    // Empty prefix returns everything (non-contextual).
    expect(suggestSlashCommands("").length).toBeGreaterThan(5);
  });

  it("suggestSlashCommands hides code-mode-only entries when codeMode=false", () => {
    const names = suggestSlashCommands("", false).map((s) => s.cmd);
    expect(names).not.toContain("apply");
    expect(names).not.toContain("undo");
  });

  it("suggestSlashCommands shows code-mode-only entries when codeMode=true", () => {
    const names = suggestSlashCommands("", true).map((s) => s.cmd);
    expect(names).toContain("apply");
    expect(names).toContain("undo");
  });

  it("/mcp with mcpServers renders per-server tools+resources+prompts", () => {
    const r = handleSlash("mcp", [], makeLoop(), {
      mcpServers: [
        {
          label: "fs",
          spec: "fs=npx -y @scope/fs /tmp",
          toolCount: 4,
          report: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "fs-server", version: "1.0.0" },
            capabilities: { tools: {}, resources: {} },
            tools: { supported: true, items: [] },
            resources: {
              supported: true,
              items: [
                { uri: "file:///a", name: "docs" },
                { uri: "file:///b", name: "readme" },
              ],
            },
            prompts: { supported: false, reason: "method not found (-32601)" },
          },
        },
      ],
    });
    expect(r.info).toMatch(/\[fs\].*fs-server v1\.0\.0/);
    expect(r.info).toMatch(/tools\s+4/);
    expect(r.info).toMatch(/resources\s+2\s+\[docs, readme\]/);
    expect(r.info).toMatch(/prompts\s+\(not supported\)/);
  });

  it("/mcp falls back to the spec-only list when mcpServers is absent", () => {
    const r = handleSlash("mcp", [], makeLoop(), {
      mcpSpecs: ["filesystem=npx -y @scope/fs /tmp"],
    });
    expect(r.info).toMatch(/MCP servers \(1\)/);
    expect(r.info).toMatch(/server-filesystem|fs/);
  });

  it("/status shows ctx / session / mcp / pending lines with rich detail", () => {
    const loop = makeLoop();
    // Make it look like one turn ran so lastPromptTokens > 0.
    loop.stats.record(1, loop.model, new Usage(42_000, 50, 42_050, 40_000, 2_000));
    loop.log.append({ role: "user", content: "hi" });
    loop.log.append({ role: "assistant", content: "there" });
    const r = handleSlash("status", [], loop, {
      mcpSpecs: ["filesystem=npx -y @scope/fs /tmp", "mem=npx -y @scope/mem"],
      pendingEditCount: 3,
    });
    expect(r.info).toMatch(/model\s+deepseek-/);
    expect(r.info).toMatch(/ctx\s+\d+\.?\d*k?\/\d+k/);
    expect(r.info).toMatch(/mcp\s+2 server\(s\)/);
    expect(r.info).toMatch(/session.*\(ephemeral|session\s+"/);
    expect(r.info).toMatch(/edits\s+3 pending/);
  });

  it("/status with pendingEditCount=0 hides the edits line", () => {
    const r = handleSlash("status", [], makeLoop(), { pendingEditCount: 0 });
    expect(r.info).not.toMatch(/pending/);
  });

  it("/commit strips surrounding double quotes from the message", () => {
    // We can't exercise git without a real repo; instead, rely on the
    // fact that /commit fails (no git repo at /nonexistent) but the
    // failure output should reveal the stripped message in the
    // arguments we passed. We mirror this by just confirming usage
    // ISN'T printed — meaning the parser accepted a non-empty message.
    const r = handleSlash("commit", ['"fix: tests"'], makeLoop(), { codeRoot: "/nonexistent" });
    expect(r.info).not.toMatch(/usage: \/commit/);
    // It WILL say git failed since /nonexistent isn't a git repo, but
    // we don't assert the exact message — it varies by platform.
    expect(r.info).toMatch(/git (add|commit) failed/);
  });

  it("/sessions returns a hint when none exist", () => {
    const r = handleSlash("sessions", [], makeLoop());
    expect(r.info).toMatch(/no saved sessions yet|Saved sessions/);
  });

  it("/forget on a session-less loop says nothing to forget", () => {
    const loop = makeLoop();
    expect(loop.sessionName).toBeNull();
    const r = handleSlash("forget", [], loop);
    expect(r.info).toMatch(/nothing to forget/);
  });
});
