import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleSlash } from "../src/cli/ui/slash/dispatch.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../src/index.js";
import { ToolRegistry } from "../src/tools.js";

function makeLoop(): CacheFirstLoop {
  const tools = new ToolRegistry();
  return new CacheFirstLoop({
    client: new DeepSeekClient({ apiKey: "sk-test" }),
    prefix: new ImmutablePrefix({ system: "s", toolSpecs: [] }),
    tools,
    maxToolIters: 1,
    stream: false,
  });
}

describe("/init slash handler", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-init-slash-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses outside code mode (no codeRoot)", () => {
    const loop = makeLoop();
    const result = handleSlash("init", [], loop, {});
    expect(result.info).toMatch(/only works in code mode/i);
    expect(result.resubmit).toBeUndefined();
  });

  it("emits the structured init prompt as resubmit when REASONIX.md does not exist", () => {
    const loop = makeLoop();
    const result = handleSlash("init", [], loop, { codeRoot: tmp });
    expect(result.resubmit).toBeDefined();
    expect(result.resubmit).toMatch(/Initialize REASONIX.md/);
    // The hard length cap is the most important constraint — pin it.
    expect(result.resubmit).toMatch(/≤\s*80\s*lines/);
    // The "STOP after writing" line is load-bearing for flash; pin it
    // so a future tightening pass doesn't accidentally drop it.
    expect(result.resubmit).toMatch(/STOP/);
    expect(result.info).toMatch(/scan the project/);
  });

  it("refuses overwriting an existing REASONIX.md without `force`", () => {
    writeFileSync(join(tmp, "REASONIX.md"), "# pre-existing");
    const loop = makeLoop();
    const result = handleSlash("init", [], loop, { codeRoot: tmp });
    expect(result.resubmit).toBeUndefined();
    expect(result.info).toMatch(/already exists/);
    expect(result.info).toMatch(/\/init force/);
  });

  it("`/init force` proceeds even when REASONIX.md exists", () => {
    writeFileSync(join(tmp, "REASONIX.md"), "# pre-existing");
    const loop = makeLoop();
    const result = handleSlash("init", ["force"], loop, { codeRoot: tmp });
    expect(result.resubmit).toBeDefined();
    expect(result.resubmit).toMatch(/Initialize REASONIX.md/);
    expect(result.info).toMatch(/scan the project/);
  });

  it("`force` matching is case-insensitive", () => {
    writeFileSync(join(tmp, "REASONIX.md"), "# pre-existing");
    const loop = makeLoop();
    const result = handleSlash("init", ["FORCE"], loop, { codeRoot: tmp });
    expect(result.resubmit).toBeDefined();
  });
});
