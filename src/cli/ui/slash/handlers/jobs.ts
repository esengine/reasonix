import type { SlashHandler } from "../dispatch.js";

const jobs: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.jobs) {
    return { info: "/jobs is only available inside `reasonix code`." };
  }
  const rows = ctx.jobs.list();
  if (rows.length === 0) {
    return { info: "no background jobs yet — use run_background to start one" };
  }
  const lines = ["Background jobs:"];
  for (const r of rows) {
    const age = ((Date.now() - r.startedAt) / 1000).toFixed(1);
    const state = r.running
      ? `running   · pid ${r.pid ?? "?"}`
      : r.exitCode !== null
        ? `exit ${r.exitCode}`
        : r.spawnError
          ? "failed"
          : "stopped";
    lines.push(
      `  ${String(r.id).padStart(3)}  ${state.padEnd(20)}  ${age.padStart(6)}s ago   $ ${r.command}`,
    );
  }
  lines.push("");
  lines.push("/kill <id> to stop one · /logs <id> [lines] to tail output");
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
