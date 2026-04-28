/**
 * `reasonix commit` — draft a commit message from staged changes.
 *
 * Workflow:
 *   1. Read `git diff --staged`. Empty staging area falls back to the
 *      working tree (with a warning), so a quick `reasonix commit`
 *      after editing-without-add still produces a draft instead of
 *      silently no-op'ing.
 *   2. Read `git log -10 --format=%s%n%b%n---END---` so the model can
 *      match the project's actual commit style instead of generic
 *      "feat: …" boilerplate. The diff IS the spec; the log is the
 *      voice.
 *   3. One non-streaming flash call drafts the message. Default model
 *      is v4-flash — drafting a commit message doesn't need pro.
 *   4. Print the draft. Read a key from stdin: a/A/Enter accept, r/R
 *      regenerate, e/E open in $EDITOR, c/C cancel.
 *   5. Accept → `git commit -F -` with the message on stdin so multi-
 *      line bodies survive intact (no shell quoting concerns).
 *
 * The whole flow is plain text — no Ink — because it's a one-shot
 * command. Keeping it dependency-free means it works even when the
 * TUI bundle has a runtime issue.
 *
 * Loaded `.env` via `loadDotenv()` first thing so users who keep
 * DEEPSEEK_API_KEY in `.env` (instead of shell env) don't see a
 * confusing "key not set" error here.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { DeepSeekClient } from "../../client.js";
import { loadApiKey } from "../../config.js";
import { loadDotenv } from "../../env.js";

export interface CommitOptions {
  /** Override the default model (deepseek-v4-flash). */
  model?: string;
  /** Skip the confirmation step — useful in scripts where the diff has been pre-reviewed. */
  yes?: boolean;
}

const DEFAULT_MODEL = "deepseek-v4-flash";
const DIFF_BYTE_CAP = 80 * 1024;
const LOG_COUNT = 10;

const SYSTEM_PROMPT = `You draft git commit messages.

Output ONLY the commit message — no preamble, no \`\`\` fences, no "Here's a commit message:" lead-in. The first line of your output IS the commit subject.

Match the project's existing style:
- Look at the recent commits provided. Mirror their voice, conventional-commit prefix usage (or absence), tense, length, body structure.
- If recent commits use a "type(scope): summary" prefix, use it. If they don't, don't invent one.
- Subject line: one line, ≤72 chars, imperative mood, no trailing period.
- Body (optional): explain WHY when the diff isn't self-evident. Wrap at ~72 chars. Skip the body for trivial changes — repeating the subject in the body is noise.

The diff is the source of truth for what changed; describe THAT, not your guesses about the broader project. If the diff includes a deletion you can't explain from the surrounding context, name it but don't speculate about why.

No emojis unless the recent commits use them.
No co-author trailers, no "Generated with X" footers.`;

function runGit(
  args: string[],
  opts: { input?: string } = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: opts.input,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function dieIfNotGitRepo(): void {
  const r = runGit(["rev-parse", "--is-inside-work-tree"]);
  if (r.status !== 0) {
    process.stderr.write("reasonix commit: not inside a git repository.\n");
    process.exit(1);
  }
}

interface DiffResult {
  diff: string;
  source: "staged" | "working-tree";
  truncated: boolean;
}

function readDiff(): DiffResult | null {
  const staged = runGit(["diff", "--staged", "--no-color"]);
  if (staged.status !== 0) {
    process.stderr.write(`reasonix commit: git diff --staged failed: ${staged.stderr.trim()}\n`);
    process.exit(1);
  }
  if (staged.stdout.trim().length > 0) {
    return capDiff(staged.stdout, "staged");
  }
  const wt = runGit(["diff", "--no-color"]);
  if (wt.stdout.trim().length === 0) {
    return null;
  }
  return capDiff(wt.stdout, "working-tree");
}

function capDiff(raw: string, source: "staged" | "working-tree"): DiffResult {
  if (raw.length <= DIFF_BYTE_CAP) {
    return { diff: raw, source, truncated: false };
  }
  const head = raw.slice(0, Math.floor(DIFF_BYTE_CAP * 0.7));
  const tail = raw.slice(-Math.floor(DIFF_BYTE_CAP * 0.3));
  return {
    diff: `${head}\n\n[… ${raw.length - DIFF_BYTE_CAP} bytes of diff truncated …]\n\n${tail}`,
    source,
    truncated: true,
  };
}

function readRecentCommits(): string {
  const r = runGit(["log", `-${LOG_COUNT}`, "--no-merges", "--format=%s%n%b%n---END---"]);
  if (r.status !== 0) {
    // Repo may not have any commits yet (initial commit case). Don't
    // fail — let the model work from the diff alone.
    return "";
  }
  return r.stdout.trim();
}

async function draftMessage(
  client: DeepSeekClient,
  model: string,
  diff: DiffResult,
  recentCommits: string,
): Promise<string> {
  const userParts: string[] = [];
  if (recentCommits) {
    userParts.push(`Recent commits (style reference):\n\n${recentCommits}`);
  }
  if (diff.source === "working-tree") {
    userParts.push(
      "(NOTE: diff is from the working tree, not the staging area — nothing is staged yet. The user will stage selectively after seeing the draft.)",
    );
  }
  userParts.push(`Diff to summarize:\n\n${diff.diff}`);

  const resp = await client.chat({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userParts.join("\n\n") },
    ],
    temperature: 0.2,
  });
  return stripCodeFences(resp.content.trim());
}

function stripCodeFences(s: string): string {
  // Some models still wrap output in ``` despite the system prompt
  // telling them not to. Strip a single leading + trailing fence pair
  // if present. Only operates on a wrapping pair — internal fences
  // (a code block inside the body) stay.
  const trimmed = s.trim();
  const fenceOpen = /^```[a-zA-Z]*\n/;
  const fenceClose = /\n?```$/;
  if (fenceOpen.test(trimmed) && fenceClose.test(trimmed)) {
    return trimmed.replace(fenceOpen, "").replace(fenceClose, "").trim();
  }
  return trimmed;
}

function printDraft(message: string): void {
  const sep = "─".repeat(60);
  process.stdout.write(`\n${sep}\n${message}\n${sep}\n\n`);
}

async function promptChoice(): Promise<"accept" | "regen" | "edit" | "cancel"> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("[a]ccept / [r]egenerate / [e]dit / [c]ancel: ");
    const k = answer.trim().toLowerCase();
    if (k === "" || k === "a" || k === "y" || k === "yes") return "accept";
    if (k === "r" || k === "regen" || k === "regenerate") return "regen";
    if (k === "e" || k === "edit") return "edit";
    return "cancel";
  } finally {
    rl.close();
  }
}

function editInExternal(initial: string): string | null {
  const editor = process.env.GIT_EDITOR ?? process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) {
    process.stderr.write(
      "reasonix commit: no $EDITOR / $VISUAL / $GIT_EDITOR set — can't open editor. Pick [a]ccept and `git commit --amend` afterwards.\n",
    );
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "reasonix-commit-"));
  const path = join(dir, "COMMIT_EDITMSG");
  writeFileSync(path, initial, "utf8");
  // spawnSync with shell:true is required so $EDITOR strings like
  // `code --wait` work — they're shell command lines, not argv tuples.
  // The trust boundary is the user's own env var; matches how git
  // itself launches editors.
  const result = spawnSync(`${editor} "${path}"`, {
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
    process.stderr.write(
      `reasonix commit: editor exited ${result.status} — keeping prior draft.\n`,
    );
    return null;
  }
  let edited: string;
  try {
    edited = readFileSync(path, "utf8");
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
  // Strip git's standard `# …` comment lines, even though we didn't
  // emit any — a user habituated to `git commit` may add `#`-prefixed
  // notes by reflex.
  const cleaned = edited
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .trim();
  return cleaned || null;
}

function commitWithMessage(message: string): void {
  // -F - reads the message from stdin, sidestepping shell quoting and
  // letting multi-line bodies through cleanly. Inherit stdio so the
  // user sees git's own confirmation / pre-commit hook output.
  const child = spawn("git", ["commit", "-F", "-"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.write(message);
  child.stdin.end();
  child.on("close", (code) => {
    if (code !== 0) {
      process.stderr.write(`reasonix commit: git commit exited ${code}.\n`);
      process.exit(code ?? 1);
    }
  });
}

export async function commitCommand(opts: CommitOptions = {}): Promise<void> {
  loadDotenv();
  dieIfNotGitRepo();

  const apiKey = loadApiKey() ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "reasonix commit: DEEPSEEK_API_KEY not set. Run `reasonix setup` to save one, or export it.\n",
    );
    process.exit(1);
  }

  const diff = readDiff();
  if (!diff) {
    process.stderr.write(
      "reasonix commit: no staged changes and working tree is clean — nothing to commit.\n",
    );
    process.exit(1);
  }
  if (diff.source === "working-tree") {
    process.stderr.write(
      "reasonix commit: nothing staged — drafting from working-tree diff. Stage your changes and re-run, or use the draft as a starting point.\n",
    );
  }
  if (diff.truncated) {
    process.stderr.write(
      "reasonix commit: diff exceeded 80KB; head + tail sent to the model. Large diffs often produce vague drafts — consider committing in smaller chunks.\n",
    );
  }

  const client = new DeepSeekClient({ apiKey });
  const model = opts.model ?? DEFAULT_MODEL;
  const recentCommits = readRecentCommits();

  let message = "";
  let firstPass = true;
  while (true) {
    if (firstPass) {
      process.stdout.write("Drafting commit message…\n");
    } else {
      process.stdout.write("Regenerating…\n");
    }
    firstPass = false;
    try {
      message = await draftMessage(client, model, diff, recentCommits);
    } catch (err) {
      process.stderr.write(`reasonix commit: model call failed — ${(err as Error).message}\n`);
      process.exit(1);
    }
    if (!message) {
      process.stderr.write("reasonix commit: model returned an empty draft. Try again.\n");
      process.exit(1);
    }
    printDraft(message);

    if (opts.yes) break;
    if (diff.source === "working-tree") {
      // Refuse to commit a working-tree-derived draft — the staging
      // area is empty so `git commit` would fail anyway. Print the
      // draft so the user can copy it; exit 0 because we did our job.
      process.stdout.write(
        "(no staged changes — draft printed above for you to copy. Stage with `git add` and re-run to commit.)\n",
      );
      return;
    }

    const choice = await promptChoice();
    if (choice === "accept") break;
    if (choice === "cancel") {
      process.stderr.write("commit cancelled.\n");
      return;
    }
    if (choice === "edit") {
      const edited = editInExternal(message);
      if (edited) {
        message = edited;
        printDraft(message);
        // Re-prompt: the user may want to edit again, accept, etc.
        const next = await promptChoice();
        if (next === "accept") break;
        if (next === "cancel") {
          process.stderr.write("commit cancelled.\n");
          return;
        }
        // next is "regen" or another "edit" — fall through to the
        // loop top to re-draft (regen) or land back at this branch.
      }
      // editor returned no edit — loop top will regen by default.
    }
    // Anything else (regen, or unsuccessful edit) → loop top redraws.
  }

  commitWithMessage(message);
}
