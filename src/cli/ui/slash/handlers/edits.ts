import type { EditMode } from "../../../../config.js";
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

const apply: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.codeApply) {
    return {
      info: "/apply is only available inside `reasonix code` (nothing to apply here).",
    };
  }
  return { info: ctx.codeApply() };
};

const discard: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.codeDiscard) {
    return {
      info: "/discard is only available inside `reasonix code`.",
    };
  }
  return { info: ctx.codeDiscard() };
};

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
  else if (raw === "") {
    // Bare /mode toggles, mirroring Shift+Tab. Users who just want to
    // see current mode without flipping can read /status.
    target = current === "auto" ? "review" : "auto";
  } else {
    return { info: "usage: /mode <review|auto>   (Shift+Tab also cycles)" };
  }
  ctx.setEditMode(target);
  return {
    info:
      target === "auto"
        ? "▸ edit mode: AUTO — edits apply immediately; press u within 5s to undo, or /undo later"
        : "▸ edit mode: review — edits queue for /apply (or y) / /discard (or n)",
  };
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
};
