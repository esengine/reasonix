import {
  addProjectShellAllowed,
  clearProjectShellAllowed,
  loadProjectShellAllowed,
  removeProjectShellAllowed,
} from "../../../../config.js";
import { t } from "../../../../i18n/index.js";
import { BUILTIN_ALLOWLIST } from "../../../../tools/shell.js";
import type { SlashHandler } from "../dispatch.js";

const permissions: SlashHandler = (args, _loop, ctx) => {
  const sub = (args[0] ?? "").toLowerCase();
  const root = ctx.codeRoot;
  const mode = ctx.editMode ?? null;

  if (sub === "" || sub === "list" || sub === "ls") {
    return { info: renderListing(root, mode) };
  }

  if (!root) {
    return { info: t("handlers.permissions.mutateCodeOnly") };
  }

  if (sub === "add") {
    const prefix = args.slice(1).join(" ").trim();
    if (!prefix) {
      return { info: t("handlers.permissions.addUsage") };
    }
    const before = loadProjectShellAllowed(root);
    if (before.includes(prefix)) {
      return { info: t("handlers.permissions.addAlready", { prefix }) };
    }
    if (BUILTIN_ALLOWLIST.includes(prefix)) {
      return { info: t("handlers.permissions.addBuiltin", { prefix }) };
    }
    addProjectShellAllowed(root, prefix);
    return { info: t("handlers.permissions.addInfo", { prefix }) };
  }

  if (sub === "remove" || sub === "rm" || sub === "delete") {
    const target = args.slice(1).join(" ").trim();
    if (!target) {
      return { info: t("handlers.permissions.removeUsage") };
    }
    const existing = loadProjectShellAllowed(root);
    let prefix: string | null = null;
    if (/^\d+$/.test(target)) {
      const idx = Number.parseInt(target, 10);
      if (idx < 1 || idx > existing.length) {
        return {
          info:
            existing.length === 0
              ? t("handlers.permissions.removeEmpty")
              : t("handlers.permissions.removeIndexOob", { idx, count: existing.length }),
        };
      }
      prefix = existing[idx - 1] ?? null;
    } else {
      prefix = target;
    }
    if (prefix === null) return { info: t("handlers.permissions.removeNothing") };
    if (BUILTIN_ALLOWLIST.includes(prefix) && !existing.includes(prefix)) {
      return { info: t("handlers.permissions.removeBuiltin", { prefix }) };
    }
    const ok = removeProjectShellAllowed(root, prefix);
    return {
      info: ok
        ? t("handlers.permissions.removeInfo", { prefix })
        : t("handlers.permissions.removeNotFound", { prefix }),
    };
  }

  if (sub === "clear") {
    if ((args[1] ?? "").toLowerCase() !== "confirm") {
      const count = loadProjectShellAllowed(root).length;
      return {
        info:
          count === 0
            ? t("handlers.permissions.clearAlready")
            : t("handlers.permissions.clearConfirm", {
                count,
                plural: count === 1 ? "y" : "ies",
                root,
              }),
      };
    }
    const dropped = clearProjectShellAllowed(root);
    return {
      info:
        dropped === 0
          ? t("handlers.permissions.clearedNone")
          : t("handlers.permissions.cleared", {
              count: dropped,
              plural: dropped === 1 ? "y" : "ies",
            }),
    };
  }

  return { info: t("handlers.permissions.usage") };
};

function renderListing(root: string | undefined, mode: string | null): string {
  const lines: string[] = [];
  if (mode === "yolo") {
    lines.push(t("handlers.permissions.modeYolo"));
  } else if (mode === "auto") {
    lines.push(t("handlers.permissions.modeAuto"));
  } else if (mode === "review") {
    lines.push(t("handlers.permissions.modeReview"));
  }
  lines.push("");

  if (root) {
    const project = loadProjectShellAllowed(root);
    lines.push(t("handlers.permissions.projectHeader", { count: project.length, root }));
    if (project.length === 0) {
      lines.push(t("handlers.permissions.projectNone1"));
      lines.push(t("handlers.permissions.projectNone2"));
    } else {
      project.forEach((p, i) => {
        lines.push(`  ${String(i + 1).padStart(2)}. ${p}`);
      });
    }
  } else {
    lines.push(t("handlers.permissions.projectNoRoot"));
  }
  lines.push("");

  lines.push(t("handlers.permissions.builtinHeader", { count: BUILTIN_ALLOWLIST.length }));
  const grouped = new Map<string, string[]>();
  for (const entry of BUILTIN_ALLOWLIST) {
    const head = entry.split(" ")[0] ?? entry;
    if (!grouped.has(head)) grouped.set(head, []);
    grouped.get(head)!.push(entry);
  }
  for (const [head, items] of grouped) {
    if (items.length === 1 && items[0] === head) {
      lines.push(`  · ${head}`);
    } else {
      const tail = items.map((i) => i.slice(head.length).trim() || "(bare)").join(", ");
      lines.push(`  · ${head}: ${tail}`);
    }
  }
  lines.push("");
  lines.push(t("handlers.permissions.subcommands"));
  return lines.join("\n");
}

export const handlers: Record<string, SlashHandler> = {
  permissions,
  perms: permissions,
};
