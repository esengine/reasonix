import { t } from "../../../../i18n/index.js";
import { SkillStore } from "../../../../skills.js";
import type { SlashHandler } from "../dispatch.js";

const skill: SlashHandler = (args, _loop, ctx) => {
  const store = new SkillStore({ projectRoot: ctx.codeRoot });
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "" || sub === "list" || sub === "ls") {
    const skills = store.list();
    if (skills.length === 0) {
      const lines = [t("handlers.skill.listEmpty")];
      if (store.hasProjectScope()) {
        lines.push(t("handlers.skill.listProjectScope"));
      }
      lines.push(t("handlers.skill.listGlobalScope"));
      if (!store.hasProjectScope()) {
        lines.push(t("handlers.skill.listProjectOnly"));
      }
      lines.push("", t("handlers.skill.listFrontmatter"), t("handlers.skill.listInvoke"));
      return { info: lines.join("\n") };
    }
    const lines = [t("handlers.skill.listHeader", { count: skills.length })];
    for (const s of skills) {
      const scope = `(${s.scope})`.padEnd(11);
      const name = s.name.padEnd(24);
      const desc = s.description.length > 70 ? `${s.description.slice(0, 69)}…` : s.description;
      lines.push(`  ${scope} ${name}  ${desc}`);
    }
    lines.push("");
    lines.push(t("handlers.skill.listFooter"));
    return { info: lines.join("\n") };
  }

  if (sub === "show" || sub === "cat") {
    const target = args[1];
    if (!target) return { info: t("handlers.skill.showUsage") };
    const found = store.read(target);
    if (!found) return { info: t("handlers.skill.showNotFound", { name: target }) };
    return {
      info: [
        `▸ ${found.name}  (${found.scope})`,
        found.description ? `  ${found.description}` : "",
        `  ${found.path}`,
        "",
        found.body,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  }

  const name = args[0] ?? "";
  const found = store.read(name);
  if (!found) {
    return { info: t("handlers.skill.runNotFound", { name }) };
  }
  const extra = args.slice(1).join(" ").trim();
  const header = `# Skill: ${found.name}${found.description ? `\n> ${found.description}` : ""}`;
  const argsLine = extra ? `\n\nArguments: ${extra}` : "";
  const payload = `${header}\n\n${found.body}${argsLine}`;
  return {
    info: t("handlers.skill.runInfo", {
      name: found.name,
      args: extra ? ` — ${extra}` : "",
    }),
    resubmit: payload,
  };
};

export const handlers: Record<string, SlashHandler> = {
  skill,
  skills: skill,
};
