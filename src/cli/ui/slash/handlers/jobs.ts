import { t } from "../../../../i18n/index.js";
import type { JobRecord } from "../../../../tools/jobs.js";
import type { SlashHandler } from "../dispatch.js";

function statusIcon(r: JobRecord): string {
  if (r.running) return "●";
  if (r.spawnError) return "✗";
  if (r.exitCode === 0) return "✓";
  if (r.exitCode !== null) return "✗";
  return "○";
}

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

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
    return { info: t("handlers.jobs.codeOnly") };
  }
  const rows = ctx.jobs.list();
  if (rows.length === 0) {
    return { info: t("handlers.jobs.empty") };
  }
  const running = rows.filter((r) => r.running).length;
  const lines: string[] = [t("handlers.jobs.header", { running, total: rows.length }), ""];
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
  lines.push(t("handlers.jobs.footer"));
  return { info: lines.join("\n") };
};

const kill: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.jobs) return { info: t("handlers.jobs.killCodeOnly") };
  const id = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(id)) return { info: t("handlers.jobs.killUsage") };
  const rec = ctx.jobs.list().find((r) => r.id === id);
  if (!rec) return { info: t("handlers.jobs.killNotFound", { id }) };
  if (!rec.running)
    return { info: t("handlers.jobs.killAlreadyExited", { id, code: rec.exitCode ?? "?" }) };
  const jobsRef = ctx.jobs;
  void (async () => {
    const final = await jobsRef.stop(id);
    if (!final) return;
    const status = final.running
      ? t("handlers.jobs.killStillAlive")
      : final.exitCode !== null
        ? `exit ${final.exitCode}`
        : "stopped";
    ctx.postInfo?.(t("handlers.jobs.killStatus", { id, status }));
  })();
  return { info: t("handlers.jobs.killStopping", { id }) };
};

const logs: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.jobs) return { info: t("handlers.jobs.logsCodeOnly") };
  const id = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(id)) {
    return { info: t("handlers.jobs.logsUsage") };
  }
  const requested = Number.parseInt(args[1] ?? "", 10);
  const tail = Number.isFinite(requested) && requested > 0 ? requested : 80;
  const out = ctx.jobs.read(id, { tailLines: tail });
  if (!out) return { info: t("handlers.jobs.logsNotFound", { id }) };
  const status = out.running
    ? t("handlers.jobs.logsRunning", { pid: out.pid ?? "?" })
    : out.exitCode !== null
      ? t("handlers.jobs.logsExited", { code: out.exitCode })
      : out.spawnError
        ? t("handlers.jobs.logsFailed", { reason: out.spawnError })
        : t("handlers.jobs.logsStopped");
  const header = t("handlers.jobs.logsStatus", { id, status, command: out.command });
  return { info: out.output ? `${header}\n${out.output}` : header };
};

export const handlers: Record<string, SlashHandler> = {
  jobs,
  kill,
  logs,
};
