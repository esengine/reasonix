import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SLASH_COMMANDS,
  detectSlashArgContext,
  handleSlash,
  parseSlash,
  suggestSlashCommands,
} from "../src/cli/ui/slash.js";
import { DeepSeekClient, Usage } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { VERSION } from "../src/version.js";

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

  it("/clear requests history clear + surfaces an info line about what it does", () => {
    const r = handleSlash("clear", [], makeLoop());
    expect(r.clear).toBe(true);
    // Clear should also explain that context is NOT dropped — users
    // keep confusing this with /new. 0.7.1 bumped the action from a
    // React-state-only clear to a real terminal wipe (CSI 2J+3J),
    // so the info line says "terminal cleared" now.
    expect(r.info).toMatch(/terminal cleared/);
    expect(r.info).toMatch(/\/new/);
  });

  it("/new drops in-memory context AND clears scrollback", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "message 1" });
    loop.log.append({ role: "assistant", content: "reply 1" });
    loop.log.append({ role: "user", content: "message 2" });
    expect(loop.log.length).toBe(3);
    const r = handleSlash("new", [], loop);
    expect(r.clear).toBe(true);
    expect(r.info).toMatch(/dropped 3/);
    expect(loop.log.length).toBe(0);
  });

  it("/reset is an alias for /new (muscle memory)", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "hi" });
    const r = handleSlash("reset", [], loop);
    expect(r.clear).toBe(true);
    expect(loop.log.length).toBe(0);
  });

  it("/help distinguishes /clear (visual-only) from /new (drops context)", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/new/);
    // Wording explicitly notes context is kept on /clear.
    expect(r.info).toMatch(/clear displayed scrollback only/);
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

  it("/model soft-warns when id is not in the fetched catalog but still switches", () => {
    const loop = makeLoop();
    const r = handleSlash("model", ["deepseek-made-up"], loop, {
      models: ["deepseek-chat", "deepseek-reasoner"],
    });
    expect(loop.model).toBe("deepseek-made-up");
    expect(r.info).toMatch(/not in the fetched catalog/);
    expect(r.info).toMatch(/\/models/);
  });

  it("/model with no arg and loaded list hints at available ids", () => {
    const loop = makeLoop();
    const r = handleSlash("model", [], loop, {
      models: ["deepseek-chat", "deepseek-reasoner"],
    });
    expect(r.info).toMatch(/deepseek-chat \| deepseek-reasoner/);
  });

  it("/models renders the fetched catalog and marks the current one", () => {
    const loop = makeLoop();
    loop.configure({ model: "deepseek-reasoner" });
    const r = handleSlash("models", [], loop, {
      models: ["deepseek-chat", "deepseek-reasoner"],
    });
    expect(r.info).toMatch(/deepseek-chat/);
    expect(r.info).toMatch(/▸ deepseek-reasoner\s+\(current\)/);
    expect(r.info).toMatch(/\/model <id>/);
  });

  it("/models triggers a refresh and reports fetching when the list hasn't loaded yet", () => {
    const loop = makeLoop();
    const refresh = vi.fn();
    const r = handleSlash("models", [], loop, { models: null, refreshModels: refresh });
    expect(refresh).toHaveBeenCalledOnce();
    expect(r.info).toMatch(/fetching \/models/);
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

  it("/effort <high|max> flips the reasoningEffort cap", () => {
    const loop = makeLoop();
    expect(loop.reasoningEffort).toBe("max");
    handleSlash("effort", ["high"], loop);
    expect(loop.reasoningEffort).toBe("high");
    handleSlash("effort", ["max"], loop);
    expect(loop.reasoningEffort).toBe("max");
  });

  it("/effort with no arg reports the current value, doesn't change it", () => {
    const loop = makeLoop();
    const r = handleSlash("effort", [], loop);
    expect(r.info).toMatch(/reasoning_effort → max/);
    expect(loop.reasoningEffort).toBe("max");
  });

  it("/effort rejects unknown values", () => {
    const loop = makeLoop();
    const r = handleSlash("effort", ["low"], loop);
    expect(r.info).toMatch(/usage: \/effort <high\|max>/);
    expect(loop.reasoningEffort).toBe("max");
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
    expect(r.info).toMatch(/tokens/);
  });

  it("/compact shrinks oversized tool results and reports tokens saved", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "read a big file" });
    // Realistic log-shape content — avoids the BPE O(n²) pathological
    // path on pure-repeat inputs while still tokenizing well over the
    // default 4000-token cap.
    loop.log.append({
      role: "tool",
      tool_call_id: "t1",
      content: "ERROR: line failed with detail and context\n".repeat(2000),
    });
    const r = handleSlash("compact", [], loop);
    // Slash message now covers both passes (tool results + tool-call
    // args); the "1 payload" and a token-saved count are what matters
    // for this test's invariant.
    expect(r.info).toMatch(/compacted 1 payload/);
    expect(r.info).toMatch(/saved [\d,]+ tokens/);
    // After compaction the tool content should be much smaller than
    // the original 84KB, comfortably under the cap's char worst-case.
    const toolEntry = loop.log.entries.find((m) => m.role === "tool");
    expect(typeof toolEntry?.content).toBe("string");
    expect((toolEntry?.content as string).length).toBeLessThan(20_000);
  });

  it("/compact honors a custom token cap argument", () => {
    const loop = makeLoop();
    loop.log.append({
      role: "tool",
      tool_call_id: "t1",
      content: "INFO: event ok\n".repeat(1500),
    });
    // 500-token cap should shrink the message hard.
    const r = handleSlash("compact", ["500"], loop);
    expect(r.info).toMatch(/compacted 1/);
    expect(r.info).toMatch(/500 tokens each/);
    const toolEntry = loop.log.entries.find((m) => m.role === "tool");
    expect((toolEntry?.content as string).length).toBeLessThan(3_000);
  });

  it("/help mentions /compact", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/compact/);
  });

  it("/preset auto = v4-flash + auto-escalate, no harvest, no branch", () => {
    const loop = makeLoop();
    handleSlash("model", ["deepseek-v4-pro"], loop);
    handleSlash("harvest", ["on"], loop);
    handleSlash("branch", ["3"], loop);
    handleSlash("preset", ["auto"], loop);
    expect(loop.model).toBe("deepseek-v4-flash");
    expect(loop.reasoningEffort).toBe("max");
    expect(loop.harvestEnabled).toBe(false);
    expect(loop.branchEnabled).toBe(false);
  });

  it("/preset flash = v4-flash, no auto-escalate", () => {
    const loop = makeLoop();
    handleSlash("preset", ["flash"], loop);
    expect(loop.model).toBe("deepseek-v4-flash");
    expect(loop.reasoningEffort).toBe("max");
    expect(loop.harvestEnabled).toBe(false);
    expect(loop.branchEnabled).toBe(false);
  });

  it("/preset pro = v4-pro pinned, no harvest, no branch", () => {
    const loop = makeLoop();
    handleSlash("preset", ["pro"], loop);
    expect(loop.model).toBe("deepseek-v4-pro");
    expect(loop.reasoningEffort).toBe("max");
    expect(loop.harvestEnabled).toBe(false);
    // Branch is NEVER auto-enabled by a preset — manual /branch only.
    expect(loop.branchEnabled).toBe(false);
  });

  it("/preset with bad name returns usage", () => {
    const r = handleSlash("preset", ["nonsense"], makeLoop());
    expect(r.info).toMatch(/usage/);
  });

  it("/help mentions presets", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/Presets/);
    expect(r.info).toMatch(/auto/);
    expect(r.info).toMatch(/flash/);
    expect(r.info).toMatch(/pro/);
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

  describe("/keys", () => {
    it("lists the major keyboard shortcuts", () => {
      const r = handleSlash("keys", [], makeLoop());
      expect(r.info).toMatch(/Enter\s+submit/);
      expect(r.info).toMatch(/Shift\+Enter/);
      expect(r.info).toMatch(/Ctrl\+J/);
      expect(r.info).toMatch(/Esc\s+abort/);
    });

    it("documents the three prompt prefixes", () => {
      const r = handleSlash("keys", [], makeLoop());
      expect(r.info).toMatch(/\/<name>/);
      expect(r.info).toMatch(/@<path>/);
      expect(r.info).toMatch(/!<cmd>/);
    });

    it("mentions the pickers", () => {
      const r = handleSlash("keys", [], makeLoop());
      expect(r.info).toMatch(/[Pp]icker/);
      expect(r.info).toMatch(/Tab/);
    });
  });

  it("/help mentions /keys", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/keys/);
  });

  describe("detectSlashArgContext", () => {
    it("returns null before the user commits to a slash name", () => {
      expect(detectSlashArgContext("/pr")).toBeNull();
      expect(detectSlashArgContext("/preset")).toBeNull();
    });

    it("returns null when the command doesn't exist", () => {
      expect(detectSlashArgContext("/nope foo")).toBeNull();
    });

    it("returns null on plain prose (no slash at all)", () => {
      expect(detectSlashArgContext("just some text")).toBeNull();
    });

    it("activates enum picker for /preset", () => {
      const ctx = detectSlashArgContext("/preset fl");
      expect(ctx).not.toBeNull();
      expect(ctx!.kind).toBe("picker");
      expect(ctx!.spec.argCompleter).toEqual(["auto", "flash", "pro"]);
      expect(ctx!.partial).toBe("fl");
      // Offset is the char index where the partial starts in the buffer.
      expect(ctx!.partialOffset).toBe("/preset ".length);
    });

    it("activates model picker for /model", () => {
      const ctx = detectSlashArgContext("/model deep");
      expect(ctx).not.toBeNull();
      expect(ctx!.kind).toBe("picker");
      expect(ctx!.spec.argCompleter).toBe("models");
    });

    it("activates enum picker for /plan in code mode", () => {
      const ctx = detectSlashArgContext("/plan o", true);
      expect(ctx).not.toBeNull();
      expect(ctx!.kind).toBe("picker");
      expect(ctx!.spec.argCompleter).toEqual(["on", "off"]);
    });

    it("hides /plan outside code mode (command is contextual)", () => {
      expect(detectSlashArgContext("/plan on", false)).toBeNull();
    });

    it("surfaces a hint-only row once the user types a space inside the partial", () => {
      // "/preset auto foo" — typed past the one enum slot.
      const ctx = detectSlashArgContext("/preset auto foo");
      expect(ctx).not.toBeNull();
      expect(ctx!.kind).toBe("hint");
    });

    it("returns picker with empty partial when the user just hit space", () => {
      const ctx = detectSlashArgContext("/preset ");
      expect(ctx).not.toBeNull();
      expect(ctx!.kind).toBe("picker");
      expect(ctx!.partial).toBe("");
    });

    it("returns hint for commands without a completer", () => {
      // `/commit "msg"` — free-form argument, no picker data.
      const ctx = detectSlashArgContext('/commit "', true);
      expect(ctx).not.toBeNull();
      expect(ctx!.kind).toBe("hint");
      expect(ctx!.spec.cmd).toBe("commit");
    });

    it("still surfaces picker kind when partial exactly matches an enum value", () => {
      // Detector itself is kind-only — it doesn't know whether the
      // partial is a complete match. The App's slashArgMatches memo
      // is responsible for hiding the picker on exact match so Enter
      // submits; this test documents that the detector's contract is
      // "we're in picker mode" regardless of match state.
      const ctx = detectSlashArgContext("/preset smart");
      expect(ctx).not.toBeNull();
      expect(ctx!.kind).toBe("picker");
      expect(ctx!.partial).toBe("smart");
    });
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
      "memory",
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
      "plan",
      "apply-plan",
      "keys",
    ]) {
      expect(names, `registry missing /${required}`).toContain(required);
    }
  });

  it("suggestSlashCommands filters by prefix", () => {
    expect(suggestSlashCommands("h").map((s) => s.cmd)).toEqual(["help", "harvest", "hooks"]);
    // Case-insensitive.
    expect(suggestSlashCommands("HE").map((s) => s.cmd)).toEqual(["help"]);
    // Empty prefix returns everything (non-contextual).
    expect(suggestSlashCommands("").length).toBeGreaterThan(5);
  });

  describe("/update", () => {
    it("reports pending check when latestVersion is null (offline / in flight)", () => {
      const r = handleSlash("update", [], makeLoop(), { latestVersion: null });
      expect(r.info).toMatch(/current: reasonix/);
      expect(r.info).toMatch(/not yet resolved/);
      expect(r.info).toMatch(/reasonix update/);
    });

    it("reports up-to-date when current matches latest", () => {
      const r = handleSlash("update", [], makeLoop(), { latestVersion: VERSION });
      expect(r.info).toMatch(/on the latest/);
      expect(r.info).not.toMatch(/npm install/);
    });

    it("prints shell command when latest is newer than current", () => {
      const r = handleSlash("update", [], makeLoop(), { latestVersion: "99.99.99" });
      expect(r.info).toMatch(/99\.99\.99/);
      expect(r.info).toMatch(/reasonix update/);
      expect(r.info).toMatch(/npm install -g reasonix@latest/);
    });

    it("is surfaced by suggestSlashCommands", () => {
      const names = suggestSlashCommands("up").map((s) => s.cmd);
      expect(names).toContain("update");
    });
  });

  describe("/stats", () => {
    it("prints a how-to when the usage log is empty / missing", () => {
      // Use the real ~ here — if a real log exists (developer machine),
      // this test would see real data. We assert only on a substring
      // that's present either way: the path is always mentioned.
      const r = handleSlash("stats", [], makeLoop());
      expect(r.info).toMatch(/usage\.jsonl|turns/);
    });

    it("is surfaced by suggestSlashCommands", () => {
      const names = suggestSlashCommands("sta").map((s) => s.cmd);
      expect(names).toContain("stats");
    });
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

  it("/mcp opens the browser modal when servers are attached", () => {
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
            resources: { supported: true, items: [] },
            prompts: { supported: false, reason: "method not found (-32601)" },
          },
        },
      ],
    });
    expect(r.openMcpBrowser).toBe(true);
    expect(r.info).toBeUndefined();
  });

  it("/mcp text falls through to the printed-card view (non-TTY / replay)", () => {
    const r = handleSlash("mcp", ["text"], makeLoop(), {
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
    expect(r.openMcpBrowser).toBeUndefined();
    expect(r.info).toMatch(/\[fs\].*fs-server v1\.0\.0/);
    expect(r.info).toMatch(/tools\s+4/);
    expect(r.info).toMatch(/resources\s+2\s+\[docs, readme\]/);
    expect(r.info).toMatch(/prompts\s+\(not supported\)/);
  });

  describe("/mcp reconnect", () => {
    function summary(label: string, spec: string) {
      // Stub host — slash dispatch only reads it; the async reconnect runs
      // in the background and we only inspect the synchronous return.
      const host = { client: {} as never };
      return {
        label,
        spec,
        toolCount: 0,
        host,
        report: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: label, version: "1.0.0" },
          capabilities: { tools: {} },
          tools: { supported: true as const, items: [] },
          resources: { supported: false as const, reason: "method not found" },
          prompts: { supported: false as const, reason: "method not found" },
          elapsedMs: 0,
        },
      };
    }

    it("/mcp reconnect <name> emits the lifecycle line on dispatch", () => {
      const r = handleSlash("mcp", ["reconnect", "notion"], makeLoop(), {
        mcpServers: [summary("notion", "notion=node -e 0")],
        postInfo: () => {
          /* swallowed for this test */
        },
      });
      expect(r.info).toMatch(/MCP · notion/);
      expect(r.info).toMatch(/↻ reconnect…/);
    });

    it("/mcp reconnect rejects unknown name with the list of known", () => {
      const r = handleSlash("mcp", ["reconnect", "ghost"], makeLoop(), {
        mcpServers: [summary("notion", "notion=cmd"), summary("linear", "linear=cmd")],
        postInfo: () => {},
      });
      expect(r.info).toMatch(/unknown MCP server "ghost"/);
      expect(r.info).toMatch(/Known: linear, notion/);
    });

    it("/mcp reconnect with no name shows usage", () => {
      const r = handleSlash("mcp", ["reconnect"], makeLoop(), {
        mcpServers: [summary("notion", "notion=cmd")],
        postInfo: () => {},
      });
      expect(r.info).toMatch(/usage: \/mcp reconnect <name>/);
    });
  });

  it("/mcp falls back to the spec-only list when mcpServers is absent", () => {
    const r = handleSlash("mcp", [], makeLoop(), {
      mcpSpecs: ["filesystem=npx -y @scope/fs /tmp"],
    });
    expect(r.info).toMatch(/MCP servers \(1\)/);
    expect(r.info).toMatch(/server-filesystem|fs/);
  });

  describe("/mcp disable / enable", () => {
    let tempHome: string;
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;

    beforeEach(() => {
      tempHome = mkdtempSync(join(tmpdir(), "reasonix-mcp-toggle-"));
      originalHome = process.env.HOME;
      originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
    });
    afterEach(() => {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      rmSync(tempHome, { recursive: true, force: true });
    });

    it("/mcp disable <name> persists the name into config.mcpDisabled", () => {
      const r = handleSlash("mcp", ["disable", "notion"], makeLoop(), {
        mcpSpecs: ["notion=npx -y @scope/notion", "linear=npx -y @scope/linear"],
      });
      expect(r.info).toMatch(/notion disabled/);
      expect(r.info).toMatch(/next launch/);
      const cfgPath = join(tempHome, ".reasonix", "config.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      expect(cfg.mcpDisabled).toEqual(["notion"]);
    });

    it("/mcp enable <name> removes from disabled and clears the array when empty", () => {
      const cfgPath = join(tempHome, ".reasonix", "config.json");
      mkdirSync(join(tempHome, ".reasonix"), { recursive: true });
      writeFileSync(cfgPath, JSON.stringify({ mcpDisabled: ["notion", "linear"] }));
      const r = handleSlash("mcp", ["enable", "notion"], makeLoop(), {
        mcpSpecs: ["notion=npx -y @scope/notion", "linear=npx -y @scope/linear"],
      });
      expect(r.info).toMatch(/notion re-enabled/);
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      expect(cfg.mcpDisabled).toEqual(["linear"]);
    });

    it("/mcp enable removes the array entirely when last entry clears", () => {
      const cfgPath = join(tempHome, ".reasonix", "config.json");
      mkdirSync(join(tempHome, ".reasonix"), { recursive: true });
      writeFileSync(cfgPath, JSON.stringify({ mcpDisabled: ["notion"] }));
      handleSlash("mcp", ["enable", "notion"], makeLoop(), {
        mcpSpecs: ["notion=npx -y @scope/notion"],
      });
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      expect(cfg.mcpDisabled).toBeUndefined();
    });

    it("/mcp disable rejects unknown names with the list of known ones", () => {
      const r = handleSlash("mcp", ["disable", "ghost"], makeLoop(), {
        mcpSpecs: ["notion=cmd", "linear=cmd"],
      });
      expect(r.info).toMatch(/unknown MCP server "ghost"/);
      expect(r.info).toMatch(/Known: linear, notion/);
    });

    it("/mcp disable with no arg shows usage", () => {
      const r = handleSlash("mcp", ["disable"], makeLoop(), {
        mcpSpecs: ["notion=cmd"],
      });
      expect(r.info).toMatch(/usage: \/mcp disable <name>/);
    });

    it("/mcp disable on already-disabled is idempotent", () => {
      const cfgPath = join(tempHome, ".reasonix", "config.json");
      mkdirSync(join(tempHome, ".reasonix"), { recursive: true });
      writeFileSync(cfgPath, JSON.stringify({ mcpDisabled: ["notion"] }));
      const r = handleSlash("mcp", ["disable", "notion"], makeLoop(), {
        mcpSpecs: ["notion=cmd"],
      });
      expect(r.info).toMatch(/already disabled/);
    });
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
    // ctx row now includes a tiny [██░░░░] char bar between the label
    // and the count — match the count itself loosely.
    expect(r.info).toMatch(/ctx\s+\S+\s+\d+\.?\d*K?\/\d+K/);
    expect(r.info).toMatch(/mcp\s+2 server\(s\)/);
    expect(r.info).toMatch(/session.*\(ephemeral|session\s+"/);
    expect(r.info).toMatch(/edits\s+3 pending/);
    // /status now also surfaces cost/turns
    expect(r.info).toMatch(/cost\s+\$/);
  });

  it("/context breaks down tokens across system / tools / log, and flags the heaviest tool results", () => {
    const loop = makeLoop();
    // Seed a realistic log: two turns, one with a large tool result.
    loop.log.append({ role: "user", content: "list me the files" });
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "list_directory", arguments: '{"path":"."}' },
        },
      ],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: "c1",
      name: "list_directory",
      content: "README.md\npackage.json\nsrc/\n".repeat(200),
    });
    loop.log.append({ role: "assistant", content: "here are the files" });
    loop.log.append({ role: "user", content: "now read package.json" });

    const r = handleSlash("context", [], loop);
    // /context now returns a structured `ctxBreakdown` payload that
    // EventLog renders as a 4-color stacked char-bar; `info` is just
    // a fallback one-liner. Assert on the structure.
    expect(r.ctxBreakdown).toBeDefined();
    expect(r.ctxBreakdown!.systemTokens).toBeGreaterThan(0);
    expect(r.ctxBreakdown!.toolsCount).toBeGreaterThanOrEqual(0);
    expect(r.ctxBreakdown!.logMessages).toBeGreaterThan(0);
    // Heaviest-tool section must surface the list_directory result.
    const top = r.ctxBreakdown!.topTools;
    expect(top.length).toBeGreaterThan(0);
    expect(top[0]!.name).toBe("list_directory");
    // The fallback info summary still has the basic shape.
    expect(r.info).toMatch(/context:/);
    expect(r.info).toMatch(/system/);
  });

  it("/context handles an empty log without crashing", () => {
    const r = handleSlash("context", [], makeLoop());
    expect(r.ctxBreakdown).toBeDefined();
    expect(r.ctxBreakdown!.topTools).toEqual([]);
    expect(r.info).toMatch(/context:/);
  });

  it("/cost with text estimates worst-case + likely cost for the prospective prompt", () => {
    const loop = makeLoop();
    loop.stats.record(1, loop.model, new Usage(10_000, 500, 10_500, 8_000, 2_000));
    loop.log.append({ role: "user", content: "earlier message" });
    loop.log.append({ role: "assistant", content: "earlier reply" });
    const r = handleSlash("cost", ["draft", "this", "long", "prompt", "right", "here"], loop);
    expect(r.info).toMatch(/\/cost estimate/);
    expect(r.info).toMatch(/prompt tokens/);
    expect(r.info).toMatch(/worst case.*\$/);
    expect(r.info).toMatch(/likely.*cache hit/);
  });

  it("/cost with text but no completed turns notes cache hasn't filled yet", () => {
    const r = handleSlash("cost", ["hello"], makeLoop());
    expect(r.info).toMatch(/worst case/);
    expect(r.info).toMatch(/no completed turns yet/);
  });

  it("/cost with no args + no completed turns falls through to the existing post-turn message", () => {
    const r = handleSlash("cost", [], makeLoop());
    expect(r.info).toMatch(/no turn yet/);
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

  it("/sessions opens the session picker", () => {
    const r = handleSlash("sessions", [], makeLoop());
    expect(r.openSessionsPicker).toBe(true);
  });

  it("/forget on a session-less loop says nothing to forget", () => {
    const loop = makeLoop();
    expect(loop.sessionName).toBeNull();
    const r = handleSlash("forget", [], loop);
    expect(r.info).toMatch(/nothing to forget/);
  });

  describe("/plans + /replay", () => {
    let tempHome: string;
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;

    beforeEach(() => {
      tempHome = mkdtempSync(join(tmpdir(), "reasonix-replay-slash-"));
      originalHome = process.env.HOME;
      originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
    });
    afterEach(() => {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      rmSync(tempHome, { recursive: true, force: true });
    });

    function loopWithSession(name: string): CacheFirstLoop {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: vi.fn() as unknown as typeof fetch,
      });
      return new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        session: name,
      });
    }

    function writeArchive(
      sessionName: string,
      stamp: string,
      payload: Record<string, unknown>,
    ): void {
      const dir = join(tempHome, ".reasonix", "sessions");
      const fs = require("node:fs") as typeof import("node:fs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        join(dir, `${sessionName}.plan.${stamp}.done.json`),
        JSON.stringify(payload),
      );
    }

    it("/replay without args returns the newest archive", () => {
      const loop = loopWithSession("replay-test");
      writeArchive("replay-test", "2026-04-01-old", {
        version: 1,
        steps: [{ id: "step-1", title: "old work", action: "a" }],
        completedStepIds: ["step-1"],
        updatedAt: "2026-04-01T00:00:00.000Z",
        summary: "Older plan",
      });
      writeArchive("replay-test", "2026-04-20-new", {
        version: 1,
        steps: [
          { id: "step-1", title: "extract", action: "a" },
          { id: "step-2", title: "rewire", action: "b" },
        ],
        completedStepIds: ["step-1", "step-2"],
        updatedAt: "2026-04-20T00:00:00.000Z",
        summary: "Newer plan",
        body: "# Plan\n- do thing",
      });
      const r = handleSlash("replay", [], loop);
      expect(r.replayPlan).toBeDefined();
      expect(r.replayPlan?.summary).toBe("Newer plan");
      expect(r.replayPlan?.steps).toHaveLength(2);
      expect(r.replayPlan?.body).toBe("# Plan\n- do thing");
      expect(r.replayPlan?.index).toBe(1);
      expect(r.replayPlan?.total).toBe(2);
    });

    it("/replay 2 returns the older archive in a 2-archive session", () => {
      const loop = loopWithSession("replay-idx");
      writeArchive("replay-idx", "2026-04-01-a", {
        version: 1,
        steps: [{ id: "x", title: "y", action: "z" }],
        completedStepIds: ["x"],
        updatedAt: "2026-04-01T00:00:00.000Z",
        summary: "Older",
      });
      writeArchive("replay-idx", "2026-04-20-b", {
        version: 1,
        steps: [{ id: "x", title: "y", action: "z" }],
        completedStepIds: ["x"],
        updatedAt: "2026-04-20T00:00:00.000Z",
        summary: "Newer",
      });
      const r = handleSlash("replay", ["2"], loop);
      expect(r.replayPlan?.summary).toBe("Older");
      expect(r.replayPlan?.index).toBe(2);
    });

    it("/replay rejects out-of-range index", () => {
      const loop = loopWithSession("replay-oob");
      writeArchive("replay-oob", "2026-04-20-a", {
        version: 1,
        steps: [{ id: "x", title: "y", action: "z" }],
        completedStepIds: [],
        updatedAt: "2026-04-20T00:00:00.000Z",
      });
      const r = handleSlash("replay", ["5"], loop);
      expect(r.replayPlan).toBeUndefined();
      expect(r.info).toMatch(/invalid index/);
    });

    it("/replay says nothing to replay when no archives exist", () => {
      const loop = loopWithSession("replay-empty");
      const r = handleSlash("replay", [], loop);
      expect(r.replayPlan).toBeUndefined();
      expect(r.info).toMatch(/no archived plans yet/);
    });

    it("/replay needs a session", () => {
      const r = handleSlash("replay", [], makeLoop());
      expect(r.replayPlan).toBeUndefined();
      expect(r.info).toMatch(/no session attached/);
    });

    it("/plans surfaces the summary as the active plan label", () => {
      const loop = loopWithSession("plans-summary");
      const fs = require("node:fs") as typeof import("node:fs");
      const dir = join(tempHome, ".reasonix", "sessions");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        join(dir, "plans-summary.plan.json"),
        JSON.stringify({
          version: 1,
          steps: [
            { id: "s1", title: "a", action: "b" },
            { id: "s2", title: "c", action: "d" },
          ],
          completedStepIds: ["s1"],
          updatedAt: new Date().toISOString(),
          summary: "Refactor auth into signed tokens",
        }),
      );
      const r = handleSlash("plans", [], loop);
      expect(r.info).toMatch(/Refactor auth into signed tokens/);
      expect(r.info).toMatch(/1\/2/);
    });
  });

  describe("/memory", () => {
    let root: string;
    const originalEnv = process.env.REASONIX_MEMORY;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "reasonix-mem-slash-"));
      // biome-ignore lint/performance/noDelete: avoid "undefined" in env
      delete process.env.REASONIX_MEMORY;
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
      if (originalEnv === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.REASONIX_MEMORY;
      } else {
        process.env.REASONIX_MEMORY = originalEnv;
      }
    });

    it("prints a how-to when no memory (REASONIX.md or ~/.reasonix/memory) exists", () => {
      const r = handleSlash("memory", [], makeLoop(), { memoryRoot: root });
      expect(r.info).toMatch(/no memory pinned/);
      expect(r.info).toMatch(/REASONIX\.md/);
    });

    it("prints the REASONIX.md contents + path when present", () => {
      writeFileSync(
        join(root, "REASONIX.md"),
        "# House rules\nSnake case only in this repo.\n",
        "utf8",
      );
      const r = handleSlash("memory", [], makeLoop(), { memoryRoot: root });
      expect(r.info).toMatch(/▸ REASONIX\.md:/);
      expect(r.info).toContain("Snake case only");
      expect(r.info).toMatch(/chars/);
    });

    it("says memory is disabled when REASONIX_MEMORY=off, even with a file present", () => {
      writeFileSync(join(root, "REASONIX.md"), "content", "utf8");
      process.env.REASONIX_MEMORY = "off";
      const r = handleSlash("memory", [], makeLoop(), { memoryRoot: root });
      expect(r.info).toMatch(/memory is disabled/);
    });

    it("refuses to guess a root when memoryRoot is absent", () => {
      const r = handleSlash("memory", [], makeLoop());
      expect(r.info).toMatch(/no working directory/);
    });
  });

  describe("/plan + /apply-plan", () => {
    it("/plan replies 'only in code mode' when setPlanMode callback is missing", () => {
      const r = handleSlash("plan", [], makeLoop());
      expect(r.info).toMatch(/only available inside `reasonix code`/);
    });

    it("/plan toggles when called with no args", () => {
      const calls: boolean[] = [];
      const r1 = handleSlash("plan", [], makeLoop(), {
        planMode: false,
        setPlanMode: (on) => calls.push(on),
      });
      expect(calls).toEqual([true]);
      expect(r1.info).toMatch(/plan mode ON/);

      const r2 = handleSlash("plan", [], makeLoop(), {
        planMode: true,
        setPlanMode: (on) => calls.push(on),
      });
      expect(calls).toEqual([true, false]);
      expect(r2.info).toMatch(/plan mode OFF/);
    });

    it("/plan on / off / true / false / 0 / 1 parse correctly", () => {
      const check = (arg: string, expected: boolean) => {
        const calls: boolean[] = [];
        handleSlash("plan", [arg], makeLoop(), {
          planMode: !expected, // start from the opposite
          setPlanMode: (on) => calls.push(on),
        });
        expect(calls, `arg=${arg}`).toEqual([expected]);
      };
      check("on", true);
      check("true", true);
      check("1", true);
      check("off", false);
      check("false", false);
      check("0", false);
    });

    it("/plan explains the stronger-constraint relationship with autonomous submit_plan", () => {
      const r = handleSlash("plan", ["on"], makeLoop(), {
        setPlanMode: () => {},
        planMode: false,
      });
      // The info text should be explicit that submit_plan can also fire
      // outside plan mode (autonomous) — plan mode is the *stronger*
      // constraint, not the only path.
      expect(r.info).toMatch(/stronger/);
      expect(r.info).toMatch(/submit_plan/);
    });

    it("/apply-plan replies 'only in code mode' when setPlanMode is missing", () => {
      const r = handleSlash("apply-plan", [], makeLoop());
      expect(r.info).toMatch(/only available inside `reasonix code`/);
    });

    it("/apply-plan flips plan mode off, clears pending, and resubmits the implement-now synthetic", () => {
      const setCalls: boolean[] = [];
      const clearCalls: number[] = [];
      const r = handleSlash("apply-plan", [], makeLoop(), {
        setPlanMode: (on) => setCalls.push(on),
        clearPendingPlan: () => {
          clearCalls.push(1);
        },
      });
      expect(setCalls).toEqual([false]);
      expect(clearCalls).toEqual([1]);
      expect(r.info).toMatch(/plan approved/);
      expect(r.resubmit).toMatch(/Implement it now/);
      expect(r.resubmit).toMatch(/out of plan mode/);
    });

    it("/apply-plan works without a clearPendingPlan callback (only setPlanMode required)", () => {
      const setCalls: boolean[] = [];
      const r = handleSlash("apply-plan", [], makeLoop(), {
        setPlanMode: (on) => setCalls.push(on),
        // clearPendingPlan omitted — /apply-plan must still work
      });
      expect(setCalls).toEqual([false]);
      expect(r.resubmit).toMatch(/Implement it now/);
    });

    it("/status surfaces plan mode when it's on", () => {
      const r = handleSlash("status", [], makeLoop(), { planMode: true });
      expect(r.info).toMatch(/plan\s+ON/);
    });

    it("/status hides the plan line when plan mode is off", () => {
      const r = handleSlash("status", [], makeLoop(), { planMode: false });
      expect(r.info).not.toMatch(/plan\s+ON/);
    });
  });
});
