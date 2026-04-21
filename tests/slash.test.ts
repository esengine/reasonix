import { describe, expect, it, vi } from "vitest";
import { handleSlash, parseSlash } from "../src/cli/ui/slash.js";
import { DeepSeekClient } from "../src/client.js";
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
    expect(r.info).toMatch(/model=/);
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
