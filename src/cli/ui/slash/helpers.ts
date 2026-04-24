import { spawnSync } from "node:child_process";
import type { MemoryScope, MemoryStore } from "../../../user-memory.js";
import type { SlashResult } from "./types.js";

/**
 * Parse a `/memory show|forget` argument. Accepts bare `<name>` or
 * `<scope>/<name>`. For bare names, tries project scope first (more
 * specific, usually what the user means) then falls back to global.
 */
export function resolveMemoryTarget(
  store: MemoryStore,
  raw: string,
): { scope: MemoryScope; name: string } | null {
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const scopeRaw = raw.slice(0, slash).toLowerCase();
    const name = raw.slice(slash + 1);
    if (scopeRaw !== "global" && scopeRaw !== "project") return null;
    const scope = scopeRaw as MemoryScope;
    if (scope === "project" && !store.hasProjectScope()) return null;
    return { scope, name };
  }
  for (const scope of ["project", "global"] as MemoryScope[]) {
    if (scope === "project" && !store.hasProjectScope()) continue;
    try {
      store.read(scope, raw);
      return { scope, name: raw };
    } catch {
      /* next scope */
    }
  }
  return null;
}

/**
 * Render a section (resources / prompts) of an MCP inspection into a
 * compact "name  count  items" form, collapsing when unsupported.
 * Names-only — descriptions and full metadata live in
 * `reasonix mcp inspect`, which is purpose-built for the deep view.
 */
export function appendSection(
  lines: string[],
  label: string,
  section:
    | { supported: true; items: Array<{ name: string }> }
    | { supported: false; reason: string }
    | undefined,
): void {
  if (!section || !section.supported) {
    lines.push(
      `  ${label.trim()}    ${section?.supported === false ? "(not supported)" : "(none)"}`,
    );
    return;
  }
  const names = section.items.map((i) => i.name);
  if (names.length === 0) {
    lines.push(`  ${label.trim()}    (none)`);
    return;
  }
  const head = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? ` +${names.length - 5} more` : "";
  lines.push(`  ${label.trim()}    ${names.length}  [${head}${more}]`);
}

export function formatToolList(history: Array<{ toolName: string; text: string }>): string {
  const total = history.length;
  const header = `Tool calls in this session (${total}, most recent first):`;
  // Show the 10 most recent. Older ones are rarely what the user
  // wants — and the help footer tells them how to reach any entry
  // by index if they do.
  const shown = Math.min(total, 10);
  const lines: string[] = [header];
  for (let i = 0; i < shown; i++) {
    const entry = history[total - 1 - i];
    if (!entry) continue;
    const idx = i + 1; // 1-based from most recent
    const flat = entry.text.replace(/\s+/g, " ").trim();
    const preview = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
    const name = entry.toolName.length > 24 ? `${entry.toolName.slice(0, 23)}…` : entry.toolName;
    lines.push(
      `  #${String(idx).padStart(2)}  ${name.padEnd(24)}  ${String(entry.text.length).padStart(6)} chars  ${preview}`,
    );
  }
  if (total > shown) {
    lines.push(`  … (${total - shown} earlier, reach with /tool N)`);
  }
  lines.push("");
  lines.push("View full output: /tool N   (N=1 → most recent)");
  return lines.join("\n");
}

/**
 * Binary-K token formatter: 1234 → "1.2K", 131072 → "128K". Matches
 * DeepSeek's doc ("128K context"). Every call site here is rendering
 * token counts — if a future caller wants decimal-K for dollars or
 * similar, add a separate formatter rather than reusing this one.
 */
export function compactNum(n: number): string {
  if (n < 1024) return String(n);
  const k = n / 1024;
  return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
}

export function stripOuterQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Run `git add -A` then `git commit -m <message>` in `rootDir`. Returns
 * a SlashResult with a human-scannable info line. We surface stderr on
 * failure so the user sees exactly what git complained about (bad
 * config, pre-commit hook rejection, nothing staged, etc.).
 */
export function runGitCommit(rootDir: string, message: string): SlashResult {
  const add = spawnSync("git", ["add", "-A"], { cwd: rootDir, encoding: "utf8" });
  if (add.error || add.status !== 0) {
    return { info: `git add failed (${add.status ?? "?"}):\n${gitTail(add)}` };
  }
  const commit = spawnSync("git", ["commit", "-m", message], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (commit.error || commit.status !== 0) {
    return { info: `git commit failed (${commit.status ?? "?"}):\n${gitTail(commit)}` };
  }
  const firstLine = (commit.stdout || "").split(/\r?\n/)[0] ?? "";
  return { info: `▸ committed: ${message}${firstLine ? `\n  ${firstLine}` : ""}` };
}

/**
 * Safely extract whatever diagnostic text is available from a spawnSync
 * result — on Windows or when cwd doesn't exist, `stderr`/`stdout` can
 * be `undefined` and the caller has only `error.message` to go on.
 */
export function gitTail(res: ReturnType<typeof spawnSync>): string {
  const stderr = (res.stderr as string | undefined) ?? "";
  const stdout = (res.stdout as string | undefined) ?? "";
  const body = stderr.trim() || stdout.trim();
  if (body) return body;
  if (res.error) return (res.error as Error).message;
  return "(no output from git)";
}
