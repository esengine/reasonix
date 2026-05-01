import { SLASH_COMMANDS } from "../../cli/ui/slash/commands.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

export async function handleSlash(
  method: string,
  _rest: string[],
  _body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  if (method !== "GET") return { status: 405, body: { error: "GET only" } };
  const codeMode = ctx.getCurrentCwd?.() != null;
  const commands = SLASH_COMMANDS.filter((c) => c.contextual !== "code" || codeMode).map((c) => ({
    cmd: c.cmd,
    summary: c.summary,
    argsHint: c.argsHint,
    contextual: c.contextual,
  }));
  return { status: 200, body: { commands, codeMode } };
}
