import type { JobRecord } from "../../../../tools/jobs.js";
import type { SlashHandler } from "../dispatch.js";

/**
 * Status icon per job state. ● for live (terminal renders bare colored
 * dot — combine with chalk fg color in the output for the cyan/green/red
 * cue), ✓ / ✗ for clean / failed exits, ○ for stopped-without-exit.
 */
function statusIcon(r: JobRecord): string {
  if (r.running) return "●";
  if (r.spawnError) return "✗";
  if (r.exitCode === 0) return "✓";
  if (r.exitCode !== null) return "✗";
  return "○";
}

/**
 * Compact human age: "12s" / "4m" / "2h" / "3d". Tabular widths so a
 * column of ages still aligns under a fixed-width header.
 */
function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Best-effort port detection from a running job's output. Most dev
 * servers print "Local: http://localhost:3000" or "Listening on :8080"
 * in their startup banner; surfacing those next to the row turns
 * `/jobs` into a "what's running on what port" dashboard. Returns up
 * to three unique ports because docker-compose-style multi-service
 * boots can legitimately bind several at once (postgres+redis).
 *
 * Fall through to no-ports if nothing matches; we don't want to invent
 * a port number from the command name (`npm run dev` → :3000) since
 * that's just a guess and being wrong is worse than being silent.
 */
function detectPorts(output: string): number[] {
  if (!output) return [];
  const found = new Set<number>();
  const patterns = [
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g,
    /(?:listening|listening on|bound to|port|on port)[\s:=]+(\d{2,5})\b/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
    while ((m = re.exec(output)) !== null) {
      const port = Number.parseInt(m[1] ?? "", 10);
      if (port >= 80 && port <= 65535) found.add(port);
      if (found.size >= 3) break;
    }
    if (found.size >= 3) break;
  }
  return [...found];
}

/**
 * Right-side metadata column. For running jobs show ports (brand-color
 * intent — caller can wrap in chalk); for terminated jobs show the
 * exit code with a "✓"/"✗" already in the status icon column, so the
 * meta is just a number.
 */
function fmtMeta(r: JobRecord): string {
  if (r.running) {
    const ports = detectPorts(r.output);
    if (ports.length > 0) return ports.map((p) => `:${p}`).join(" ");
    return r.pid !== null ? `pid ${r.pid}` : "";
  }
  if (r.spawnError) return r.spawnError;
  if (r.exitCode !== null) return `exit ${r.exitCode}`;
  return "stopped";
}

const jobs: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.jobs) {
    return { info: "/jobs is only available inside `reasonix code`." };
  }
  const rows = ctx.jobs.list();
  if (rows.length === 0) {
    return {
      info: "◈ jobs · 0 running · 0 total\n  (run_background spawns one — dev servers, watchers, long-running scripts)",
    };
  }
  const running = rows.filter((r) => r.running).length;
  // Layout: ICO (1) · ID (right-pad 4) · CMD (flex) · META (auto) · AGE (right-pad 5)
  // Plain text from a slash, so we can't apply per-cell color the way
  // the React tree could; the icons + indentation already give the eye
  // strong landmarks. The chrome layer (when this lands in the TUI
  // directly) will color the icons via chalk.
  const lines: string[] = [`◈ jobs · ${running} running · ${rows.length} total`, ""];
  // Compute the max command width so cmds line up; cap at 44 so a long
  // docker-compose invocation doesn't push the meta column off-screen.
  const cmdWidth = Math.min(44, Math.max(8, ...rows.map((r) => r.command.length)));
  for (const r of rows) {
    const ico = statusIcon(r);
    const id = `#${String(r.id).padEnd(3)}`;
    const cmd =
      r.command.length > cmdWidth
        ? `${r.command.slice(0, cmdWidth - 1)}…`
        : r.command.padEnd(cmdWidth);
    const meta = fmtMeta(r).padEnd(20);
    const age = fmtAge(Date.now() - r.startedAt).padStart(4);
    lines.push(`  ${ico}  ${id}  ${cmd}  ${meta}  ${age}`);
  }
  lines.push("");
  lines.push("  /logs <id> tail · /kill <id> SIGTERM → SIGKILL");
  return { info: lines.join("\n") };
};

const kill: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.jobs) return { info: "/kill is only available inside `reasonix code`." };
  const id = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(id)) return { info: "usage: /kill <id>   (see /jobs for ids)" };
  const rec = ctx.jobs.list().find((r) => r.id === id);
  if (!rec) return { info: `job ${id}: not found` };
  if (!rec.running) return { info: `job ${id} already exited (${rec.exitCode ?? "?"})` };
  // Fire-and-forget: the registry waits for grace + SIGKILL internally;
  // returning immediately keeps the slash synchronous so the user's
  // prompt doesn't lock up for 2s on every /kill. The postInfo
  // callback lands a follow-up row in historical when the kill
  // actually completes, so the user sees "job N stopped" without
  // polling /jobs.
  const jobsRef = ctx.jobs;
  void (async () => {
    const final = await jobsRef.stop(id);
    if (!final) return;
    const status = final.running
      ? "still alive after SIGKILL (!) — report this as a bug"
      : final.exitCode !== null
        ? `exit ${final.exitCode}`
        : "stopped";
    ctx.postInfo?.(`▸ job ${id} ${status}`);
  })();
  return {
    info: `▸ stopping job ${id} (tree kill: SIGTERM → SIGKILL after 2s grace; Windows: taskkill /T /F)`,
  };
};

const logs: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.jobs) return { info: "/logs is only available inside `reasonix code`." };
  const id = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(id)) {
    return { info: "usage: /logs <id> [lines]   (default last 80 lines)" };
  }
  const requested = Number.parseInt(args[1] ?? "", 10);
  const tail = Number.isFinite(requested) && requested > 0 ? requested : 80;
  const out = ctx.jobs.read(id, { tailLines: tail });
  if (!out) return { info: `job ${id}: not found` };
  const status = out.running
    ? `running · pid ${out.pid ?? "?"}`
    : out.exitCode !== null
      ? `exited ${out.exitCode}`
      : out.spawnError
        ? `failed (${out.spawnError})`
        : "stopped";
  const header = `[job ${id} · ${status}]\n$ ${out.command}`;
  return { info: out.output ? `${header}\n${out.output}` : header };
};

export const handlers: Record<string, SlashHandler> = {
  jobs,
  kill,
  logs,
};
