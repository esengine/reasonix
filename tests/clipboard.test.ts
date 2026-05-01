import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeClipboard } from "../src/cli/ui/clipboard.js";

describe("writeClipboard", () => {
  const testDir = join(tmpdir(), `reasonix-clip-test-${process.pid}`);
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  const createdFiles: string[] = [];

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    createdFiles.length = 0;
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    for (const f of createdFiles) {
      if (existsSync(f)) {
        rmSync(f, { force: true });
      }
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("writes OSC 52 escape for short ASCII text", () => {
    const input = "hello world";
    const result = writeClipboard(input);
    if (result.filePath) createdFiles.push(result.filePath);

    expect(result.osc52).toBe(true);
    expect(result.size).toBe(11);

    const expectedB64 = Buffer.from(input, "utf8").toString("base64");
    expect(stdoutWriteSpy).toHaveBeenCalledWith(`\x1b]52;c;${expectedB64}\x1b\\`);
  });

  it("encodes UTF-8 correctly in OSC 52", () => {
    const input = "你好世界 · ¥48.20";
    const result = writeClipboard(input);
    if (result.filePath) createdFiles.push(result.filePath);

    expect(result.osc52).toBe(true);
    expect(result.size).toBe(input.length);

    const expectedB64 = Buffer.from(input, "utf8").toString("base64");
    expect(stdoutWriteSpy).toHaveBeenCalledWith(`\x1b]52;c;${expectedB64}\x1b\\`);
  });

  it("handles empty string", () => {
    const result = writeClipboard("");
    if (result.filePath) createdFiles.push(result.filePath);

    expect(result.osc52).toBe(true);
    expect(result.size).toBe(0);

    const expectedB64 = Buffer.from("", "utf8").toString("base64");
    expect(stdoutWriteSpy).toHaveBeenCalledWith(`\x1b]52;c;${expectedB64}\x1b\\`);
  });

  it("writes to tmp file for content over size budget", () => {
    const input = "x".repeat(80_000); // Over 75K limit
    const result = writeClipboard(input);
    if (result.filePath) createdFiles.push(result.filePath);

    expect(result.osc52).toBe(false);
    expect(result.size).toBe(80_000);
    expect(result.filePath).toBeTruthy();
    expect(result.filePath).toContain("reasonix-clip-");

    // Verify file contents match input
    const fileContent = readFileSync(result.filePath!, "utf8");
    expect(fileContent).toBe(input);
  });

  it("returns correct size for both paths", () => {
    const shortResult = writeClipboard("short");
    if (shortResult.filePath) createdFiles.push(shortResult.filePath);
    expect(shortResult.size).toBe(5);

    const longResult = writeClipboard("x".repeat(100_000));
    if (longResult.filePath) createdFiles.push(longResult.filePath);
    expect(longResult.size).toBe(100_000);
  });
});
