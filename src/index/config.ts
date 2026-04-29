/** Shared exclude defaults + resolver — chunker, directory_tree, and dashboard read from here. */

import picomatch from "picomatch";

export interface IndexUserConfig {
  excludeDirs?: string[];
  excludeFiles?: string[];
  excludeExts?: string[];
  excludePatterns?: string[];
  respectGitignore?: boolean;
  maxFileBytes?: number;
}

/** Plain-data shape — JSON-safe so the dashboard endpoint can serialize. */
export interface ResolvedIndexConfig {
  excludeDirs: readonly string[];
  excludeFiles: readonly string[];
  excludeExts: readonly string[];
  excludePatterns: readonly string[];
  respectGitignore: boolean;
  maxFileBytes: number;
}

/** Hot-path lookup wrapper — built once per indexer run, never serialized. */
export interface IndexFilters {
  dirSet: ReadonlySet<string>;
  fileSet: ReadonlySet<string>;
  extSet: ReadonlySet<string>;
  patternMatch: (relPath: string) => boolean;
  respectGitignore: boolean;
  maxFileBytes: number;
}

export const DEFAULT_INDEX_EXCLUDES = {
  dirs: [
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".cache",
    "coverage",
    ".turbo",
    ".vercel",
    ".reasonix",
  ] as const,
  files: [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "poetry.lock",
    "Pipfile.lock",
    "go.sum",
    ".DS_Store",
  ] as const,
  exts: [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".tiff",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".zip",
    ".tar",
    ".gz",
    ".bz2",
    ".xz",
    ".rar",
    ".7z",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
    ".class",
    ".jar",
    ".war",
    ".wasm",
    ".o",
    ".obj",
    ".lib",
    ".a",
    ".pyc",
    ".pyo",
    ".mp3",
    ".mp4",
    ".wav",
    ".ogg",
    ".webm",
    ".mov",
    ".avi",
    ".pdf",
    ".sqlite",
    ".db",
  ] as const,
} as const;

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_RESPECT_GITIGNORE = true;

export function defaultIndexConfig(): ResolvedIndexConfig {
  return {
    excludeDirs: [...DEFAULT_INDEX_EXCLUDES.dirs],
    excludeFiles: [...DEFAULT_INDEX_EXCLUDES.files],
    excludeExts: [...DEFAULT_INDEX_EXCLUDES.exts],
    excludePatterns: [],
    respectGitignore: DEFAULT_RESPECT_GITIGNORE,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  };
}

/** A field present in user config fully replaces the default for that field. Absent → default. */
export function resolveIndexConfig(user?: IndexUserConfig | null): ResolvedIndexConfig {
  const d = defaultIndexConfig();
  if (!user) return d;
  return {
    excludeDirs: Array.isArray(user.excludeDirs) ? [...user.excludeDirs] : d.excludeDirs,
    excludeFiles: Array.isArray(user.excludeFiles) ? [...user.excludeFiles] : d.excludeFiles,
    excludeExts: Array.isArray(user.excludeExts)
      ? user.excludeExts.map((e) => e.toLowerCase())
      : d.excludeExts,
    excludePatterns: Array.isArray(user.excludePatterns) ? [...user.excludePatterns] : [],
    respectGitignore:
      typeof user.respectGitignore === "boolean" ? user.respectGitignore : d.respectGitignore,
    maxFileBytes:
      typeof user.maxFileBytes === "number" && user.maxFileBytes > 0
        ? user.maxFileBytes
        : d.maxFileBytes,
  };
}

export function compileFilters(cfg: ResolvedIndexConfig): IndexFilters {
  const matcher =
    cfg.excludePatterns.length === 0
      ? () => false
      : picomatch(cfg.excludePatterns as string[], { dot: true });
  return {
    dirSet: new Set(cfg.excludeDirs),
    fileSet: new Set(cfg.excludeFiles),
    extSet: new Set(cfg.excludeExts.map((e) => e.toLowerCase())),
    patternMatch: matcher as (p: string) => boolean,
    respectGitignore: cfg.respectGitignore,
    maxFileBytes: cfg.maxFileBytes,
  };
}
