import { handleAbort } from "./api/abort.js";
import { handleEditMode } from "./api/edit-mode.js";
import { handleHealth } from "./api/health.js";
import { handleHooks } from "./api/hooks.js";
import { handleIndexConfig } from "./api/index-config.js";
import { handleMcp } from "./api/mcp.js";
import { handleMemory } from "./api/memory.js";
import { handleMessages } from "./api/messages.js";
import { handleModal } from "./api/modal.js";
import { handleOverview } from "./api/overview.js";
import { handlePermissions } from "./api/permissions.js";
import { handlePlans } from "./api/plans.js";
import { handleSemantic } from "./api/semantic.js";
import { handleSessions } from "./api/sessions.js";
import { handleSettings } from "./api/settings.js";
import { handleSkills } from "./api/skills.js";
import { handleSubmit } from "./api/submit.js";
import { handleTools } from "./api/tools.js";
import { handleUsage } from "./api/usage.js";
import type { DashboardContext } from "./context.js";

export interface ApiResult {
  status: number;
  body: unknown;
}

export async function handleApi(
  pathTail: string,
  method: string,
  body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  // Strip a trailing slash so /api/usage and /api/usage/ both work.
  const normalized = pathTail.replace(/\/+$/, "");
  const [head, ...rest] = normalized.split("/");

  try {
    switch (head) {
      case "overview":
        return await handleOverview(method, rest, body, ctx);
      case "usage":
        return await handleUsage(method, rest, body, ctx);
      case "tools":
        return await handleTools(method, rest, body, ctx);
      case "permissions":
        return await handlePermissions(method, rest, body, ctx);
      case "messages":
        return await handleMessages(method, rest, body, ctx);
      case "submit":
        return await handleSubmit(method, rest, body, ctx);
      case "abort":
        return await handleAbort(method, rest, body, ctx);
      case "health":
        return await handleHealth(method, rest, body, ctx);
      case "sessions":
        return await handleSessions(method, rest, body, ctx);
      case "plans":
        return await handlePlans(method, rest, body, ctx);
      case "modal":
        return await handleModal(method, rest, body, ctx);
      case "edit-mode":
        return await handleEditMode(method, rest, body, ctx);
      case "settings":
        return await handleSettings(method, rest, body, ctx);
      case "hooks":
        return await handleHooks(method, rest, body, ctx);
      case "memory":
        return await handleMemory(method, rest, body, ctx);
      case "skills":
        return await handleSkills(method, rest, body, ctx);
      case "mcp":
        return await handleMcp(method, rest, body, ctx);
      case "semantic":
        return await handleSemantic(method, rest, body, ctx);
      case "index-config":
        return await handleIndexConfig(method, rest, body, ctx);
      default:
        return { status: 404, body: { error: `no such endpoint: /${head}` } };
    }
  } catch (err) {
    // Any unexpected throw maps to 500. Endpoint code that wants a
    // user-friendly 4xx must catch + return the envelope itself.
    return {
      status: 500,
      body: { error: `handler crashed: ${(err as Error).message}` },
    };
  }
}
