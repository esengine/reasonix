/** Reload is a separate POST so save and apply stay decoupled; the SPA chains them by convention. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HOOK_EVENTS, globalSettingsPath, loadHooks, projectSettingsPath } from "../../hooks.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";
import { readRecentHookRuns } from "./hooks-events.js";

interface SaveBody {
  scope?: unknown;
  hooks?: unknown;
}

function parseBody(raw: string): SaveBody {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as SaveBody) : {};
  } catch {
    return {};
  }
}

function readSettingsFile(path: string): { hooks?: Record<string, unknown[]> } {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettingsFile(path: string, hooksBlock: unknown): void {
  // Preserve any other top-level keys that may live in the file.
  const existing = readSettingsFile(path);
  existing.hooks = hooksBlock as Record<string, unknown[]>;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

export async function handleHooks(
  method: string,
  rest: string[],
  body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  if (method === "GET" && rest.length === 0) {
    const projectPath = ctx.getCurrentCwd ? projectSettingsPath(ctx.getCurrentCwd() ?? "") : null;
    const globalPath = globalSettingsPath();
    const projectFile = projectPath ? readSettingsFile(projectPath) : {};
    const globalFile = readSettingsFile(globalPath);
    const resolved = loadHooks({ projectRoot: ctx.getCurrentCwd?.() });
    return {
      status: 200,
      body: {
        project: {
          path: projectPath,
          hooks: projectFile.hooks ?? {},
        },
        global: {
          path: globalPath,
          hooks: globalFile.hooks ?? {},
        },
        resolved,
        events: HOOK_EVENTS,
        recentRuns: readRecentHookRuns(undefined, ctx.sessionsDir),
      },
    };
  }

  if (method === "POST" && rest[0] === "save") {
    const { scope, hooks } = parseBody(body);
    if (scope !== "project" && scope !== "global") {
      return { status: 400, body: { error: "scope must be project | global" } };
    }
    if (typeof hooks !== "object" || hooks === null) {
      return { status: 400, body: { error: "hooks must be an object keyed by event name" } };
    }
    let path: string | null;
    if (scope === "project") {
      const cwd = ctx.getCurrentCwd?.();
      if (!cwd) {
        return {
          status: 503,
          body: { error: "no active project — open `/dashboard` from inside `reasonix code`" },
        };
      }
      path = projectSettingsPath(cwd);
    } else {
      path = globalSettingsPath();
    }
    if (!path) {
      return { status: 500, body: { error: "could not resolve settings path" } };
    }
    writeSettingsFile(path, hooks);
    ctx.audit?.({ ts: Date.now(), action: "save-hooks", payload: { scope, path } });
    return { status: 200, body: { saved: true, path } };
  }

  if (method === "POST" && rest[0] === "reload") {
    if (!ctx.reloadHooks) {
      return {
        status: 503,
        body: { error: "reload requires an attached session — App.tsx wires the callback" },
      };
    }
    const count = ctx.reloadHooks();
    ctx.audit?.({ ts: Date.now(), action: "reload-hooks", payload: { count } });
    return { status: 200, body: { reloaded: true, count } };
  }

  return { status: 405, body: { error: `method ${method} not supported on this path` } };
}
