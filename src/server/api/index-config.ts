/** GET returns resolved + defaults so the SPA can render a "reset" button without re-implementing them. */

import { loadIndexUserConfig, readConfig, writeConfig } from "../../config.js";
import {
  DEFAULT_INDEX_EXCLUDES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_RESPECT_GITIGNORE,
  type IndexUserConfig,
  resolveIndexConfig,
} from "../../index/config.js";
import { type SkipReason, walkChunks } from "../../index/semantic/chunker.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

const PREVIEW_INCLUDED_CAP = 50;
const PREVIEW_PER_REASON_CAP = 10;

interface PostBody {
  excludeDirs?: unknown;
  excludeFiles?: unknown;
  excludeExts?: unknown;
  excludePatterns?: unknown;
  respectGitignore?: unknown;
  maxFileBytes?: unknown;
}

function parseBody(raw: string): PostBody {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as PostBody) : {};
  } catch {
    return {};
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export async function handleIndexConfig(
  method: string,
  rest: string[],
  body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  if (rest[0] === "preview" && method === "POST") {
    return await handlePreview(body, ctx);
  }
  if (method === "GET") {
    const user = loadIndexUserConfig(ctx.configPath);
    const resolved = resolveIndexConfig(user);
    return {
      status: 200,
      body: {
        user,
        resolved,
        defaults: {
          excludeDirs: [...DEFAULT_INDEX_EXCLUDES.dirs],
          excludeFiles: [...DEFAULT_INDEX_EXCLUDES.files],
          excludeExts: [...DEFAULT_INDEX_EXCLUDES.exts],
          excludePatterns: [],
          respectGitignore: DEFAULT_RESPECT_GITIGNORE,
          maxFileBytes: DEFAULT_MAX_FILE_BYTES,
        },
      },
    };
  }

  if (method === "POST") {
    const fields = parseBody(body);
    const next: IndexUserConfig = {};
    const changed: string[] = [];

    if (fields.excludeDirs !== undefined) {
      if (!isStringArray(fields.excludeDirs)) {
        return { status: 400, body: { error: "excludeDirs must be string[]" } };
      }
      next.excludeDirs = fields.excludeDirs;
      changed.push("excludeDirs");
    }
    if (fields.excludeFiles !== undefined) {
      if (!isStringArray(fields.excludeFiles)) {
        return { status: 400, body: { error: "excludeFiles must be string[]" } };
      }
      next.excludeFiles = fields.excludeFiles;
      changed.push("excludeFiles");
    }
    if (fields.excludeExts !== undefined) {
      if (!isStringArray(fields.excludeExts)) {
        return { status: 400, body: { error: "excludeExts must be string[]" } };
      }
      next.excludeExts = fields.excludeExts;
      changed.push("excludeExts");
    }
    if (fields.excludePatterns !== undefined) {
      if (!isStringArray(fields.excludePatterns)) {
        return { status: 400, body: { error: "excludePatterns must be string[]" } };
      }
      next.excludePatterns = fields.excludePatterns;
      changed.push("excludePatterns");
    }
    if (fields.respectGitignore !== undefined) {
      if (typeof fields.respectGitignore !== "boolean") {
        return { status: 400, body: { error: "respectGitignore must be boolean" } };
      }
      next.respectGitignore = fields.respectGitignore;
      changed.push("respectGitignore");
    }
    if (fields.maxFileBytes !== undefined) {
      if (typeof fields.maxFileBytes !== "number" || fields.maxFileBytes <= 0) {
        return { status: 400, body: { error: "maxFileBytes must be a positive number" } };
      }
      next.maxFileBytes = fields.maxFileBytes;
      changed.push("maxFileBytes");
    }

    const cfg = readConfig(ctx.configPath);
    cfg.index = { ...(cfg.index ?? {}), ...next };
    writeConfig(cfg, ctx.configPath);
    if (changed.length > 0) {
      ctx.audit?.({ ts: Date.now(), action: "set-index-config", payload: { fields: changed } });
    }
    return { status: 200, body: { changed, resolved: resolveIndexConfig(cfg.index) } };
  }

  return { status: 405, body: { error: "GET or POST only" } };
}

async function handlePreview(body: string, ctx: DashboardContext): Promise<ApiResult> {
  const root = ctx.getCurrentCwd?.();
  if (!root) {
    return {
      status: 400,
      body: { error: "preview requires a code-mode session (no project root attached)" },
    };
  }
  const fields = parseBody(body);
  const draft: IndexUserConfig = {};
  if (isStringArray(fields.excludeDirs)) draft.excludeDirs = fields.excludeDirs;
  if (isStringArray(fields.excludeFiles)) draft.excludeFiles = fields.excludeFiles;
  if (isStringArray(fields.excludeExts)) draft.excludeExts = fields.excludeExts;
  if (isStringArray(fields.excludePatterns)) draft.excludePatterns = fields.excludePatterns;
  if (typeof fields.respectGitignore === "boolean")
    draft.respectGitignore = fields.respectGitignore;
  if (typeof fields.maxFileBytes === "number" && fields.maxFileBytes > 0) {
    draft.maxFileBytes = fields.maxFileBytes;
  }
  const resolved = resolveIndexConfig(draft);
  const skipBuckets: Record<SkipReason, number> = {
    defaultDir: 0,
    defaultFile: 0,
    binaryExt: 0,
    binaryContent: 0,
    tooLarge: 0,
    gitignore: 0,
    pattern: 0,
    readError: 0,
  };
  const skipSamples: Record<SkipReason, string[]> = {
    defaultDir: [],
    defaultFile: [],
    binaryExt: [],
    binaryContent: [],
    tooLarge: [],
    gitignore: [],
    pattern: [],
    readError: [],
  };
  const includedFiles = new Set<string>();
  const sampleIncluded: string[] = [];
  for await (const chunk of walkChunks(root, {
    config: resolved,
    onSkip: (rel, reason) => {
      skipBuckets[reason]++;
      const bucket = skipSamples[reason];
      if (bucket.length < PREVIEW_PER_REASON_CAP) bucket.push(rel);
    },
  })) {
    if (!includedFiles.has(chunk.path)) {
      includedFiles.add(chunk.path);
      if (sampleIncluded.length < PREVIEW_INCLUDED_CAP) sampleIncluded.push(chunk.path);
    }
  }
  return {
    status: 200,
    body: {
      filesIncluded: includedFiles.size,
      sampleIncluded,
      skipBuckets,
      skipSamples,
      resolved,
    },
  };
}
