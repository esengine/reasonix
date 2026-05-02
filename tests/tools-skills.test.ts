/** run_skill — temp homeDir / projectRoot so the tool never reads real skill dirs. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { registerSkillTools } from "../src/tools/skills.js";

function writeSkill(baseDir: string, name: string, description: string, body: string): void {
  const dir = join(baseDir, ".reasonix", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

function writeSkillWithFrontmatter(
  baseDir: string,
  name: string,
  fm: Record<string, string>,
  body: string,
): void {
  const dir = join(baseDir, ".reasonix", "skills", name);
  mkdirSync(dir, { recursive: true });
  const lines = ["---", `name: ${name}`];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push("---", "");
  writeFileSync(join(dir, "SKILL.md"), `${lines.join("\n")}${body}\n`, "utf8");
}

describe("run_skill tool", () => {
  let home: string;
  let projectRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-skilltool-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-skilltool-proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("registers run_skill as a read-only tool", () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const tool = reg.get("run_skill");
    expect(tool).toBeDefined();
    expect(tool?.readOnly).toBe(true);
  });

  it("returns the skill body when the name resolves (global scope)", async () => {
    writeSkill(home, "review", "Review a PR", "Step 1: diff. Step 2: comment.");
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", { name: "review" });
    expect(out).toContain("# Skill: review");
    expect(out).toContain("Review a PR");
    expect(out).toContain("scope: global");
    expect(out).toContain("Step 1: diff");
  });

  it("resolves project-scope skills when projectRoot is passed", async () => {
    writeSkill(projectRoot, "deploy", "Deploy to staging", "Run pipeline.");
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, projectRoot, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", { name: "deploy" });
    expect(out).toContain("scope: project");
    expect(out).toContain("Run pipeline");
  });

  it("appends a forwarded 'Arguments:' line when provided", async () => {
    writeSkill(home, "greet", "Greet someone", "Say hello to the name in args.");
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", { name: "greet", arguments: "Alice" });
    expect(out).toContain("Arguments: Alice");
  });

  it("returns a structured error with available names on unknown skill", async () => {
    writeSkill(home, "review", "Review a PR", "...");
    writeSkill(home, "ship-it", "Push commit", "...");
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", { name: "nope" });
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/unknown skill/);
    expect(parsed.available).toContain("review");
    expect(parsed.available).toContain("ship-it");
  });

  it("rejects an empty name", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", { name: "" });
    expect(JSON.parse(out).error).toMatch(/requires a 'name'/);
  });

  it("normalizes decorated names (emoji / brackets) to the bare identifier", async () => {
    // Reproduces the bug where the model copied the `[🧬 subagent]` tag
    // from the Skills index into the `name` argument verbatim. The
    // tool strips leading non-word chars + anything past the first
    // whitespace token, so these all resolve to the same skill.
    writeSkill(home, "explore", "Look around", "body");
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });

    const cases = [
      "🧬 explore",
      "[🧬 subagent] explore",
      "[🧬] explore",
      "  explore  ",
      "explore [🧬 subagent]",
    ];
    for (const name of cases) {
      const out = await reg.dispatch("run_skill", { name });
      // Inline skills return the body (non-JSON markdown) on success;
      // an unknown-skill error returns JSON. Presence of the unknown-
      // skill text in the output is a guaranteed failure marker.
      expect(out, `case ${JSON.stringify(name)}`).not.toMatch(/unknown skill/i);
      expect(out, `case ${JSON.stringify(name)}`).toContain("Skill: explore");
    }
  });

  it("dispatches subagent-runAs skills through subagentRunner", async () => {
    writeSkillWithFrontmatter(
      home,
      "deepdive",
      { description: "deep dive subagent", runAs: "subagent" },
      "You are a deep-dive agent. Investigate the task and return a one-line answer.",
    );
    const reg = new ToolRegistry();
    let received: { skillName: string; skillBody: string; task: string } | null = null;
    registerSkillTools(reg, {
      homeDir: home,
      disableBuiltins: true,
      subagentRunner: async (skill, task) => {
        received = { skillName: skill.name, skillBody: skill.body, task };
        return JSON.stringify({ success: true, output: "subagent-said-this" });
      },
    });
    const out = await reg.dispatch("run_skill", {
      name: "deepdive",
      arguments: "find all tests that touch the loop",
    });
    expect(received?.skillName).toBe("deepdive");
    expect(received?.skillBody).toContain("deep-dive agent");
    expect(received?.task).toBe("find all tests that touch the loop");
    const parsed = JSON.parse(out);
    expect(parsed.output).toBe("subagent-said-this");
  });

  it("returns a configured-error when a subagent skill fires without a runner", async () => {
    writeSkillWithFrontmatter(
      home,
      "needs-runner",
      { description: "needs a runner", runAs: "subagent" },
      "...",
    );
    const reg = new ToolRegistry();
    // Note: NO subagentRunner.
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", {
      name: "needs-runner",
      arguments: "do the thing",
    });
    expect(JSON.parse(out).error).toMatch(/no subagent runner is configured/);
  });

  it("requires arguments for subagent skills (subagent has no other context)", async () => {
    writeSkillWithFrontmatter(
      home,
      "needs-args",
      { description: "needs args", runAs: "subagent" },
      "...",
    );
    const reg = new ToolRegistry();
    registerSkillTools(reg, {
      homeDir: home,
      disableBuiltins: true,
      subagentRunner: async () => "should-not-be-called",
    });
    const out = await reg.dispatch("run_skill", { name: "needs-args" });
    expect(JSON.parse(out).error).toMatch(/requires 'arguments'/);
  });

  it("inline skills don't go through subagentRunner even when one exists", async () => {
    writeSkill(home, "inline-skill", "plain", "Step 1, Step 2.");
    const reg = new ToolRegistry();
    let runnerCalls = 0;
    registerSkillTools(reg, {
      homeDir: home,
      disableBuiltins: true,
      subagentRunner: async () => {
        runnerCalls++;
        return "x";
      },
    });
    const out = await reg.dispatch("run_skill", { name: "inline-skill" });
    expect(out).toContain("Step 1, Step 2.");
    expect(runnerCalls).toBe(0);
  });
});
