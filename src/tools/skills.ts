/**
 * `run_skill` — invoke a user-authored playbook from the Skills index.
 *
 * Two execution modes, picked at registration time per skill via
 * frontmatter `runAs`:
 *
 *   - `inline` (default) — the skill body becomes the tool result and
 *     enters the parent's append-only log. The model reads the
 *     instructions and continues the normal loop, calling whatever
 *     tools the skill prescribes. Cheap, no isolation. Best for
 *     "load a checklist" / "load a coding style" / "load review
 *     criteria" patterns.
 *
 *   - `subagent` — the skill body becomes the *system prompt* of an
 *     isolated child loop; the user-supplied `arguments` becomes the
 *     `task`. Only the child's final answer comes back as the tool
 *     result. Best for big-context exploration or research playbooks
 *     where the parent doesn't need to see the trail.
 *
 * Subagent dispatch is opt-in: callers must supply a `subagentRunner`
 * at registration. When omitted (chat mode without a configured
 * client), invoking a subagent skill returns a structured error
 * instead of silently downgrading to inline — that would surprise the
 * skill author.
 *
 * v1 deliberately ignores each skill's `allowed-tools` frontmatter:
 * Reasonix's tool namespace doesn't align with Claude Code's so a
 * literal pass would give wrong answers.
 */

import { type Skill, SkillStore } from "../skills.js";
import type { ToolRegistry } from "../tools.js";

/**
 * Caller-supplied closure that knows how to spawn a subagent for the
 * given resolved skill + task. Decoupled from `registerSkillTools` so
 * the skills tool doesn't need to know about DeepSeekClient or the
 * parent ToolRegistry — the App / library wiring assembles those once
 * and hands in this function.
 *
 * Returns the JSON tool-result string verbatim (already serialized via
 * `formatSubagentResult`), so the dispatch path is pure pass-through.
 */
export type SubagentRunner = (skill: Skill, task: string) => Promise<string>;

export interface SkillToolsOptions {
  /** Override `$HOME` — tests set this to a tmpdir. */
  homeDir?: string;
  /**
   * Absolute project root — enables discovery of project-scope skills
   * under `<projectRoot>/.reasonix/skills/`. Omit for chat mode (global
   * scope only).
   */
  projectRoot?: string;
  /**
   * Closure that spawns a subagent for `runAs: subagent` skills. When
   * omitted, invoking a subagent skill returns an error directing the
   * user to wire up the runner — silent fallback to inline would be
   * worse, since the skill author wrote the body assuming isolation.
   */
  subagentRunner?: SubagentRunner;
  /** Hide built-in skills (test-only knob; production callers leave off). */
  disableBuiltins?: boolean;
}

export function registerSkillTools(
  registry: ToolRegistry,
  opts: SkillToolsOptions = {},
): ToolRegistry {
  const store = new SkillStore({
    homeDir: opts.homeDir,
    projectRoot: opts.projectRoot,
    disableBuiltins: opts.disableBuiltins,
  });
  const subagentRunner = opts.subagentRunner;

  registry.register({
    name: "run_skill",
    description:
      "Invoke a playbook from the Skills index pinned in the system prompt. Each entry is a self-contained instruction block. Pass `name` as the BARE skill identifier (e.g. 'explore'), NOT the `[🧬 subagent]` tag that appears after it in the index. Entries tagged `[🧬 subagent]` spawn an isolated subagent — only the final distilled answer comes back, the model's tool calls + reasoning during the run never enter your context. Plain skills are inlined: the body becomes a tool result you read and follow. For subagent skills, supply 'arguments' describing the concrete task — they'll be the only context the subagent has.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Skill identifier as it appears in the pinned Skills index (e.g. 'explore', 'review', 'security-review'). Case-sensitive.",
        },
        arguments: {
          type: "string",
          description:
            "Free-form arguments the skill should act on. For inline skills: appended to the body as an 'Arguments:' line; the skill's own instructions decide how to consume them. For `[🧬 subagent]` skills: REQUIRED — becomes the entire task description the subagent receives, since it has no other context.",
        },
      },
      required: ["name"],
    },
    fn: async (args: { name?: unknown; arguments?: unknown }) => {
      const raw = typeof args.name === "string" ? args.name.trim() : "";
      if (!raw) {
        return JSON.stringify({ error: "run_skill requires a 'name' argument" });
      }
      // Defensive: The Skills index writes entries like
      // `explore [🧬 subagent]`, and models sometimes copy the
      // decoration verbatim into the `name` argument instead of just
      // the identifier. Rather than reject those calls:
      //   1. Drop any `[...]` bracketed tag (possibly containing
      //      emoji + "subagent" label).
      //   2. Find the first whitespace-delimited token whose first
      //      char is alphanumeric — that's the skill identifier,
      //      whether the tag came before or after the name.
      const stripped = raw.replace(/\[[^\]]*\]/g, " ").trim();
      const tokens = stripped.split(/\s+/).filter(Boolean);
      const name = tokens.find((t) => /^[a-zA-Z0-9]/.test(t)) ?? "";
      if (!name) {
        return JSON.stringify({
          error: "run_skill requires a 'name' argument",
          hint: `'${raw}' is just a marker/tag, not a skill name`,
        });
      }
      const skill = store.read(name);
      if (!skill) {
        const available = store
          .list()
          .map((s) => s.name)
          .join(", ");
        return JSON.stringify({
          error: `unknown skill: ${JSON.stringify(name)}`,
          available: available || "(none — user has not defined any skills)",
        });
      }
      const rawArgs = typeof args.arguments === "string" ? args.arguments.trim() : "";

      if (skill.runAs === "subagent") {
        if (!subagentRunner) {
          return JSON.stringify({
            error: `run_skill: skill ${JSON.stringify(name)} is marked runAs=subagent but no subagent runner is configured for this session. Skill authors who need isolation should run inside reasonix code (or a library setup that passes subagentRunner to registerSkillTools).`,
          });
        }
        if (!rawArgs) {
          return JSON.stringify({
            error: `run_skill: skill ${JSON.stringify(name)} is a subagent and requires 'arguments' — the subagent has no other context, so describe the concrete task in the arguments field.`,
          });
        }
        return subagentRunner(skill, rawArgs);
      }

      // inline path — body becomes the tool result.
      const header = [
        `# Skill: ${skill.name}`,
        skill.description ? `> ${skill.description}` : "",
        `(scope: ${skill.scope} · ${skill.path})`,
      ]
        .filter(Boolean)
        .join("\n");
      const argsBlock = rawArgs ? `\n\nArguments: ${rawArgs}` : "";
      // The body is handed to the model verbatim. No truncation — the
      // user authored it, we trust their length choice. The append-only
      // log pays the token cost exactly once per invocation.
      return `${header}\n\n${skill.body}${argsBlock}`;
    },
  });

  return registry;
}
