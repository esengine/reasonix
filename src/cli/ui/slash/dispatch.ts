import type { CacheFirstLoop } from "../../../loop.js";
import { handlers as adminHandlers } from "./handlers/admin.js";
import { handlers as basicHandlers } from "./handlers/basic.js";
import { handlers as dashboardHandlers } from "./handlers/dashboard.js";
import { handlers as editsHandlers } from "./handlers/edits.js";
import { handlers as initHandlers } from "./handlers/init.js";
import { handlers as jobsHandlers } from "./handlers/jobs.js";
import { handlers as languageHandlers } from "./handlers/language.js";
import { handlers as mcpHandlers } from "./handlers/mcp.js";
import { handlers as memoryHandlers } from "./handlers/memory.js";
import { handlers as modelHandlers } from "./handlers/model.js";
import { handlers as observabilityHandlers } from "./handlers/observability.js";
import { handlers as permissionsHandlers } from "./handlers/permissions.js";
import { handlers as plansHandlers } from "./handlers/plans.js";
import { handlers as semanticHandlers } from "./handlers/semantic.js";
import { handlers as sessionsHandlers } from "./handlers/sessions.js";
import { handlers as skillHandlers } from "./handlers/skill.js";
import type { SlashContext, SlashResult } from "./types.js";

/** Synchronous return — async work fires-and-forgets via `ctx.postInfo` to keep input non-blocking. */
export type SlashHandler = (args: string[], loop: CacheFirstLoop, ctx: SlashContext) => SlashResult;

const HANDLERS: Record<string, SlashHandler> = {
  ...adminHandlers,
  ...basicHandlers,
  ...dashboardHandlers,
  ...editsHandlers,
  ...initHandlers,
  ...jobsHandlers,
  ...languageHandlers,
  ...mcpHandlers,
  ...memoryHandlers,
  ...modelHandlers,
  ...observabilityHandlers,
  ...permissionsHandlers,
  ...plansHandlers,
  ...semanticHandlers,
  ...sessionsHandlers,
  ...skillHandlers,
};

export function handleSlash(
  cmd: string,
  args: string[],
  loop: CacheFirstLoop,
  ctx: SlashContext = {},
): SlashResult {
  const h = HANDLERS[cmd];
  if (h) return h(args, loop, ctx);
  return { unknown: true, info: `unknown command: /${cmd}  (try /help)` };
}
