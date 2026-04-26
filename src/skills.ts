/**
 * Skills — user-defined prompt packs pinned (by name) into the
 * immutable prefix and loaded (by body) on demand.
 *
 * Two scopes mirror the user-memory layout:
 *   - `project` → `<projectRoot>/.reasonix/skills/` (this repo only)
 *   - `global`  → `~/.reasonix/skills/`            (every session)
 *
 * Project scope wins on a name collision. Deliberately NOT tied to
 * any specific client's directory convention (`.claude/`, `.glm/`,
 * etc.) — Reasonix is model-agnostic at the conversation layer, so
 * coupling the skill filesystem to one vendor would break any user
 * running a different backend.
 *
 * Accepted file layouts (both emit the same `Skill`):
 *   - `{dir}/<name>/SKILL.md`   (preferred — lets a skill bundle
 *                                additional assets alongside)
 *   - `{dir}/<name>.md`         (flat, one-file shorthand)
 *
 * Frontmatter keys we read:
 *   - `name`          — optional, defaults to the file / dir name
 *   - `description`   — one-line index description (REQUIRED for listing)
 *   - `allowed-tools` — parsed but UNUSED in v1 (see tools/skills.ts)
 *
 * Cache-First contract (Pillar 1):
 *   - The PREFIX sees only names + descriptions (one line each).
 *   - Bodies enter the APPEND-ONLY LOG lazily, via `run_skill` or
 *     `/skill <name>` — never the prefix. That keeps the prefix hash
 *     stable across skill additions to the body store.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NEGATIVE_CLAIM_RULE, TUI_FORMATTING_RULES } from "./prompt-fragments.js";

export const SKILLS_DIRNAME = "skills";
export const SKILL_FILE = "SKILL.md";
/** Cap on the pinned skills-index block, mirrors memory-index cap. */
export const SKILLS_INDEX_MAX_CHARS = 4000;
/** Skill identifier shape — alnum + `_` + `-` + interior `.`, 1-64 chars. */
const VALID_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export type SkillScope = "project" | "global" | "builtin";

/**
 * Execution mode for a skill. `inline` (default) returns the body as a
 * tool result so the body enters the parent's append-only log — the
 * model continues the loop using the loaded instructions. `subagent`
 * spawns an isolated child loop with the body as the system prompt and
 * the user-supplied `arguments` as the task; only the child's final
 * answer comes back. Use `subagent` for big-context exploration / research
 * playbooks where the parent doesn't need to see the trail.
 */
export type SkillRunAs = "inline" | "subagent";

export interface Skill {
  /** Canonical name — sanitized, matches the directory / filename stem. */
  name: string;
  /** One-line description shown in the pinned index. */
  description: string;
  /** Full markdown body (post-frontmatter). Loaded on demand. */
  body: string;
  /** Which scope this skill was loaded from. */
  scope: SkillScope;
  /** Absolute path to the SKILL.md (or {name}.md) file, or "(builtin)" for shipped defaults. */
  path: string;
  /** Raw `allowed-tools` field from frontmatter, if any. Unused in v1. */
  allowedTools?: string;
  /**
   * Execution mode (frontmatter `runAs`). Defaults to `inline` for
   * backwards compatibility with skills written before this field
   * existed.
   */
  runAs: SkillRunAs;
  /**
   * Frontmatter `model` — when set, overrides the default model the
   * subagent runs on. Only meaningful when `runAs === "subagent"`.
   * Accept any DeepSeek model id; the subagent layer falls back to its
   * own default if this is missing or invalid.
   */
  model?: string;
}

export interface SkillStoreOptions {
  /** Override `$HOME` — tests point this at a tmpdir. */
  homeDir?: string;
  /**
   * Absolute project root. Required to surface project-scope skills;
   * omit (e.g. in `reasonix chat` without `code`) and the store only
   * reads the global scope.
   */
  projectRoot?: string;
  /**
   * Suppress the bundled built-in skills (`explore`, `research`).
   * Used by unit tests that want to assert exact list contents
   * without the +2 builtins distorting counts. Production callers
   * leave this off so users always get the bundled defaults.
   */
  disableBuiltins?: boolean;
}

/**
 * Parse a `---` frontmatter block. Same minimal shape as user-memory:
 * `key: value` lines, no quoting, no nesting. Returns `{}` data and the
 * full input as body when no frontmatter fence is present — so hand-
 * written files without frontmatter still surface (with empty desc).
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return { data: {}, body: raw };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (m?.[1]) data[m[1]] = (m[2] ?? "").trim();
  }
  return {
    data,
    body: lines
      .slice(end + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}

function isValidSkillName(name: string): boolean {
  return VALID_SKILL_NAME.test(name);
}

export class SkillStore {
  private readonly homeDir: string;
  private readonly projectRoot: string | undefined;
  private readonly disableBuiltins: boolean;

  constructor(opts: SkillStoreOptions = {}) {
    this.homeDir = opts.homeDir ?? homedir();
    this.projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : undefined;
    this.disableBuiltins = opts.disableBuiltins === true;
  }

  /** True iff this store was configured with a project root. */
  hasProjectScope(): boolean {
    return this.projectRoot !== undefined;
  }

  /**
   * Root directories scanned, in priority order. Project scope first
   * so a per-repo skill overrides a global one with the same name —
   * users expect the local copy to win when both exist.
   */
  roots(): Array<{ dir: string; scope: SkillScope }> {
    const out: Array<{ dir: string; scope: SkillScope }> = [];
    if (this.projectRoot) {
      out.push({
        dir: join(this.projectRoot, ".reasonix", SKILLS_DIRNAME),
        scope: "project",
      });
    }
    out.push({ dir: join(this.homeDir, ".reasonix", SKILLS_DIRNAME), scope: "global" });
    return out;
  }

  /**
   * List every skill visible to this store. On name collisions the
   * higher-priority root (project over global over builtin) wins.
   * Sorted by name for stable prefix hashing.
   */
  list(): Skill[] {
    const byName = new Map<string, Skill>();
    for (const { dir, scope } of this.roots()) {
      if (!existsSync(dir)) continue;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const skill = this.readEntry(dir, scope, entry);
        if (!skill) continue;
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      }
    }
    // Builtins are appended last so user/project files take precedence
    // when names collide. The same priority you'd expect: my-project's
    // "explore" overrides the shipped one without forcing a different
    // name.
    if (!this.disableBuiltins) {
      for (const skill of BUILTIN_SKILLS) {
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Resolve one skill by name. Returns `null` if not found or malformed. */
  read(name: string): Skill | null {
    if (!isValidSkillName(name)) return null;
    for (const { dir, scope } of this.roots()) {
      if (!existsSync(dir)) continue;
      const dirCandidate = join(dir, name, SKILL_FILE);
      if (existsSync(dirCandidate) && statSync(dirCandidate).isFile()) {
        return this.parse(dirCandidate, name, scope);
      }
      const flatCandidate = join(dir, `${name}.md`);
      if (existsSync(flatCandidate) && statSync(flatCandidate).isFile()) {
        return this.parse(flatCandidate, name, scope);
      }
    }
    // Fall back to builtins. Same precedence as `list()` — user-authored
    // wins, builtins are the floor.
    if (!this.disableBuiltins) {
      for (const skill of BUILTIN_SKILLS) {
        if (skill.name === name) return skill;
      }
    }
    return null;
  }

  private readEntry(dir: string, scope: SkillScope, entry: import("node:fs").Dirent): Skill | null {
    if (entry.isDirectory()) {
      if (!isValidSkillName(entry.name)) return null;
      const file = join(dir, entry.name, SKILL_FILE);
      if (!existsSync(file)) return null;
      return this.parse(file, entry.name, scope);
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const stem = entry.name.slice(0, -3);
      if (!isValidSkillName(stem)) return null;
      return this.parse(join(dir, entry.name), stem, scope);
    }
    return null;
  }

  private parse(path: string, stem: string, scope: SkillScope): Skill | null {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    const { data, body } = parseFrontmatter(raw);
    const name = data.name && isValidSkillName(data.name) ? data.name : stem;
    return {
      name,
      description: (data.description ?? "").trim(),
      body: body.trim(),
      scope,
      path,
      allowedTools: data["allowed-tools"],
      runAs: parseRunAs(data.runAs),
      model: data.model?.startsWith("deepseek-") ? data.model : undefined,
    };
  }
}

/**
 * Coerce a frontmatter `runAs` string to the discriminated union. Any
 * value other than the literal "subagent" is treated as inline — typos
 * and unknown values default to the safe (non-spawning) mode rather
 * than failing the load.
 */
function parseRunAs(raw: string | undefined): SkillRunAs {
  return raw?.trim() === "subagent" ? "subagent" : "inline";
}

/**
 * Build a single index line for one skill. Shape mirrors memory's
 * `indexLine` — a bullet suitable for a markdown fenced block in the
 * system prompt. Description is truncated to keep the full line under
 * ~150 chars.
 *
 * Subagent-runAs skills carry a `[🧬 subagent]` tag AFTER the name
 * so the model can't confuse the marker for part of the skill name.
 * (Historical bug: when the marker led the name — `- 🧬 explore` —
 * models would call `run_skill({ name: "🧬 explore" })` verbatim
 * and fail lookup. Wrapping the marker in brackets AFTER the name
 * eliminates that confusion; `run_skill`'s name arg also strips any
 * leading non-word chars as a belt-and-suspenders measure.)
 */
function skillIndexLine(s: Pick<Skill, "name" | "description" | "runAs">): string {
  const safeDesc = s.description.replace(/\n/g, " ").trim();
  const tag = s.runAs === "subagent" ? " [🧬 subagent]" : "";
  const max = 130 - s.name.length - tag.length;
  const clipped = safeDesc.length > max ? `${safeDesc.slice(0, Math.max(1, max - 1))}…` : safeDesc;
  return clipped ? `- ${s.name}${tag} — ${clipped}` : `- ${s.name}${tag}`;
}

/**
 * Append a `# Skills` block to `basePrompt` listing every discovered
 * skill (name + description only). Bodies are NOT inlined — that's the
 * whole point: the prefix stays short and cacheable; full content loads
 * on demand via `run_skill` or `/skill <name>`.
 *
 * Emits nothing when no skills are discovered — keeps the prefix hash
 * stable for users who don't use skills at all.
 */
export function applySkillsIndex(basePrompt: string, opts: SkillStoreOptions = {}): string {
  const store = new SkillStore(opts);
  const skills = store.list().filter((s) => s.description);
  if (skills.length === 0) return basePrompt;
  const lines = skills.map(skillIndexLine);
  const joined = lines.join("\n");
  const truncated =
    joined.length > SKILLS_INDEX_MAX_CHARS
      ? `${joined.slice(0, SKILLS_INDEX_MAX_CHARS)}\n… (truncated ${
          joined.length - SKILLS_INDEX_MAX_CHARS
        } chars)`
      : joined;
  return [
    basePrompt,
    "",
    "# Skills — playbooks you can invoke",
    "",
    'One-liner index. Each entry is either a built-in or a user-authored playbook. Call `run_skill({ name: "<skill-name>", arguments: "<task>" })` — the `name` is JUST the skill identifier (e.g. `"explore"`), NOT the `[🧬 subagent]` tag that appears after it. Entries tagged `[🧬 subagent]` spawn an **isolated subagent** — its tool calls and reasoning never enter your context, only its final answer does. Use subagent skills for tasks that would otherwise flood your context (deep exploration, multi-step research, anything where you only need the conclusion). Plain skills are inlined: their body becomes a tool result you read and act on directly. The user can also invoke a skill via `/skill <name>`.',
    "",
    "```",
    truncated,
    "```",
  ].join("\n");
}

/**
 * Built-in skills shipped with Reasonix. These are always available
 * (no install step) and live as constants rather than files because:
 *   - Zero filesystem coupling — no copy-on-first-run dance, nothing
 *     to migrate when we update them.
 *   - They participate in the same `byName` priority as user/project
 *     skills: write `~/.reasonix/skills/explore.md` to override.
 *
 * Keep this list small and high-leverage. The bar for adding one: it
 * demonstrates a pattern users would otherwise have to invent
 * themselves, and the body fits in a screen.
 */
const BUILTIN_EXPLORE_BODY = `You are running as an exploration subagent. Your job is to investigate the codebase the parent agent pointed you at, then return one focused, distilled answer.

How to operate:
- Use read_file, search_files, search_content, directory_tree, list_directory, get_file_info as your primary tools. Stay read-only.
- For "find all places that call / reference / use X" questions, use \`search_content\` (content grep) — NOT \`search_files\` (which only matches file names). This is the most common subagent mistake; using the wrong tool gives empty results and you waste your iter budget chasing a phantom.
- Cast a wide net first (search_content for symbol references, directory_tree for structure) to map the territory; then read the 3-10 most relevant files in full.
- Don't read every file — be selective. Aim for breadth on the first pass, depth only where the question demands it.
- Stop exploring as soon as you can answer the question. The parent doesn't see your tool calls, so over-exploration is pure waste.

Your final answer:
- One paragraph (or a few short bullets). Lead with the conclusion.
- Cite specific file paths + line ranges when they support the answer.
- If the question can't be answered from what you found, say so plainly and suggest where to look next.
- No follow-up offers, no "let me know if you need more." The parent will ask again if they need more.

${NEGATIVE_CLAIM_RULE}

${TUI_FORMATTING_RULES}

The 'task' the parent gave you is the question you must answer. Treat any other reading of it as scope creep.`;

const BUILTIN_RESEARCH_BODY = `You are running as a research subagent. Your job is to gather information from code AND the web, synthesize it, and return one focused conclusion.

How to operate:
- Combine code reading (read_file, search_files) with web tools (web_search, web_fetch) as appropriate to the question.
- For "how does X work" / "is Y supported" questions: web first to find the canonical reference, then verify against the local code.
- For "what's our policy on Z" / "where do we use Q": local code first, web only if you need to compare against external standards.
- Cap yourself at ~10 tool calls. If you can't converge in 10, return what you have plus a note about what's missing.

Your final answer:
- One paragraph (or short bullets). Lead with the conclusion.
- Cite both code (file:line) AND web sources (URL) when they back the answer.
- Distinguish "I verified this in code" from "I read this on a docs page" — the parent will trust the former more.
- If the answer is uncertain, say so. Don't invent confidence.

${NEGATIVE_CLAIM_RULE}

${TUI_FORMATTING_RULES}

The 'task' the parent gave you is the research question. Stay on it.`;

const BUILTIN_REVIEW_BODY = `You are running as a code-review subagent. Your job is to inspect the changes the user is about to ship — usually the current git branch vs its upstream — and produce a focused review the parent can hand back to the user.

How to operate:
- Default scope: the current branch's diff vs the default branch. If the user's task names a specific commit range or files, honor that instead.
- Discover scope first: \`run_command git status\`, \`git diff --stat\`, \`git log --oneline\` to see what changed. Then \`git diff\` (or \`git diff <base>...HEAD\`) for the actual hunks.
- Read the touched files (\`read_file\`) when the diff alone doesn't carry enough context — function signatures, surrounding invariants, callers.
- For "any callers depending on this?" questions: \`search_content\` against the symbol BEFORE asserting impact.
- Stay read-only. Never \`run_command git commit\`, never write files, never propose SEARCH/REPLACE blocks. The parent decides whether to act on your findings.
- Cap yourself at ~12 tool calls. If the diff is too big to review in one pass, pick the riskiest 2-3 files and say so explicitly.

What to look for, in priority order:
1. **Correctness bugs** — off-by-one, null/undefined handling, race conditions, wrong sign / wrong operator, edge cases the code doesn't handle.
2. **Security** — injection (SQL, shell, path traversal), secrets in code, missing authz checks, unsafe deserialization.
3. **Behavior changes the diff hides** — renames that miss callers, removed branches that were load-bearing, error-handling that now swallows what used to surface.
4. **Tests** — does the change have tests for the new behavior? Are existing tests still meaningful, or did the change make them tautological?
5. **Style + consistency** — only flag deviations that matter (unsafe \`any\`, missing types in TypeScript, inconsistent error shape). Don't pile on cosmetic nits if the substance is clean.

Your final answer:
- Lead with a one-sentence verdict: "ship as-is" / "minor nits, OK to ship after" / "blocking issues, do not ship".
- Then a short bulleted list of issues, each with: file:line citation + the problem in one sentence + what to change.
- Group by severity if you have more than 4 items: **Blocking**, **Should-fix**, **Nits**.
- If everything looks clean, say so plainly. Don't manufacture concerns.

${NEGATIVE_CLAIM_RULE}

${TUI_FORMATTING_RULES}

The 'task' the parent gave you describes WHAT to review (a branch, a file set, or "the pending changes"). Stay on it; don't redesign the feature.`;

const BUILTIN_SKILLS: readonly Skill[] = Object.freeze([
  Object.freeze<Skill>({
    name: "explore",
    description:
      "Explore the codebase in an isolated subagent — wide-net read-only investigation that returns one distilled answer. Best for: 'find all places that...', 'how does X work across the project', 'survey the code for Y'.",
    body: BUILTIN_EXPLORE_BODY,
    scope: "builtin",
    path: "(builtin)",
    runAs: "subagent",
  }),
  Object.freeze<Skill>({
    name: "research",
    description:
      "Research a question by combining web search + code reading in an isolated subagent. Best for: 'is X feature supported by lib Y', 'what's the canonical way to do Z', 'compare our impl against the spec'.",
    body: BUILTIN_RESEARCH_BODY,
    scope: "builtin",
    path: "(builtin)",
    runAs: "subagent",
  }),
  Object.freeze<Skill>({
    name: "review",
    description:
      "Review the pending changes (current branch diff by default) in an isolated subagent — flags correctness, security, missing tests, hidden behavior changes; reports verdict + per-issue file:line. Read-only; the parent decides what to act on.",
    body: BUILTIN_REVIEW_BODY,
    scope: "builtin",
    path: "(builtin)",
    runAs: "subagent",
  }),
]);
