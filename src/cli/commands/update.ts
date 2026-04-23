/**
 * `reasonix update` — self-upgrade command.
 *
 * Talks to the npm registry, compares against the running version,
 * and either runs `npm install -g reasonix@latest` (global install)
 * or advises how to refresh the npx cache (ephemeral install).
 *
 * The decision logic is factored into `planUpdate()` so it can be
 * unit-tested without spawning child processes or hitting the
 * network. `updateCommand()` is the thin CLI wrapper that calls
 * `getLatestVersion`, passes the result into `planUpdate`, and
 * executes any suggested command.
 */

import { spawn } from "node:child_process";
import { VERSION, compareVersions, getLatestVersion, isNpxInstall } from "../../version.js";

export type UpdateAction = "up-to-date" | "newer-local" | "npx-hint" | "run-npm-install";

export interface UpdatePlan {
  action: UpdateAction;
  /** Human-readable summary; the CLI prints this verbatim. */
  message: string;
  /**
   * Argv for the install command when `action === "run-npm-install"`.
   * Absent otherwise. Kept as array so the CLI can pass it straight
   * to `spawn` without re-parsing shell syntax.
   */
  command?: string[];
}

export interface PlanUpdateInput {
  current: string;
  latest: string;
  /** Overrides `isNpxInstall()` (tests). */
  npx?: boolean;
}

/**
 * Pure decision function: given current + latest + install kind,
 * decide what the CLI should do. No I/O.
 *
 *   newer-local     — current > latest (dev build, local publish)
 *   up-to-date      — current === latest
 *   npx-hint        — current < latest AND running under npx
 *   run-npm-install — current < latest AND running as a real install
 */
export function planUpdate(input: PlanUpdateInput): UpdatePlan {
  const diff = compareVersions(input.current, input.latest);
  if (diff > 0) {
    return {
      action: "newer-local",
      message: `current (${input.current}) is newer than the published ${input.latest} — nothing to do.`,
    };
  }
  if (diff === 0) {
    return { action: "up-to-date", message: `reasonix ${input.current} is up to date.` };
  }
  if (input.npx) {
    return {
      action: "npx-hint",
      message: [
        `reasonix ${input.latest} is available.`,
        "you're running via npx — the next `npx reasonix ...` launch will auto-fetch",
        "the latest (npx caches packages for a short window). to force a refresh",
        "sooner, clear the cache: `npm cache clean --force`.",
      ].join("\n"),
    };
  }
  return {
    action: "run-npm-install",
    message: `upgrading reasonix ${input.current} → ${input.latest}`,
    command: ["npm", "install", "-g", "reasonix@latest"],
  };
}

export interface UpdateCommandOptions {
  /** Skip spawning npm; print the decision only. */
  dryRun?: boolean;
  /** Test seam: override the registry lookup. Returns null = offline. */
  fetchLatest?: () => Promise<string | null>;
  /** Test seam: override the npx detector. */
  isNpx?: () => boolean;
  /** Test seam: override the spawner. Must return exit code. */
  spawnInstall?: (argv: string[]) => Promise<number>;
  /** Test seam: stdout writer. */
  write?: (msg: string) => void;
  /** Test seam: process exit — tests don't want to tear down vitest. */
  exit?: (code: number) => void;
}

function defaultSpawn(argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    // `shell: true` on Windows is what lets `npm` resolve to `npm.cmd`
    // without routing through our `prepareSpawn` helper. The args here
    // are literal strings under our control — no user input flows in,
    // so injection is not a concern. Avoiding `prepareSpawn` keeps
    // this command free of a dep on the shell tools module.
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Run the update command. Prints a banner, resolves the latest
 * version, prints the plan, and (unless `--dry-run`) executes the
 * install when applicable.
 */
export async function updateCommand(opts: UpdateCommandOptions = {}): Promise<void> {
  const write = opts.write ?? ((m: string) => process.stdout.write(m));
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  const fetchLatest = opts.fetchLatest ?? (() => getLatestVersion({ force: true }));
  const isNpx = opts.isNpx ?? isNpxInstall;
  const doSpawn = opts.spawnInstall ?? defaultSpawn;

  write(`current: reasonix ${VERSION}\n`);
  const latest = await fetchLatest();
  if (!latest) {
    write("could not reach registry.npmjs.org — check your network.\n");
    exit(1);
    return;
  }
  write(`latest:  reasonix ${latest}\n`);

  const plan = planUpdate({ current: VERSION, latest, npx: isNpx() });
  write(`\n${plan.message}\n`);

  if (plan.action !== "run-npm-install" || !plan.command) return;
  if (opts.dryRun) {
    write(`(dry run) would run: ${plan.command.join(" ")}\n`);
    return;
  }
  write(`\nrunning: ${plan.command.join(" ")}\n`);
  const code = await doSpawn(plan.command);
  if (code !== 0) {
    write(`\nnpm exited with code ${code}. upgrade did not complete.\n`);
    exit(code);
  }
}
