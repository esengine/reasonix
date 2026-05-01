/** `/api/skills` — edits files only; loop reloads on /new or restart. `builtin` scope is read-only. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SKILLS_DIRNAME, SKILL_FILE } from "../../skills.js";
import { readUsageLog } from "../../telemetry/usage.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

interface WriteBody {
  body?: unknown;
}

function parseBody(raw: string): WriteBody {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as WriteBody) : {};
  } catch {
    return {};
  }
}

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function globalSkillsDir(): string {
  return join(homedir(), ".reasonix", SKILLS_DIRNAME);
}

function projectSkillsDir(rootDir: string): string {
  return join(rootDir, ".reasonix", SKILLS_DIRNAME);
}

interface SkillListEntry {
  name: string;
  scope: "project" | "global" | "builtin";
  description?: string;
  path: string;
  size: number;
  mtime: number;
}

function parseFrontmatterDescription(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") break;
    const m = lines[i]!.match(/^description:\s*(.*)$/);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

function listSkills(dir: string, scope: "project" | "global"): SkillListEntry[] {
  if (!existsSync(dir)) return [];
  const out: SkillListEntry[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!SAFE_NAME.test(entry)) continue;
      const skillPath = join(dir, entry, SKILL_FILE);
      if (!existsSync(skillPath)) continue;
      try {
        const stat = statSync(skillPath);
        const raw = readFileSync(skillPath, "utf8");
        const item: SkillListEntry = {
          name: entry,
          scope,
          path: skillPath,
          size: stat.size,
          mtime: stat.mtime.getTime(),
        };
        const desc = parseFrontmatterDescription(raw);
        if (desc) item.description = desc;
        out.push(item);
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* skip unreadable dir */
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function countSubagentRuns(usageLogPath: string): Map<string, number> {
  const cutoff = Date.now() - 7 * 86_400_000;
  const counts = new Map<string, number>();
  for (const r of readUsageLog(usageLogPath)) {
    if (r.kind !== "subagent" || r.ts < cutoff) continue;
    const skill = r.subagent?.skillName?.trim();
    if (!skill) continue;
    counts.set(skill, (counts.get(skill) ?? 0) + 1);
  }
  return counts;
}

export async function handleSkills(
  method: string,
  rest: string[],
  body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  const cwd = ctx.getCurrentCwd?.();

  if (method === "GET" && rest.length === 0) {
    const runs7d = countSubagentRuns(ctx.usageLogPath);
    const tag = (rows: SkillListEntry[]) =>
      rows.map((r) => ({ ...r, runs7d: runs7d.get(r.name) ?? 0 }));
    return {
      status: 200,
      body: {
        global: tag(listSkills(globalSkillsDir(), "global")),
        project: cwd ? tag(listSkills(projectSkillsDir(cwd), "project")) : [],
        builtin: [
          {
            name: "explore",
            scope: "builtin",
            description: "subagent — broad codebase survey",
            runs7d: runs7d.get("explore") ?? 0,
          },
          {
            name: "research",
            scope: "builtin",
            description: "subagent — deep web + repo research",
            runs7d: runs7d.get("research") ?? 0,
          },
        ],
        paths: {
          global: globalSkillsDir(),
          project: cwd ? projectSkillsDir(cwd) : null,
        },
      },
    };
  }

  const [scope, ...nameParts] = rest;
  const name = nameParts.join("/");

  if (!scope || !name || !SAFE_NAME.test(name)) {
    return { status: 400, body: { error: "expected /api/skills/<scope>/<name>" } };
  }
  if (scope !== "project" && scope !== "global") {
    return {
      status: 400,
      body: { error: "scope must be project | global (builtin is read-only)" },
    };
  }
  let dir: string;
  if (scope === "project") {
    if (!cwd) {
      return {
        status: 503,
        body: { error: "no active project — open `/dashboard` from `reasonix code`" },
      };
    }
    dir = projectSkillsDir(cwd);
  } else {
    dir = globalSkillsDir();
  }
  const skillPath = join(dir, name, SKILL_FILE);

  if (method === "GET") {
    if (!existsSync(skillPath)) return { status: 404, body: { error: "skill not found" } };
    return { status: 200, body: { path: skillPath, body: readFileSync(skillPath, "utf8") } };
  }

  if (method === "POST") {
    const { body: contents } = parseBody(body);
    if (typeof contents !== "string") {
      return { status: 400, body: { error: "body (string) required" } };
    }
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, contents, "utf8");
    ctx.audit?.({
      ts: Date.now(),
      action: "save-skill",
      payload: { scope, name, path: skillPath },
    });
    return { status: 200, body: { saved: true, path: skillPath } };
  }

  if (method === "DELETE") {
    if (!existsSync(skillPath)) return { status: 404, body: { error: "skill not found" } };
    // Drop the whole skill folder (it may carry assets next to SKILL.md).
    rmSync(dirname(skillPath), { recursive: true, force: true });
    ctx.audit?.({ ts: Date.now(), action: "delete-skill", payload: { scope, name } });
    return { status: 200, body: { deleted: true } };
  }

  return { status: 405, body: { error: `method ${method} not supported` } };
}
