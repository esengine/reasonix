import {
  PROJECT_MEMORY_FILE,
  memoryEnabled,
  readProjectMemory,
} from "../../../../project-memory.js";
import { type MemoryScope, MemoryStore } from "../../../../user-memory.js";
import type { SlashHandler } from "../dispatch.js";
import { resolveMemoryTarget } from "../helpers.js";

/**
 * `/memory` family. Bare `/memory` shows what's pinned (REASONIX.md +
 * both MEMORY.md blocks). Subcommands manage the user-memory store:
 *   list                 — every memory file, both scopes
 *   show <name>          — dump one file's body
 *   show <scope>/<name>  — disambiguate when name exists in both scopes
 *   forget <name>        — delete (same scope resolution as show)
 *   clear <scope> confirm — wipe a scope (typed literal "confirm" required)
 */
const memory: SlashHandler = (args, _loop, ctx) => {
  if (!memoryEnabled()) {
    return {
      info: "memory is disabled (REASONIX_MEMORY=off in env). Unset the var to re-enable — no REASONIX.md or ~/.reasonix/memory content will be pinned in the meantime.",
    };
  }
  if (!ctx.memoryRoot) {
    return {
      info: "no working directory on this session — `/memory` needs a root to resolve REASONIX.md from. (Running in a test harness?)",
    };
  }
  // `codeRoot` is set only when running `reasonix code`. Chat mode has
  // `memoryRoot` = cwd (for REASONIX.md), but we don't treat cwd as a
  // sandbox — project-scope user memory requires a real code-mode root.
  const store = new MemoryStore({ projectRoot: ctx.codeRoot });
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "list" || sub === "ls") {
    const entries = store.list();
    if (entries.length === 0) {
      return {
        info: "no user memories yet. The model can call `remember` to save one, or you can create files by hand in ~/.reasonix/memory/global/ or the per-project subdir.",
      };
    }
    const lines = [`User memories (${entries.length}):`];
    for (const e of entries) {
      const tag = `${e.scope}/${e.type}`.padEnd(18);
      const name = e.name.padEnd(28);
      const desc = e.description.length > 70 ? `${e.description.slice(0, 69)}…` : e.description;
      lines.push(`  ${tag}  ${name}  ${desc}`);
    }
    lines.push("");
    lines.push("View body: /memory show <name>   Delete: /memory forget <name>");
    return { info: lines.join("\n") };
  }

  if (sub === "show" || sub === "cat") {
    const target = args[1];
    if (!target) return { info: "usage: /memory show <name>  or  /memory show <scope>/<name>" };
    const resolved = resolveMemoryTarget(store, target);
    if (!resolved) return { info: `no memory found: ${target}` };
    try {
      const entry = store.read(resolved.scope, resolved.name);
      return {
        info: [
          `▸ ${entry.scope}/${entry.name}  (${entry.type}, created ${entry.createdAt || "?"})`,
          entry.description ? `  ${entry.description}` : "",
          "",
          entry.body,
        ]
          .filter((l) => l !== "")
          .concat("")
          .join("\n"),
      };
    } catch (err) {
      return { info: `show failed: ${(err as Error).message}` };
    }
  }

  if (sub === "forget" || sub === "rm" || sub === "delete") {
    const target = args[1];
    if (!target) return { info: "usage: /memory forget <name>  or  /memory forget <scope>/<name>" };
    const resolved = resolveMemoryTarget(store, target);
    if (!resolved) return { info: `no memory found: ${target}` };
    try {
      const ok = store.delete(resolved.scope, resolved.name);
      return {
        info: ok
          ? `▸ forgot ${resolved.scope}/${resolved.name}. Next /new or launch won't see it.`
          : `could not forget ${resolved.scope}/${resolved.name} (already gone?)`,
      };
    } catch (err) {
      return { info: `forget failed: ${(err as Error).message}` };
    }
  }

  if (sub === "clear") {
    const rawScope = (args[1] ?? "").toLowerCase();
    if (rawScope !== "global" && rawScope !== "project") {
      return { info: "usage: /memory clear <global|project> confirm" };
    }
    if ((args[2] ?? "").toLowerCase() !== "confirm") {
      return {
        info: `about to delete every memory in scope=${rawScope}. Re-run with the word 'confirm' to proceed: /memory clear ${rawScope} confirm`,
      };
    }
    const scope = rawScope as MemoryScope;
    const entries = store.list().filter((e) => e.scope === scope);
    let deleted = 0;
    for (const e of entries) {
      try {
        if (store.delete(scope, e.name)) deleted++;
      } catch {
        /* skip */
      }
    }
    return { info: `▸ cleared scope=${scope} — deleted ${deleted} memory file(s).` };
  }

  // Bare `/memory` — show REASONIX.md + both MEMORY.md blocks.
  const parts: string[] = [];
  const projMem = readProjectMemory(ctx.memoryRoot);
  if (projMem) {
    const hdr = projMem.truncated
      ? `▸ ${PROJECT_MEMORY_FILE}: ${projMem.path} (${projMem.originalChars.toLocaleString()} chars, truncated)`
      : `▸ ${PROJECT_MEMORY_FILE}: ${projMem.path} (${projMem.originalChars.toLocaleString()} chars)`;
    parts.push(hdr, "", projMem.content);
  }
  const globalIdx = store.loadIndex("global");
  if (globalIdx) {
    parts.push(
      "",
      `▸ global memory (${globalIdx.originalChars.toLocaleString()} chars${globalIdx.truncated ? ", truncated" : ""})`,
      "",
      globalIdx.content,
    );
  }
  const projectIdx = store.loadIndex("project");
  if (projectIdx) {
    parts.push(
      "",
      `▸ project memory (${projectIdx.originalChars.toLocaleString()} chars${projectIdx.truncated ? ", truncated" : ""})`,
      "",
      projectIdx.content,
    );
  }
  if (parts.length === 0) {
    return {
      info: [
        `no memory pinned in ${ctx.memoryRoot}.`,
        "",
        "Three layers are available:",
        `  1. ${PROJECT_MEMORY_FILE} — committable team memory (in the repo).`,
        "  2. ~/.reasonix/memory/global/ — your cross-project private memory.",
        `  3. ~/.reasonix/memory/<project-hash>/ — this project's private memory.`,
        "",
        "Ask the model to `remember` something, or hand-edit files directly.",
        "Changes take effect on next /new or launch — the system prompt is hashed once per session to keep the prefix cache warm.",
        "",
        "Subcommands: /memory list | /memory show <name> | /memory forget <name> | /memory clear <scope> confirm",
      ].join("\n"),
    };
  }
  parts.push(
    "",
    "Changes take effect on next /new or launch. Subcommands: /memory list | show | forget | clear",
  );
  return { info: parts.join("\n") };
};

export const handlers: Record<string, SlashHandler> = { memory };
