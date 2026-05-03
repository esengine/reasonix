import { basename } from "node:path";
import { listPlanArchives, loadPlanState, relativeTime } from "../../../../code/plan-store.js";
import { t } from "../../../../i18n/index.js";
import type { SlashHandler } from "../dispatch.js";

const plans: SlashHandler = (_args, loop) => {
  const sessionName = loop.sessionName;
  if (!sessionName) {
    return { info: t("handlers.plans.noSession") };
  }
  const lines: string[] = [];
  const active = loadPlanState(sessionName);
  if (active && active.steps.length > 0) {
    const total = active.steps.length;
    const done = active.completedStepIds.length;
    const when = relativeTime(active.updatedAt);
    const label = active.summary ? `: ${active.summary}` : "";
    lines.push(
      t("handlers.plans.activePlan", {
        label,
        done,
        total,
        s: total === 1 ? "" : "s",
        when,
      }),
    );
  } else {
    lines.push(t("handlers.plans.activeNone"));
  }

  const archives = listPlanArchives(sessionName);
  if (archives.length === 0) {
    lines.push("");
    lines.push(t("handlers.plans.noArchives"));
    return { info: lines.join("\n") };
  }
  lines.push("");
  lines.push(t("handlers.plans.archivedHeader", { count: archives.length }));
  for (const a of archives) {
    const when = relativeTime(a.completedAt);
    const total = a.steps.length;
    const done = a.completedStepIds.length;
    const completion = done >= total ? "complete" : `${done}/${total}`;
    const label = a.summary ?? a.path.split(/[\\/]/).pop() ?? a.path;
    lines.push(
      `  ✓ ${when.padEnd(10)}  ${total} step${total === 1 ? "" : "s"} · ${completion}  ${label}`,
    );
  }
  return { info: lines.join("\n") };
};

const replay: SlashHandler = (args, loop) => {
  const sessionName = loop.sessionName;
  if (!sessionName) {
    return { info: t("handlers.plans.replayNoSession") };
  }
  const archives = listPlanArchives(sessionName);
  if (archives.length === 0) {
    return { info: t("handlers.plans.replayNoArchives") };
  }
  const arg = args[0]?.trim() ?? "";
  const index = arg ? Number.parseInt(arg, 10) : 1;
  if (!Number.isFinite(index) || index < 1 || index > archives.length) {
    return {
      info: t("handlers.plans.replayInvalidIndex", { max: archives.length }),
    };
  }
  const a = archives[index - 1]!;
  return {
    replayPlan: {
      summary: a.summary,
      body: a.body,
      steps: a.steps,
      completedStepIds: a.completedStepIds,
      completedAt: a.completedAt,
      relativeTime: relativeTime(a.completedAt),
      archiveBasename: basename(a.path),
      index,
      total: archives.length,
    },
  };
};

export const handlers: Record<string, SlashHandler> = {
  plans,
  replay,
};
