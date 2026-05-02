/** reasonix update — pure planUpdate + orchestrator with every side effect mocked via test seams. */

import { describe, expect, it } from "vitest";
import { planUpdate, updateCommand } from "../src/cli/commands/update.js";
import { VERSION } from "../src/version.js";

describe("planUpdate", () => {
  it("up-to-date when current === latest", () => {
    const plan = planUpdate({ current: "0.4.22", latest: "0.4.22" });
    expect(plan.action).toBe("up-to-date");
    expect(plan.command).toBeUndefined();
  });

  it("newer-local when current > latest (dev build)", () => {
    const plan = planUpdate({ current: "0.5.0", latest: "0.4.22" });
    expect(plan.action).toBe("newer-local");
    expect(plan.command).toBeUndefined();
  });

  it("npx-hint when current < latest and running via npx", () => {
    const plan = planUpdate({ current: "0.4.21", latest: "0.4.22", npx: true });
    expect(plan.action).toBe("npx-hint");
    expect(plan.command).toBeUndefined();
    expect(plan.message).toContain("npx");
  });

  it("run-npm-install when current < latest and not npx", () => {
    const plan = planUpdate({ current: "0.4.21", latest: "0.4.22", npx: false });
    expect(plan.action).toBe("run-npm-install");
    expect(plan.command).toEqual(["npm", "install", "-g", "reasonix@latest"]);
  });
});

describe("updateCommand", () => {
  function harness() {
    const output: string[] = [];
    let exitCode: number | undefined;
    const spawnCalls: string[][] = [];
    return {
      output,
      get exitCode() {
        return exitCode;
      },
      spawnCalls,
      write: (m: string) => {
        output.push(m);
      },
      exit: (c: number) => {
        exitCode = c;
      },
      spawnInstall: async (argv: string[]) => {
        spawnCalls.push(argv);
        return 0;
      },
    };
  }

  it("prints up-to-date and does NOT spawn when current === latest", async () => {
    const h = harness();
    await updateCommand({
      fetchLatest: async () => VERSION,
      isNpx: () => false,
      write: h.write,
      exit: h.exit,
      spawnInstall: h.spawnInstall,
    });
    expect(h.output.join("")).toContain("up to date");
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.exitCode).toBeUndefined();
  });

  it("prints npx hint and does NOT spawn when running under npx", async () => {
    const h = harness();
    await updateCommand({
      fetchLatest: async () => "99.99.99",
      isNpx: () => true,
      write: h.write,
      exit: h.exit,
      spawnInstall: h.spawnInstall,
    });
    const joined = h.output.join("");
    expect(joined).toContain("99.99.99");
    expect(joined).toContain("npx");
    expect(h.spawnCalls).toHaveLength(0);
  });

  it("spawns npm install -g when global install is behind latest", async () => {
    const h = harness();
    await updateCommand({
      fetchLatest: async () => "99.99.99",
      isNpx: () => false,
      write: h.write,
      exit: h.exit,
      spawnInstall: h.spawnInstall,
    });
    expect(h.spawnCalls).toEqual([["npm", "install", "-g", "reasonix@latest"]]);
    expect(h.exitCode).toBeUndefined();
  });

  it("--dry-run prints the command but does not spawn", async () => {
    const h = harness();
    await updateCommand({
      fetchLatest: async () => "99.99.99",
      isNpx: () => false,
      dryRun: true,
      write: h.write,
      exit: h.exit,
      spawnInstall: h.spawnInstall,
    });
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.output.join("")).toContain("(dry run)");
  });

  it("exits non-zero when the registry is unreachable", async () => {
    const h = harness();
    await updateCommand({
      fetchLatest: async () => null,
      isNpx: () => false,
      write: h.write,
      exit: h.exit,
      spawnInstall: h.spawnInstall,
    });
    expect(h.output.join("")).toContain("could not reach");
    expect(h.exitCode).toBe(1);
  });

  it("surfaces non-zero npm exit via the exit seam", async () => {
    const h = harness();
    await updateCommand({
      fetchLatest: async () => "99.99.99",
      isNpx: () => false,
      write: h.write,
      exit: h.exit,
      spawnInstall: async () => 127,
    });
    expect(h.exitCode).toBe(127);
    expect(h.output.join("")).toContain("did not complete");
  });
});
