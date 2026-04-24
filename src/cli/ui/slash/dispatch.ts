import type { CacheFirstLoop } from "../../../loop.js";
import { handlers as adminHandlers } from "./handlers/admin.js";
import { handlers as basicHandlers } from "./handlers/basic.js";
import { handlers as editsHandlers } from "./handlers/edits.js";
import { handlers as jobsHandlers } from "./handlers/jobs.js";
import { handlers as mcpHandlers } from "./handlers/mcp.js";
import { handlers as memoryHandlers } from "./handlers/memory.js";
import { handlers as modelHandlers } from "./handlers/model.js";
import { handlers as observabilityHandlers } from "./handlers/observability.js";
import { handlers as sessionsHandlers } from "./handlers/sessions.js";
import { handlers as skillHandlers } from "./handlers/skill.js";
import type { SlashContext, SlashResult } from "./types.js";

/**
 * A slash handler receives the command's args + the loop + shared
 * runtime context, and returns a synchronous SlashResult. Async work
 * (balance fetches, stop_job) fires-and-forgets via `ctx.postInfo`
 * instead — keeps the TUI input non-blocking.
 */
export type SlashHandler = (args: string[], loop: CacheFirstLoop, ctx: SlashContext) => SlashResult;

/**
 * Flat map of cmd → handler. Composed from per-topic modules so each
 * feature's logic stays local; aliases (e.g. `exit` / `quit`) are just
 * extra keys in the per-module handlers bag pointing at the same fn.
 *
 * Ordering of the spread matters only for duplicate keys; there are
 * none. Keep alphabetical for diff sanity when adding modules.
 */
const HANDLERS: Record<string, SlashHandler> = {
  ...adminHandlers,
  ...basicHandlers,
  ...editsHandlers,
  ...jobsHandlers,
  ...mcpHandlers,
  ...memoryHandlers,
  ...modelHandlers,
  ...observabilityHandlers,
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
