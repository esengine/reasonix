/**
 * Per-session plan persistence.
 *
 * The structured plan that the model submits via `submit_plan` (and
 * subsequently mutates via `mark_step_complete` / `revise_plan`) is a
 * meaningful artifact of the user's work. Without persistence it
 * evaporates the moment the terminal closes — which means the user
 * loses context every time they take a coffee break, and the rich
 * checkpoint / revise / progress UX has nothing to attach to in
 * resumed sessions.
 *
 * This module ships the smallest useful piece: read/write a plan
 * state JSON next to the session's JSONL log. App.tsx loads on
 * mount and saves after every state change. Storage path mirrors
 * the JSONL convention: `~/.reasonix/sessions/<sanitized>.plan.json`.
 *
 * What's persisted: the structured `steps[]` (with risk levels), the
 * set of completedStepIds, and an updatedAt timestamp. The plan's
 * markdown body is NOT persisted here — it lives in the JSONL log
 * (it was a tool result), so resuming the session replays it
 * naturally if the user wants to re-read it. We only carry forward
 * the live state needed to keep mark_step_complete and revise_plan
 * meaningful.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeName, sessionsDir } from "../session.js";
import type { PlanStep } from "../tools/plan.js";

export interface PlanStateOnDisk {
  /** File format version — bump when shape changes. */
  version: 1;
  steps: PlanStep[];
  completedStepIds: string[];
  /** ISO8601 timestamp of the last write. */
  updatedAt: string;
}

export function planStatePath(sessionName: string): string {
  return join(sessionsDir(), `${sanitizeName(sessionName)}.plan.json`);
}

/**
 * Read the persisted plan for this session, if any. Returns `null`
 * for missing / unreadable / malformed files — callers should treat
 * the absence of a stored plan as "no plan yet", not a hard error.
 */
export function loadPlanState(sessionName: string): PlanStateOnDisk | null {
  const path = planStatePath(sessionName);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PlanStateOnDisk>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== 1) return null;
    if (!Array.isArray(parsed.steps)) return null;
    if (!Array.isArray(parsed.completedStepIds)) return null;
    if (typeof parsed.updatedAt !== "string") return null;
    // Defensive: filter out any malformed step entries so a partially
    // corrupted file still yields a usable subset.
    const steps: PlanStep[] = [];
    for (const s of parsed.steps) {
      if (!s || typeof s !== "object") continue;
      const e = s as unknown as Record<string, unknown>;
      if (typeof e.id !== "string" || !e.id) continue;
      if (typeof e.title !== "string" || !e.title) continue;
      if (typeof e.action !== "string" || !e.action) continue;
      const step: PlanStep = { id: e.id, title: e.title, action: e.action };
      if (e.risk === "low" || e.risk === "med" || e.risk === "high") step.risk = e.risk;
      steps.push(step);
    }
    if (steps.length === 0) return null;
    const completedStepIds = parsed.completedStepIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    return { version: 1, steps, completedStepIds, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

/**
 * Persist the current plan state. Called whenever the in-memory plan
 * meaningfully changes (submit, complete, revise). Best-effort: a
 * write failure logs to stderr but doesn't propagate — losing the
 * persisted copy is annoying but shouldn't crash the TUI.
 */
export function savePlanState(
  sessionName: string,
  steps: PlanStep[],
  completedStepIds: Iterable<string>,
): void {
  const path = planStatePath(sessionName);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const state: PlanStateOnDisk = {
      version: 1,
      steps,
      completedStepIds: [...completedStepIds],
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (err) {
    process.stderr.write(
      `▸ plan-store: failed to save plan for "${sessionName}": ${(err as Error).message}\n`,
    );
  }
}

/** Remove the persisted plan, if any. Used on cancel / clean reset. */
export function clearPlanState(sessionName: string): void {
  const path = planStatePath(sessionName);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* nothing to do — leftover file is harmless, will be overwritten next save */
  }
}

/**
 * Move the active plan to a timestamped .done.json archive when the
 * model has marked every step complete. Future Time-Travel replay
 * will load these archives; for now the archive just exists as a
 * historical artifact and frees the active plan.json so the next
 * session starts fresh.
 *
 * Returns the archive path on success, or null if there was nothing
 * to archive (no active plan) / the rename failed (logged to stderr,
 * not propagated — losing the archive is annoying but shouldn't
 * crash the TUI).
 *
 * The timestamp uses ISO 8601 with a millisecond suffix and `:` and
 * `.` swapped for `-` so the filename is filesystem-safe on Windows.
 * Two archives created within the same millisecond would collide;
 * we append a short random suffix to dodge that.
 */
export function archivePlanState(sessionName: string): string | null {
  const active = planStatePath(sessionName);
  if (!existsSync(active)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 6);
  const archive = join(
    sessionsDir(),
    `${sanitizeName(sessionName)}.plan.${stamp}-${suffix}.done.json`,
  );
  try {
    renameSync(active, archive);
    return archive;
  } catch (err) {
    process.stderr.write(
      `▸ plan-store: failed to archive plan for "${sessionName}": ${(err as Error).message}\n`,
    );
    return null;
  }
}

/**
 * Render `updatedAt` as a short relative-time string for the resume
 * notice ("2h ago", "3 days ago"). Falls back to the raw ISO string
 * for anything beyond a week so users don't see misleading
 * "47 days ago" approximations.
 */
export function relativeTime(updatedAt: string, now: number = Date.now()): string {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return updatedAt;
  const diffMs = Math.max(0, now - t);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return updatedAt.slice(0, 10);
}
