import { SkillStore } from "../../../../skills.js";
import type { SlashHandler } from "../dispatch.js";

/**
 * `/skill` family. Bare `/skill` (or `/skill list`) prints the
 * discovered skills from `<projectRoot>/.reasonix/skills` (code mode
 * only) + `~/.reasonix/skills`. `/skill show <name>` dumps one body
 * inline for reading. `/skill <name> [args...]` injects the skill body
 * as a user turn via `resubmit` — the same mechanism `/apply-plan`
 * uses — so the next model turn runs with the skill's instructions
 * fresh in the log.
 *
 * Project scope is only populated when the session has a `codeRoot`
 * (set by `reasonix code`). In plain chat mode the store reads the
 * global scope only, matching how user-memory behaves.
 */
const skill: SlashHandler = (args, _loop, ctx) => {
  const store = new SkillStore({ projectRoot: ctx.codeRoot });
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "" || sub === "list" || sub === "ls") {
    const skills = store.list();
    if (skills.length === 0) {
      const lines = ["no skills found. Reasonix reads skills from:"];
      if (store.hasProjectScope()) {
        lines.push(
          "  · <project>/.reasonix/skills/<name>/SKILL.md  (or <name>.md)  — project scope",
        );
      }
      lines.push("  · ~/.reasonix/skills/<name>/SKILL.md  (or <name>.md)  — global scope");
      if (!store.hasProjectScope()) {
        lines.push("  (project scope is only active in `reasonix code`)");
      }
      lines.push(
        "",
        "Each file's frontmatter needs at least `name` and `description`.",
        "Invoke a skill with `/skill <name> [args]` or by asking the model to call `run_skill`.",
      );
      return { info: lines.join("\n") };
    }
    const lines = [`User skills (${skills.length}):`];
    for (const s of skills) {
      const scope = `(${s.scope})`.padEnd(11);
      const name = s.name.padEnd(24);
      const desc = s.description.length > 70 ? `${s.description.slice(0, 69)}…` : s.description;
      lines.push(`  ${scope} ${name}  ${desc}`);
    }
    lines.push("");
    lines.push("View body: /skill show <name>   Run: /skill <name> [args]");
    return { info: lines.join("\n") };
  }

  if (sub === "show" || sub === "cat") {
    const target = args[1];
    if (!target) return { info: "usage: /skill show <name>" };
    const found = store.read(target);
    if (!found) return { info: `no skill found: ${target}` };
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

  // Bare `/skill <name> [args...]` — inject the body as a user turn.
  // The first arg is the skill name; remaining args are forwarded
  // verbatim as the skill's "Arguments:" line.
  const name = args[0] ?? "";
  const found = store.read(name);
  if (!found) {
    return {
      info: `no skill found: ${name}  (try /skill list)`,
    };
  }
  const extra = args.slice(1).join(" ").trim();
  const header = `# Skill: ${found.name}${found.description ? `\n> ${found.description}` : ""}`;
  const argsLine = extra ? `\n\nArguments: ${extra}` : "";
  const payload = `${header}\n\n${found.body}${argsLine}`;
  return {
    info: `▸ running skill: ${found.name}${extra ? ` — ${extra}` : ""}`,
    resubmit: payload,
  };
};

export const handlers: Record<string, SlashHandler> = {
  skill,
  skills: skill,
};
