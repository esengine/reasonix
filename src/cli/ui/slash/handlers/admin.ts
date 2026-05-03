import {
  HOOK_EVENTS,
  type HookEvent,
  type ResolvedHook,
  globalSettingsPath,
  projectSettingsPath,
} from "../../../../hooks.js";
import { t } from "../../../../i18n/index.js";
import { aggregateUsage, defaultUsageLogPath, readUsageLog } from "../../../../telemetry/usage.js";
import { VERSION, compareVersions, isNpxInstall } from "../../../../version.js";
import { runDoctorChecks } from "../../../commands/doctor.js";
import { renderDashboard } from "../../../commands/stats.js";
import type { SlashHandler } from "../dispatch.js";

const doctor: SlashHandler = (_args, _loop, ctx) => {
  const root = ctx.codeRoot ?? process.cwd();
  if (!ctx.postDoctor) return { info: t("handlers.admin.doctorNeedsTui") };
  void (async () => {
    const checks = await runDoctorChecks(root);
    ctx.postDoctor!(
      checks.map((c) => ({ label: c.label.trim(), level: c.level, detail: c.detail })),
    );
  })();
  return { info: t("handlers.admin.doctorRunning") };
};

const hooks: SlashHandler = (args, loop, ctx) => {
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "reload") {
    if (!ctx.reloadHooks) {
      return { info: t("handlers.admin.hooksReloadUnavailable") };
    }
    const count = ctx.reloadHooks();
    return { info: t("handlers.admin.hooksReloaded", { count }) };
  }

  if (sub !== "" && sub !== "list" && sub !== "ls") {
    return { info: t("handlers.admin.hooksUsage") };
  }

  const all = loop.hooks;
  const projPath = ctx.codeRoot ? projectSettingsPath(ctx.codeRoot) : undefined;
  const globPath = globalSettingsPath();
  if (all.length === 0) {
    const lines = [
      t("handlers.admin.hooksNone"),
      "",
      t("handlers.admin.hooksDropHint"),
      ctx.codeRoot
        ? t("handlers.admin.hooksProject", { path: projPath! })
        : t("handlers.admin.hooksProjectFallback"),
      t("handlers.admin.hooksGlobal", { path: globPath }),
      "",
      t("handlers.admin.hooksEvents"),
      t("handlers.admin.hooksExitCodes"),
    ];
    return { info: lines.join("\n") };
  }

  const grouped = new Map<HookEvent, ResolvedHook[]>();
  for (const event of HOOK_EVENTS) grouped.set(event, []);
  for (const h of all) grouped.get(h.event)?.push(h);

  const lines: string[] = [t("handlers.admin.hooksLoaded", { count: all.length })];
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
  lines.push(
    "",
    t("handlers.admin.hooksSources", {
      project: projPath ?? "(none — chat mode)",
      global: globPath,
    }),
  );
  return { info: lines.join("\n") };
};

const update: SlashHandler = (_args, _loop, ctx) => {
  const latest = ctx.latestVersion ?? null;
  const lines: string[] = [t("handlers.admin.updateCurrent", { version: VERSION })];
  if (latest === null) {
    ctx.refreshLatestVersion?.();
    lines.push(
      t("handlers.admin.updateLatestPending"),
      "",
      t("handlers.admin.updateRetryHint"),
      t("handlers.admin.updateRetryHint2"),
    );
    return { info: lines.join("\n") };
  }
  lines.push(t("handlers.admin.updateLatest", { version: latest }));
  const diff = compareVersions(VERSION, latest);
  if (diff >= 0) {
    lines.push("", t("handlers.admin.updateUpToDate"));
    return { info: lines.join("\n") };
  }
  if (isNpxInstall()) {
    lines.push("", t("handlers.admin.updateNpxHint"), t("handlers.admin.updateNpxForce"));
  } else {
    lines.push(
      "",
      t("handlers.admin.updateUpgradeHint"),
      t("handlers.admin.updateUpgradeCmd1"),
      t("handlers.admin.updateUpgradeCmd2"),
      "",
      t("handlers.admin.updateInSessionDisabled"),
      t("handlers.admin.updateInSessionDisabled2"),
    );
  }
  return { info: lines.join("\n") };
};

const stats: SlashHandler = () => {
  const path = defaultUsageLogPath();
  const records = readUsageLog(path);
  if (records.length === 0) {
    return {
      info: [
        t("handlers.admin.statsNoData"),
        "",
        `  ${path}`,
        "",
        t("handlers.admin.statsEveryTurn"),
        t("handlers.admin.statsWillAppear"),
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
  doctor,
};
