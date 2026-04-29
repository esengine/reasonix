import {
  createCheckpoint,
  deleteCheckpoint,
  findCheckpoint,
  fmtAgo,
  listCheckpoints,
  restoreCheckpoint,
} from "../../../../code/checkpoints.js";
import type { EditMode } from "../../../../config.js";
import { parseEditIndices } from "../../edit-history.js";
import type { SlashHandler } from "../dispatch.js";
import { runGitCommit, stripOuterQuotes } from "../helpers.js";

const undo: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeUndo) {
    return {
      info: "/undo is only available inside `reasonix code` — chat mode doesn't apply edits.",
    };
  }
  return { info: ctx.codeUndo(args) };
};

const history: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.codeHistory) {
    return { info: "/history is only available inside `reasonix code`." };
  }
  return { info: ctx.codeHistory() };
};

const show: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeShowEdit) {
    return { info: "/show is only available inside `reasonix code`." };
  }
  return { info: ctx.codeShowEdit(args) };
};

const apply: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeApply) {
    return {
      info: "/apply is only available inside `reasonix code` (nothing to apply here).",
    };
  }
  const parsed = parseIndicesArg(args, ctx.pendingEditCount ?? 0);
  if ("error" in parsed) return { info: `/apply: ${parsed.error}` };
  return { info: ctx.codeApply(parsed.indices) };
};

const discard: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeDiscard) {
    return {
      info: "/discard is only available inside `reasonix code`.",
    };
  }
  const parsed = parseIndicesArg(args, ctx.pendingEditCount ?? 0);
  if ("error" in parsed) return { info: `/discard: ${parsed.error}` };
  return { info: ctx.codeDiscard(parsed.indices) };
};

/**
 * Bridge between the `args: string[]` shape commander gives us and the
 * comma-separated index syntax users actually type ("/apply 1,3-4").
 * The TUI's slash parser splits on whitespace, so `1,3-4` arrives as
 * `["1,3-4"]` and `1, 3, 4` arrives as `["1,", "3,", "4"]`. Re-joining
 * with commas + delegating to `parseEditIndices` handles both shapes.
 *
 * Empty `args` → `{ indices: [] }` (caller treats as "all").
 */
function parseIndicesArg(
  args: readonly string[],
  max: number,
): { indices: readonly number[] } | { error: string } {
  const raw = args.join(",").replace(/,+/g, ",").replace(/^,|,$/g, "");
  if (!raw) return { indices: [] };
  const parsed = parseEditIndices(raw, max);
  if ("error" in parsed) return { error: parsed.error };
  return { indices: parsed.ok };
}

const plan: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.setPlanMode) {
    return {
      info: "/plan is only available inside `reasonix code` — chat mode doesn't gate tool writes.",
    };
  }
  const currentOn = Boolean(ctx.planMode);
  const raw = (args[0] ?? "").toLowerCase();
  let target: boolean;
  if (raw === "on" || raw === "true" || raw === "1") target = true;
  else if (raw === "off" || raw === "false" || raw === "0") target = false;
  else target = !currentOn;
  ctx.setPlanMode(target);
  if (target) {
    return {
      info: "▸ plan mode ON — write tools are gated; the model MUST call `submit_plan` before anything executes. (The model can also call submit_plan on its own for big tasks even when plan mode is off — this toggle is the stronger, explicit constraint.) Type /plan off to leave.",
    };
  }
  return {
    info: "▸ plan mode OFF — write tools are live again. Model can still propose plans autonomously for large tasks.",
  };
};

const applyPlan: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.setPlanMode) {
    return {
      info: "/apply-plan is only available inside `reasonix code`.",
    };
  }
  ctx.setPlanMode(false);
  ctx.clearPendingPlan?.();
  return {
    info: "▸ plan approved — implementing",
    resubmit:
      "The plan above has been approved. Implement it now. You are out of plan mode — use edit_file / write_file / run_command as needed. Stick to the plan unless you discover a concrete reason to deviate; if you do, tell me and wait for a response before making that deviation.",
  };
};

const mode: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.setEditMode) {
    return {
      info: "/mode is only available inside `reasonix code`.",
    };
  }
  const raw = (args[0] ?? "").toLowerCase();
  const current = ctx.editMode ?? "review";
  let target: EditMode;
  if (raw === "review") target = "review";
  else if (raw === "auto") target = "auto";
  else if (raw === "yolo") target = "yolo";
  else if (raw === "") {
    // Bare /mode cycles review → auto → yolo → review, mirroring
    // Shift+Tab. Users who just want to see current mode without
    // flipping can read /status.
    target = current === "review" ? "auto" : current === "auto" ? "yolo" : "review";
  } else {
    return {
      info: "usage: /mode <review|auto|yolo>   (Shift+Tab also cycles)",
    };
  }
  ctx.setEditMode(target);
  const banner =
    target === "yolo"
      ? "▸ edit mode: YOLO — edits AND shell commands auto-run with no prompt. /undo still rolls back edits. Use carefully."
      : target === "auto"
        ? "▸ edit mode: AUTO — edits apply immediately; press u within 5s to undo, or /undo later. Shell commands still ask."
        : "▸ edit mode: review — edits queue for /apply (or y) / /discard (or n)";
  return { info: banner };
};

const commit: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeRoot) {
    return {
      info: "/commit is only available inside `reasonix code` (needs a rooted git repo).",
    };
  }
  // Reassemble the original argv. The parser lowercases cmd but leaves
  // args alone, and the TUI splits on whitespace which mangles quoted
  // messages — rejoin with spaces and strip a surrounding pair of
  // double quotes if the user wrote them.
  const raw = args.join(" ").trim();
  const message = stripOuterQuotes(raw);
  if (!message) {
    return {
      info: `usage: /commit "your commit message"  — runs \`git add -A && git commit -m "…"\` in ${ctx.codeRoot}`,
    };
  }
  return runGitCommit(ctx.codeRoot, message);
};

const walk: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.startWalkthrough) {
    return {
      info: "/walk is only available inside `reasonix code`.",
    };
  }
  return { info: ctx.startWalkthrough() };
};

/**
 * `/checkpoint [name]` — snapshot every file the session has touched
 * (or recently queued an edit against) to a Reasonix-internal store.
 * Survives `reasonix code` exiting; restore later with `/restore`.
 *
 * Sub-commands:
 *   /checkpoint                     → list (same as /checkpoint list)
 *   /checkpoint <name>              → save a new checkpoint named <name>
 *   /checkpoint list                → enumerate stored snapshots
 *   /checkpoint forget <id|name>    → delete one
 *
 * Why this and not git auto-commit: doesn't pollute the user's git
 * history, works in non-git directories, doesn't fight with hooks /
 * branch state. See `feedback_internal_checkpoints_over_git.md` for
 * the full rationale.
 */
const checkpoint: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeRoot || !ctx.touchedFiles) {
    return {
      info: "/checkpoint is only available inside `reasonix code` — chat mode doesn't apply edits.",
    };
  }
  const sub = (args[0] ?? "").toLowerCase();
  const rest = args.slice(1).join(" ").trim();

  if (sub === "" || sub === "list") {
    const items = [...listCheckpoints(ctx.codeRoot)].reverse();
    if (items.length === 0) {
      return {
        info: "no checkpoints yet — `/checkpoint <name>` snapshots every file the session has touched. Restore later with `/restore <name>`.",
      };
    }
    const lines = [`◈ checkpoints · ${items.length} stored`, ""];
    for (const m of items) {
      const sizeKb = (m.bytes / 1024).toFixed(1);
      const tag = m.source === "manual" ? "" : ` (${m.source})`;
      lines.push(
        `  ${m.id}  ${fmtAgo(m.createdAt).padEnd(8)}  ${m.name}${tag}  ·  ${m.fileCount} file${m.fileCount === 1 ? "" : "s"}, ${sizeKb} KB`,
      );
    }
    lines.push("");
    lines.push("  /restore <name|id> · /checkpoint forget <id> · /checkpoint <name> to add");
    return { info: lines.join("\n") };
  }

  if (sub === "forget" || sub === "rm" || sub === "delete") {
    if (!rest) return { info: "usage: /checkpoint forget <id|name>" };
    const found = findCheckpoint(ctx.codeRoot, rest);
    if (!found) return { info: `▸ no checkpoint matching "${rest}" — see /checkpoint list` };
    const ok = deleteCheckpoint(ctx.codeRoot, found.id);
    return {
      info: ok
        ? `▸ deleted checkpoint ${found.id} (${found.name})`
        : `▸ failed to delete ${found.id} (already gone?)`,
    };
  }

  // `/checkpoint <name>` (any free-form name) → save
  const name = args.join(" ").trim();
  if (!name) {
    return {
      info: "usage: /checkpoint <name>   (or /checkpoint list to see existing)",
    };
  }
  const paths = ctx.touchedFiles();
  const meta = createCheckpoint({
    rootDir: ctx.codeRoot,
    name,
    paths,
    source: "manual",
  });
  if (paths.length === 0) {
    return {
      info: `▸ checkpoint "${name}" saved (${meta.id}) — but no files have been touched yet, so it's an empty baseline. Edits made after this point will be revertable.`,
    };
  }
  return {
    info: `▸ checkpoint "${name}" saved (${meta.id}) — ${meta.fileCount} file${meta.fileCount === 1 ? "" : "s"}, ${(meta.bytes / 1024).toFixed(1)} KB. Restore: /restore ${name}`,
  };
};

/**
 * `/restore <id|name>` — write a checkpoint's files back to disk.
 * Files that didn't exist at snapshot time get deleted. Files that
 * weren't in the snapshot are left untouched (the snapshot is
 * declarative for what it captured, not for the whole project).
 *
 * Doesn't touch the model's edit history or pending-edit queue —
 * `/undo` is for in-session reverts, `/restore` for cross-session.
 */
const restore: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.codeRoot) {
    return {
      info: "/restore is only available inside `reasonix code`.",
    };
  }
  const target = args.join(" ").trim();
  if (!target) {
    return {
      info: "usage: /restore <name|id>   (see /checkpoint list for ids)",
    };
  }
  const found = findCheckpoint(ctx.codeRoot, target);
  if (!found) {
    return { info: `▸ no checkpoint matching "${target}" — try /checkpoint list` };
  }
  const result = restoreCheckpoint(ctx.codeRoot, found.id);
  const lines = [`▸ restored "${found.name}" (${found.id}) from ${fmtAgo(found.createdAt)}`];
  if (result.restored.length > 0) {
    lines.push(
      `  · wrote back ${result.restored.length} file${result.restored.length === 1 ? "" : "s"}`,
    );
  }
  if (result.removed.length > 0) {
    lines.push(
      `  · removed ${result.removed.length} file${result.removed.length === 1 ? "" : "s"} (didn't exist at checkpoint time)`,
    );
  }
  if (result.skipped.length > 0) {
    lines.push(
      `  ✗ ${result.skipped.length} file${result.skipped.length === 1 ? "" : "s"} skipped:`,
    );
    for (const s of result.skipped.slice(0, 5)) {
      lines.push(`    ${s.path} — ${s.reason}`);
    }
    if (result.skipped.length > 5) {
      lines.push(`    … ${result.skipped.length - 5} more`);
    }
  }
  return { info: lines.join("\n") };
};

export const handlers: Record<string, SlashHandler> = {
  undo,
  history,
  show,
  apply,
  discard,
  plan,
  "apply-plan": applyPlan,
  applyplan: applyPlan,
  mode,
  commit,
  walk,
  checkpoint,
  restore,
};
