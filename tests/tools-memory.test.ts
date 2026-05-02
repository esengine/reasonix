/** remember / forget / recall_memory — dispatches through ToolRegistry; refusals surface as JSON-encoded `{ error }`. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/user.js";
import { ToolRegistry } from "../src/tools.js";
import { registerMemoryTools } from "../src/tools/memory.js";

describe("memory tools", () => {
  let home: string;
  let projectRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-memtools-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-memtools-proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe("remember", () => {
    it("writes a global memory and returns a human-readable confirmation", async () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      const out = await reg.dispatch("remember", {
        type: "feedback",
        scope: "global",
        name: "pref_one",
        description: "User prefers tabs",
        content: "Always use tabs for indentation.",
      });
      expect(out).toMatch(/REMEMBERED \(global\/pref_one\)/);
      expect(out).toMatch(/User prefers tabs/);
      // Verify the store actually has it.
      const store = new MemoryStore({ homeDir: home });
      const listed = store.list();
      expect(listed.map((e) => e.name)).toContain("pref_one");
    });

    it("refuses scope='project' when no projectRoot is configured", async () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      const out = await reg.dispatch("remember", {
        type: "project",
        scope: "project",
        name: "xyz_abc",
        description: "d",
        content: "c",
      });
      const parsed = JSON.parse(out);
      expect(parsed.error).toMatch(/scope='project'/);
    });

    it("allows scope='project' when projectRoot is configured", async () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home, projectRoot });
      const out = await reg.dispatch("remember", {
        type: "project",
        scope: "project",
        name: "bun_build",
        description: "Build is bun run build",
        content: "On this machine, no npm — only bun.",
      });
      expect(out).toMatch(/REMEMBERED \(project\/bun_build\)/);
    });

    it("returns an error (not a throw) for invalid names", async () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      const out = await reg.dispatch("remember", {
        type: "user",
        scope: "global",
        name: "../bad",
        description: "d",
        content: "c",
      });
      const parsed = JSON.parse(out);
      expect(parsed.error).toMatch(/invalid memory name/);
    });

    it("returns an error when description is empty", async () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      const out = await reg.dispatch("remember", {
        type: "user",
        scope: "global",
        name: "nonempty_name",
        description: "",
        content: "body",
      });
      const parsed = JSON.parse(out);
      expect(parsed.error).toMatch(/description/);
    });
  });

  describe("forget", () => {
    it("removes an existing memory and reports so", async () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      await reg.dispatch("remember", {
        type: "user",
        scope: "global",
        name: "delete_me",
        description: "d",
        content: "c",
      });
      const out = await reg.dispatch("forget", { scope: "global", name: "delete_me" });
      expect(out).toMatch(/forgot \(global\/delete_me\)/);
      const store = new MemoryStore({ homeDir: home });
      expect(store.list().map((e) => e.name)).not.toContain("delete_me");
    });

    it("is idempotent on a missing memory (reports 'no such memory')", async () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      const out = await reg.dispatch("forget", { scope: "global", name: "ghost_one" });
      expect(out).toMatch(/no such memory/);
    });
  });

  describe("recall_memory", () => {
    it("returns the body of an existing memory (with header)", async () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      await reg.dispatch("remember", {
        type: "feedback",
        scope: "global",
        name: "deep_detail",
        description: "short one-liner",
        content: "Full body with **markdown** and multiple paragraphs.\n\nSecond paragraph.",
      });
      const out = await reg.dispatch("recall_memory", {
        scope: "global",
        name: "deep_detail",
      });
      expect(out).toContain("deep_detail");
      expect(out).toContain("Full body with **markdown**");
      expect(out).toContain("Second paragraph.");
    });

    it("returns an error (not a throw) on missing name", async () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      const out = await reg.dispatch("recall_memory", { scope: "global", name: "ghost_one" });
      const parsed = JSON.parse(out);
      expect(parsed.error).toMatch(/recall failed/);
    });

    it("is marked readOnly (available in plan mode)", () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      const tool = reg.get("recall_memory");
      expect(tool?.readOnly).toBe(true);
    });
  });

  describe("registration", () => {
    it("registers all three tools", () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      expect(reg.has("remember")).toBe(true);
      expect(reg.has("forget")).toBe(true);
      expect(reg.has("recall_memory")).toBe(true);
    });

    it("remember / forget are NOT marked readOnly (gated in plan mode)", () => {
      const reg = new ToolRegistry();
      registerMemoryTools(reg, { homeDir: home });
      expect(reg.get("remember")?.readOnly).not.toBe(true);
      expect(reg.get("forget")?.readOnly).not.toBe(true);
    });
  });
});
