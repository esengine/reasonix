import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOTS = ["src", "tests", "benchmarks", "scripts", "dashboard/src"].map((r) =>
  join(process.cwd(), r),
);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const FILES = ROOTS.flatMap((root) => {
  try {
    return walk(root);
  } catch {
    return [];
  }
}).map((p) => ({
  path: p,
  rel: relative(process.cwd(), p),
  src: readFileSync(p, "utf8"),
}));

/** Returns block comments as { startLine, lineCount, body }. */
function blockComments(src: string): Array<{ start: number; lines: number; body: string }> {
  const out: Array<{ start: number; lines: number; body: string }> = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = line.indexOf("/*");
    const before = open === -1 ? "" : line.slice(0, open);
    if (open !== -1 && before.indexOf("//") === -1 && !/["'`]/.test(before)) {
      const startLine = i + 1;
      const buf: string[] = [line.slice(open)];
      const closeOnSame = line.indexOf("*/", open + 2);
      if (closeOnSame !== -1) {
        out.push({ start: startLine, lines: 1, body: line.slice(open, closeOnSame + 2) });
        i++;
        continue;
      }
      let j = i + 1;
      while (j < lines.length && lines[j].indexOf("*/") === -1) {
        buf.push(lines[j]);
        j++;
      }
      if (j < lines.length) buf.push(lines[j]);
      out.push({ start: startLine, lines: j - i + 1, body: buf.join("\n") });
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

const VERSION_RE = /\bv\d+\.\d+(?:\.\d+)?\b/;
const PHASE_RE = /\bPhase\s+\d+\b/i;
const BANNER_RE = /\/\/\s*[─=\-*#]{3,}/;
const INCIDENT_RE =
  /\b(user reported|screenshot showed|incident|hotfix for|fix for #?\d|introduced in v|regression from v|pre-v\d|legacy v)/i;

describe("comment policy (CLAUDE.md)", () => {
  test("module-essay headers ≤ 2 lines", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      const trimmed = src.replace(/^\uFEFF/, "").trimStart();
      if (!trimmed.startsWith("/*")) continue;
      const blocks = blockComments(src);
      const head = blocks[0];
      if (!head) continue;
      const beforeHead = src.slice(0, src.indexOf(head.body)).trim();
      if (beforeHead.length > 0) continue;
      if (head.lines > 2) offenders.push(`${rel}:${head.start} — header is ${head.lines} lines`);
    }
    expect(offenders, format(offenders, "Module headers must be ≤ 2 lines.")).toEqual([]);
  });

  test("no Phase N narrative", () => {
    const offenders = scan(FILES, (line) => PHASE_RE.test(line));
    expect(offenders, format(offenders, 'No "Phase N" narrative in source comments.')).toEqual([]);
  });

  test("no version-number narrative in comments", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      const lines = src.split("\n");
      lines.forEach((line, idx) => {
        const c = commentText(line);
        if (c && VERSION_RE.test(c))
          offenders.push(`${rel}:${idx + 1} — ${line.trim().slice(0, 100)}`);
      });
    }
    expect(
      offenders,
      format(offenders, "No version refs in comments — put them in commit/PR text."),
    ).toEqual([]);
  });

  test("no incident / conversation narrative", () => {
    const offenders = scan(FILES, (line) => {
      const c = commentText(line);
      return c ? INCIDENT_RE.test(c) : false;
    });
    expect(offenders, format(offenders, "No incident/conversation history in comments.")).toEqual(
      [],
    );
  });

  test("no banner separator comments", () => {
    const offenders = scan(FILES, (line) => BANNER_RE.test(line));
    expect(offenders, format(offenders, "No section-banner separator comments.")).toEqual([]);
  });

  test("no multi-line block comments > 3 lines", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const b of blockComments(src)) {
        if (b.lines > 3) offenders.push(`${rel}:${b.start} — ${b.lines}-line block`);
      }
    }
    expect(
      offenders,
      format(offenders, "Block comments capped at 3 lines (one-line preferred)."),
    ).toEqual([]);
  });
});

function commentText(line: string): string | null {
  const m = line.match(/(?:^|\s)\/\/(.*)$/);
  if (m) return m[1];
  const m2 = line.match(/\/\*+(.*?)\*?\/?$/);
  if (m2) return m2[1];
  const m3 = line.match(/^\s*\*\s?(.*)$/);
  if (m3) return m3[1];
  return null;
}

function scan(files: typeof FILES, pred: (line: string) => boolean): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    src.split("\n").forEach((line, idx) => {
      if (pred(line)) out.push(`${rel}:${idx + 1} — ${line.trim().slice(0, 100)}`);
    });
  }
  return out;
}

function format(offenders: string[], rule: string): string {
  if (offenders.length === 0) return "";
  const head = `${rule} ${offenders.length} violation(s):`;
  const list = offenders
    .slice(0, 30)
    .map((o) => `  ${o}`)
    .join("\n");
  const tail = offenders.length > 30 ? `\n  … +${offenders.length - 30} more` : "";
  return `\n${head}\n${list}${tail}\n`;
}
