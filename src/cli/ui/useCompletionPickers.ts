import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type FileWithStats,
  detectAtPicker,
  listFilesWithStatsAsync,
  rankPickerCandidates,
} from "../../at-mentions.js";
import {
  type McpServerSummary,
  type SlashArgContext,
  type SlashCommandSpec,
  detectSlashArgContext,
  suggestSlashCommands,
} from "./slash.js";

export interface UseCompletionPickersParams {
  input: string;
  setInput: (v: string) => void;
  codeMode: { rootDir: string } | undefined;
  /**
   * Live working directory for the @-mention file picker. May differ
   * from `codeMode.rootDir` after a `/cwd` switch — `codeMode` keeps
   * the launch root for "is this a code-mode session?" checks while
   * this drives the actual file listing.
   */
  rootDir: string;
  models: string[] | null;
  mcpServers: McpServerSummary[] | undefined;
}

export interface UseCompletionPickersResult {
  // ── slash-name picker ──
  slashMatches: SlashCommandSpec[] | null;
  slashSelected: number;
  setSlashSelected: React.Dispatch<React.SetStateAction<number>>;

  // ── @-mention picker ──
  atPicker: ReturnType<typeof detectAtPicker>;
  atMatches: readonly string[] | null;
  atSelected: number;
  setAtSelected: React.Dispatch<React.SetStateAction<number>>;
  pickAtMention: (chosenPath: string) => void;
  recordRecentFile: (path: string) => void;

  // ── slash-arg picker ──
  slashArgContext: SlashArgContext | null;
  slashArgMatches: readonly string[] | null;
  slashArgSelected: number;
  setSlashArgSelected: React.Dispatch<React.SetStateAction<number>>;
  pickSlashArg: (chosen: string) => void;
}

/**
 * The three mutually-exclusive input-prefix pickers share enough
 * structure (matches list + highlighted index + reset-on-shrink effect
 * + commit-back-into-buffer callback) that they live together here.
 * Priority in the parent useInput handler:
 *   atMatches > slashArgMatches > slashMatches > prompt history
 * detection already disambiguates by construction — the slash-name
 * picker fires only when the buffer has no space; the slash-arg picker
 * only after a space; the @-picker only outside slash mode.
 */
export function useCompletionPickers({
  input,
  setInput,
  codeMode,
  rootDir,
  models,
  mcpServers,
}: UseCompletionPickersParams): UseCompletionPickersResult {
  // ── slash-name picker ──
  const [slashSelected, setSlashSelected] = useState(0);
  const slashMatches = useMemo(() => {
    if (!input.startsWith("/") || input.includes(" ")) return null;
    return suggestSlashCommands(input.slice(1), !!codeMode);
  }, [input, codeMode]);
  useEffect(() => {
    setSlashSelected((prev) => {
      if (!slashMatches || slashMatches.length === 0) return 0;
      if (prev >= slashMatches.length) return slashMatches.length - 1;
      return prev;
    });
  }, [slashMatches]);

  // ── @-mention picker ──
  const [atSelected, setAtSelected] = useState(0);
  // Walk the code root asynchronously after first paint. Earlier
  // versions used `listFilesWithStatsSync` inside `useMemo`, which
  // blocked mount for 100-300ms on Windows monorepos (one statSync
  // per file × 500 files). Async + parallel-stat-per-directory
  // takes the cost off the critical path; the picker stays empty
  // for the brief window before the walk completes (typically
  // <200ms), and fills in atomically once Promise.all resolves.
  // Files created mid-session via tool edits still won't appear
  // until restart — rare; the user can type the full path.
  const [atFiles, setAtFiles] = useState<readonly FileWithStats[]>([]);
  useEffect(() => {
    if (!codeMode) {
      setAtFiles([]);
      return;
    }
    let cancelled = false;
    listFilesWithStatsAsync(rootDir, { maxResults: 500 })
      .then((files) => {
        if (!cancelled) setAtFiles(files);
      })
      .catch(() => {
        if (!cancelled) setAtFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [codeMode, rootDir]);
  // LRU of files touched by recent tool calls. Seeds the picker with
  // "stuff I just looked at" at the top, so a user typing `@` in the
  // same file they were just discussing gets it instantly.
  const recentFilesRef = useRef<string[]>([]);
  const recordRecentFile = useCallback((p: string) => {
    const list = recentFilesRef.current;
    const i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1);
    list.unshift(p);
    if (list.length > 20) list.length = 20;
  }, []);
  const atPicker = useMemo(() => {
    if (!codeMode) return null;
    // Slash prefix wins — avoids the picker confusingly surfacing on
    // `/@wat`-style edge inputs.
    if (slashMatches !== null) return null;
    return detectAtPicker(input);
  }, [codeMode, input, slashMatches]);
  const atMatches = useMemo<readonly string[] | null>(() => {
    if (!atPicker) return null;
    return rankPickerCandidates(atFiles, atPicker.query, {
      limit: 40,
      recentlyUsed: recentFilesRef.current,
    });
  }, [atPicker, atFiles]);
  useEffect(() => {
    setAtSelected((prev) => {
      if (!atMatches || atMatches.length === 0) return 0;
      if (prev >= atMatches.length) return atMatches.length - 1;
      return prev;
    });
  }, [atMatches]);
  const pickAtMention = useCallback(
    (chosenPath: string) => {
      if (!atPicker) return;
      const before = input.slice(0, atPicker.atOffset);
      setInput(`${before}@${chosenPath} `);
    },
    [atPicker, input, setInput],
  );

  // ── slash-arg picker ──
  const [slashArgSelected, setSlashArgSelected] = useState(0);
  const slashArgContext = useMemo<SlashArgContext | null>(() => {
    if (!input.startsWith("/")) return null;
    if (slashMatches !== null) return null;
    return detectSlashArgContext(input, !!codeMode);
  }, [input, slashMatches, codeMode]);
  const slashArgMatches = useMemo<readonly string[] | null>(() => {
    if (!slashArgContext || slashArgContext.kind !== "picker") return null;
    const completer = slashArgContext.spec.argCompleter;
    const partial = slashArgContext.partial;
    const needle = partial.toLowerCase();
    // Once the partial is an EXACT match for a valid completion, hide
    // the picker so Enter submits the command instead of re-picking
    // the same value in an infinite loop. Case-insensitive — users
    // may type `/preset FAST` and still mean the same thing.
    if (Array.isArray(completer)) {
      if (partial && completer.some((v) => v.toLowerCase() === needle)) return null;
      if (!partial) return completer.slice();
      return completer.filter((v) => v.toLowerCase().startsWith(needle));
    }
    if (completer === "models") {
      const all = models ?? [];
      if (partial && all.some((m) => m.toLowerCase() === needle)) return null;
      if (!partial) return all.slice(0, 40);
      return all.filter((m) => m.toLowerCase().includes(needle)).slice(0, 40);
    }
    if (completer === "mcp-resources") {
      // Aggregate URIs across every server's cached inspection.
      const uris: string[] = [];
      const servers = mcpServers ?? [];
      for (const s of servers) {
        if (!s.report.resources.supported) continue;
        for (const r of s.report.resources.items) uris.push(r.uri);
      }
      if (partial && uris.some((u) => u.toLowerCase() === needle)) return null;
      if (!partial) return uris.slice(0, 40);
      return uris.filter((u) => u.toLowerCase().includes(needle)).slice(0, 40);
    }
    if (completer === "mcp-prompts") {
      const names: string[] = [];
      const servers = mcpServers ?? [];
      for (const s of servers) {
        if (!s.report.prompts.supported) continue;
        for (const p of s.report.prompts.items) names.push(p.name);
      }
      if (partial && names.some((n) => n.toLowerCase() === needle)) return null;
      if (!partial) return names.slice(0, 40);
      return names.filter((n) => n.toLowerCase().includes(needle)).slice(0, 40);
    }
    return null;
  }, [slashArgContext, models, mcpServers]);
  useEffect(() => {
    setSlashArgSelected((prev) => {
      if (!slashArgMatches || slashArgMatches.length === 0) return 0;
      if (prev >= slashArgMatches.length) return slashArgMatches.length - 1;
      return prev;
    });
  }, [slashArgMatches]);
  const pickSlashArg = useCallback(
    (chosen: string) => {
      if (!slashArgContext) return;
      const before = input.slice(0, slashArgContext.partialOffset);
      // No trailing space — enum picks take no further args, so the
      // user presses Enter once more to run the command.
      setInput(`${before}${chosen}`);
    },
    [slashArgContext, input, setInput],
  );

  return {
    slashMatches,
    slashSelected,
    setSlashSelected,
    atPicker,
    atMatches,
    atSelected,
    setAtSelected,
    pickAtMention,
    recordRecentFile,
    slashArgContext,
    slashArgMatches,
    slashArgSelected,
    setSlashArgSelected,
    pickSlashArg,
  };
}
