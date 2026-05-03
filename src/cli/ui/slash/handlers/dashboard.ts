import { t } from "../../../../i18n/index.js";
import type { SlashHandler } from "../dispatch.js";

const dashboard: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.startDashboard || !ctx.getDashboardUrl) {
    return { info: t("handlers.dashboard.notAvailable") };
  }

  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "stop" || sub === "off") {
    if (!ctx.stopDashboard) {
      return { info: t("handlers.dashboard.stopNoCallback") };
    }
    const url = ctx.getDashboardUrl();
    if (!url) return { info: t("handlers.dashboard.notRunning") };
    ctx.stopDashboard();
    return { info: t("handlers.dashboard.stopping") };
  }

  const existing = ctx.getDashboardUrl();
  if (existing) {
    return {
      info: [
        t("handlers.dashboard.alreadyRunning"),
        `  ${existing}`,
        "",
        t("handlers.dashboard.alreadyRunningHint"),
      ].join("\n"),
    };
  }

  ctx
    .startDashboard()
    .then((url) => {
      ctx.postInfo?.(
        [t("handlers.dashboard.ready"), `  ${url}`, "", t("handlers.dashboard.readyHint")].join(
          "\n",
        ),
      );
    })
    .catch((err: Error) => {
      ctx.postInfo?.(t("handlers.dashboard.failed", { reason: err.message }));
    });

  return { info: t("handlers.dashboard.starting") };
};

export const handlers: Record<string, SlashHandler> = { dashboard };
