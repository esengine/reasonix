import {
  createCheckpoint,
  deleteCheckpoint,
  findCheckpoint,
  fmtAgo,
  listCheckpoints,
  restoreCheckpoint,
} from "../../../../code/checkpoints.js";
import type { EditMode } from "../../../../config.js";
import { t } from "../../../../i18n/index.js";
import { parseEditIndices } from "../../edit-history.js";
import type { SlashHandler } from "../dispatch.js";
import { runGitCommit, stripOuterQuotes } from "../helpers.js";

const undo: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeUndo) {
    return { info: t("handlers.edits.undoCodeOnly") };
  }
  return { info: ctx.codeUndo(args) };
};

const history: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.codeHistory) {
    return { info: t("handlers.edits.historyCodeOnly") };
  }
  return { info: ctx.codeHistory() };
};

const show: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeShowEdit) {
    return { info: t("handlers.edits.showCodeOnly") };
  }
  return { info: ctx.codeShowEdit(args) };
};

const apply: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeApply) {
    return { info: t("handlers.edits.applyCodeOnly") };
  }
  const parsed = parseIndicesArg(args, ctx.pendingEditCount ?? 0);
  if ("error" in parsed) return { info: `/apply: ${parsed.error}` };
  return { info: ctx.codeApply(parsed.indices) };
};

const discard: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeDiscard) {
    return { info: t("handlers.edits.discardCodeOnly") };
  }
  const parsed = parseIndicesArg(args, ctx.pendingEditCount ?? 0);
  if ("error" in parsed) return { info: `/discard: ${parsed.error}` };
  return { info: ctx.codeDiscard(parsed.indices) };
};

function parseIndicesArg(
  args: readonly string[],
  max: number,
): { indices: readonly number[] } | { error: string } {
  const raw = args.join(",").replace(/,+/g, ",").replace(/^,|,$/g, "");
  if (!raw) return { indices: [] };
  const parsed = parseEditIndices(raw, max);
  if ("error" in parsed) return { error: parsed.error };
  return { indices: parsed.ok };
}

const plan: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.setPlanMode) {
    return { info: t("handlers.edits.planCodeOnly") };
  }
  const currentOn = Boolean(ctx.planMode);
  const raw = (args[0] ?? "").toLowerCase();
  let target: boolean;
  if (raw === "on" || raw === "true" || raw === "1") target = true;
  else if (raw === "off" || raw === "false" || raw === "0") target = false;
  else target = !currentOn;
  ctx.setPlanMode(target);
  if (target) {
    return { info: t("handlers.edits.planOn") };
  }
  return { info: t("handlers.edits.planOff") };
};

const applyPlan: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.setPlanMode) {
    return { info: t("handlers.edits.applyPlanCodeOnly") };
  }
  ctx.setPlanMode(false);
  ctx.clearPendingPlan?.();
  return {
    info: t("handlers.edits.applyPlanInfo"),
    resubmit: t("handlers.edits.applyPlanResubmit"),
  };
};

const mode: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.setEditMode) {
    return { info: t("handlers.edits.modeCodeOnly") };
  }
  const raw = (args[0] ?? "").toLowerCase();
  const current = ctx.editMode ?? "review";
  let target: EditMode;
  if (raw === "review") target = "review";
  else if (raw === "auto") target = "auto";
  else if (raw === "yolo") target = "yolo";
  else if (raw === "") {
    target = current === "review" ? "auto" : current === "auto" ? "yolo" : "review";
  } else {
    return { info: t("handlers.edits.modeUsage") };
  }
  ctx.setEditMode(target);
  const banner =
    target === "yolo"
      ? t("handlers.edits.modeYolo")
      : target === "auto"
        ? t("handlers.edits.modeAuto")
        : t("handlers.edits.modeReview");
  return { info: banner };
};

const commit: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeRoot) {
    return { info: t("handlers.edits.commitCodeOnly") };
  }
  const raw = args.join(" ").trim();
  const message = stripOuterQuotes(raw);
  if (!message) {
    return { info: t("handlers.edits.commitUsage", { root: ctx.codeRoot }) };
  }
  return runGitCommit(ctx.codeRoot, message);
};

const walk: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.startWalkthrough) {
    return { info: t("handlers.edits.walkCodeOnly") };
  }
  return { info: ctx.startWalkthrough() };
};

const checkpoint: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeRoot || !ctx.touchedFiles) {
    return { info: t("handlers.edits.checkpointCodeOnly") };
  }
  const sub = (args[0] ?? "").toLowerCase();
  const rest = args.slice(1).join(" ").trim();

  if (sub === "" || sub === "list") {
    const items = [...listCheckpoints(ctx.codeRoot)].reverse();
    if (items.length === 0) {
      return { info: t("handlers.edits.checkpointNone") };
    }
    const lines = [t("handlers.edits.checkpointHeader", { count: items.length }), ""];
    for (const m of items) {
      const sizeKb = (m.bytes / 1024).toFixed(1);
      const tag = m.source === "manual" ? "" : ` (${m.source})`;
      lines.push(
        `  ${m.id}  ${fmtAgo(m.createdAt).padEnd(8)}  ${m.name}${tag}  ·  ${m.fileCount} file${m.fileCount === 1 ? "" : "s"}, ${sizeKb} KB`,
      );
    }
    lines.push("");
    lines.push(t("handlers.edits.checkpointRestoreHint"));
    return { info: lines.join("\n") };
  }

  if (sub === "forget" || sub === "rm" || sub === "delete") {
    if (!rest) return { info: t("handlers.edits.checkpointForgetUsage") };
    const found = findCheckpoint(ctx.codeRoot, rest);
    if (!found) return { info: t("handlers.edits.checkpointNoMatch", { name: rest }) };
    const ok = deleteCheckpoint(ctx.codeRoot, found.id);
    return {
      info: ok
        ? t("handlers.edits.checkpointDeleted", { id: found.id, name: found.name })
        : t("handlers.edits.checkpointDeleteFailed", { id: found.id }),
    };
  }

  const name = args.join(" ").trim();
  if (!name) {
    return { info: t("handlers.edits.checkpointSaveUsage") };
  }
  const paths = ctx.touchedFiles();
  const meta = createCheckpoint({
    rootDir: ctx.codeRoot,
    name,
    paths,
    source: "manual",
  });
  if (paths.length === 0) {
    return {
      info: t("handlers.edits.checkpointSavedEmpty", { name, id: meta.id }),
    };
  }
  return {
    info: t("handlers.edits.checkpointSaved", {
      name,
      id: meta.id,
      files: meta.fileCount,
      s: meta.fileCount === 1 ? "" : "s",
      size: (meta.bytes / 1024).toFixed(1),
    }),
  };
};

const restore: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeRoot) {
    return { info: t("handlers.edits.restoreCodeOnly") };
  }
  const target = args.join(" ").trim();
  if (!target) {
    return { info: t("handlers.edits.restoreUsage") };
  }
  const found = findCheckpoint(ctx.codeRoot, target);
  if (!found) {
    return { info: t("handlers.edits.restoreNoMatch", { target }) };
  }
  const result = restoreCheckpoint(ctx.codeRoot, found.id);
  const lines = [
    t("handlers.edits.restoreInfo", {
      name: found.name,
      id: found.id,
      when: fmtAgo(found.createdAt),
    }),
  ];
  if (result.restored.length > 0) {
    lines.push(
      t("handlers.edits.restoreWrote", {
        count: result.restored.length,
        s: result.restored.length === 1 ? "" : "s",
      }),
    );
  }
  if (result.removed.length > 0) {
    lines.push(
      t("handlers.edits.restoreRemoved", {
        count: result.removed.length,
        s: result.removed.length === 1 ? "" : "s",
      }),
    );
  }
  if (result.skipped.length > 0) {
    lines.push(
      t("handlers.edits.restoreSkipped", {
        count: result.skipped.length,
        s: result.skipped.length === 1 ? "" : "s",
      }),
    );
    for (const s of result.skipped.slice(0, 5)) {
      lines.push(`    ${s.path} — ${s.reason}`);
    }
    if (result.skipped.length > 5) {
      lines.push(`    … ${result.skipped.length - 5} more`);
    }
  }
  return { info: lines.join("\n") };
};

export const handlers: Record<string, SlashHandler> = {
  undo,
  history,
  show,
  apply,
  discard,
  plan,
  "apply-plan": applyPlan,
  applyplan: applyPlan,
  mode,
  commit,
  walk,
  checkpoint,
  restore,
};
