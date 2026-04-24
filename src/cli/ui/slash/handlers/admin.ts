import {
  HOOK_EVENTS,
  type HookEvent,
  type ResolvedHook,
  globalSettingsPath,
  projectSettingsPath,
} from "../../../../hooks.js";
import { aggregateUsage, defaultUsageLogPath, readUsageLog } from "../../../../usage.js";
import { VERSION, compareVersions, isNpxInstall } from "../../../../version.js";
import { renderDashboard } from "../../../commands/stats.js";
import type { SlashHandler } from "../dispatch.js";

const hooks: SlashHandler = (args, loop, ctx) => {
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "reload") {
    if (!ctx.reloadHooks) {
      return {
        info: "/hooks reload is not available in this context (no reload callback wired).",
      };
    }
    const count = ctx.reloadHooks();
    return { info: `▸ reloaded hooks · ${count} active` };
  }

  if (sub !== "" && sub !== "list" && sub !== "ls") {
    return {
      info: "usage: /hooks            list active hooks\n       /hooks reload     re-read settings.json files",
    };
  }

  const all = loop.hooks;
  const projPath = ctx.codeRoot ? projectSettingsPath(ctx.codeRoot) : undefined;
  const globPath = globalSettingsPath();
  if (all.length === 0) {
    const lines = [
      "no hooks configured.",
      "",
      "drop a settings.json with a `hooks` key into either of:",
      ctx.codeRoot
        ? `  · ${projPath} (project)`
        : "  · <project>/.reasonix/settings.json (project)",
      `  · ${globPath} (global)`,
      "",
      "events: PreToolUse, PostToolUse, UserPromptSubmit, Stop",
      "exit 0 = pass · exit 2 = block (Pre*) · other = warn",
    ];
    return { info: lines.join("\n") };
  }

  const grouped = new Map<HookEvent, ResolvedHook[]>();
  for (const event of HOOK_EVENTS) grouped.set(event, []);
  for (const h of all) grouped.get(h.event)?.push(h);

  const lines: string[] = [`▸ ${all.length} hook(s) loaded`];
  for (const event of HOOK_EVENTS) {
    const list = grouped.get(event) ?? [];
    if (list.length === 0) continue;
    lines.push("", `${event}:`);
    for (const h of list) {
      const match = h.match && h.match !== "*" ? ` match=${h.match}` : "";
      const desc = h.description ? `  — ${h.description}` : "";
      lines.push(`  [${h.scope}]${match} ${h.command}${desc}`);
    }
  }
  lines.push("", `sources: project=${projPath ?? "(none — chat mode)"} · global=${globPath}`);
  return { info: lines.join("\n") };
};

/**
 * `/update` — inside the TUI we deliberately do NOT spawn `npm install`.
 * stdio:inherit into a running Ink renderer corrupts the display, and
 * the process being upgraded is the same process that's still reading
 * its own binaries (messy on Windows). Instead we surface what we
 * already know from the App's background registry check and print the
 * exact shell command the user should run after exiting.
 *
 * The `latestVersion` ctx field is populated by App.tsx's mount-time
 * `getLatestVersion()` effect. When it's `null` we report the check
 * as pending/offline — still a useful output (current version + how
 * to force a fresh check from another terminal).
 */
const update: SlashHandler = (_args, _loop, ctx) => {
  const latest = ctx.latestVersion ?? null;
  const lines: string[] = [`current: reasonix ${VERSION}`];
  if (latest === null) {
    // Kick off a fresh fetch so a follow-up /update a few seconds
    // later has a real answer instead of the same pending message.
    ctx.refreshLatestVersion?.();
    lines.push(
      "latest:  (not yet resolved — background check in flight or offline)",
      "",
      "triggered a fresh registry fetch — retry `/update` in a few seconds,",
      "or run `reasonix update` in another terminal to force it synchronously.",
    );
    return { info: lines.join("\n") };
  }
  lines.push(`latest:  reasonix ${latest}`);
  const diff = compareVersions(VERSION, latest);
  if (diff >= 0) {
    lines.push("", "you're on the latest. nothing to do.");
    return { info: lines.join("\n") };
  }
  if (isNpxInstall()) {
    lines.push(
      "",
      "you're running via npx — the next `npx reasonix ...` launch will auto-fetch.",
      "to force a refresh sooner: `npm cache clean --force`.",
    );
  } else {
    lines.push(
      "",
      "to upgrade, exit this session and run:",
      "  reasonix update           (interactive, dry-run supported via --dry-run)",
      "  npm install -g reasonix@latest   (direct)",
      "",
      "in-session install is deliberately disabled — the npm spawn would",
      "corrupt this TUI's rendering and Windows can lock the running binary.",
    );
  }
  return { info: lines.join("\n") };
};

/**
 * `/stats` — dashboard view of `~/.reasonix/usage.jsonl`, the same
 * roll-up `reasonix stats` (no arg) prints at the shell. Synchronous
 * disk read; cheap enough that we don't bother caching between slash
 * invocations.
 *
 * No transcript-path variant in-TUI: the per-file summary is scripty
 * and rarely wanted mid-session. If someone needs it they have the
 * CLI form (`reasonix stats <path>`).
 */
const stats: SlashHandler = () => {
  const path = defaultUsageLogPath();
  const records = readUsageLog(path);
  if (records.length === 0) {
    return {
      info: [
        "no usage data yet.",
        "",
        `  ${path}`,
        "",
        "every turn you run here appends one record — this session's turns",
        "will show up in the dashboard once you send a message.",
      ].join("\n"),
    };
  }
  const agg = aggregateUsage(records);
  return { info: renderDashboard(agg, path) };
};

export const handlers: Record<string, SlashHandler> = {
  hook: hooks,
  hooks,
  update,
  stats,
};
