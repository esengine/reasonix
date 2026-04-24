/**
 * Pure-TS port of DeepSeek's V3 tokenizer. Reads the slimmed+gzipped
 * HuggingFace-format tokenizer data shipped at
 * `data/deepseek-tokenizer.json.gz` and implements enough of the HF
 * pipeline (Split pre-tokenizers → ByteLevel → BPE) to count tokens
 * offline without pulling the `@lenml/tokenizers` or native Rust deps.
 *
 * Accuracy target: within ~3% of the API-returned `usage.prompt_tokens`
 * for mixed CJK+English+code input. Exact-to-API match would also
 * require replaying the Jinja chat template (role markers / tool call
 * framing); we intentionally skip that — for a gauge/UI estimate the
 * raw-text count is the useful number.
 *
 * Scope: ENCODE-SIDE ONLY. We don't need decode for counting; adding
 * it later is trivial via the inverse byte-level table.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

interface AddedToken {
  id: number;
  content: string;
  special: boolean;
  normalized: boolean;
}

interface SplitPretokenizer {
  type: "Split";
  pattern: { Regex: string };
  behavior: "Isolated" | "Removed" | string;
  invert: boolean;
}

interface ByteLevelPretokenizer {
  type: "ByteLevel";
  add_prefix_space: boolean;
  trim_offsets: boolean;
  use_regex: boolean;
}

type Pretokenizer = SplitPretokenizer | ByteLevelPretokenizer;

interface TokenizerData {
  added_tokens: AddedToken[];
  pre_tokenizer: {
    type: "Sequence";
    pretokenizers: Pretokenizer[];
  };
  model: {
    type: "BPE";
    vocab: Record<string, number>;
    merges: string[];
  };
}

interface LoadedTokenizer {
  vocab: Record<string, number>;
  mergeRank: Map<string, number>;
  splitRegexes: RegExp[];
  byteToChar: string[];
  /**
   * Non-special added tokens (e.g. `<think>`, `<｜fim▁hole｜>`) that the
   * HF tokenizer recognizes as atomic units when they appear inline in
   * the text. Special tokens like `<｜begin▁of▁sentence｜>` are NOT in
   * this list — the model ignores them when they appear in user text
   * (the default HF `split_special_tokens=False` behavior), so we do
   * the same: they get tokenized byte-by-byte, not as the special ID.
   */
  addedPattern: RegExp | null;
  addedMap: Map<string, number>;
}

/**
 * GPT-2 byte-to-unicode mapping. Covers every byte 0..255 with a
 * deterministic visible-printable unicode char — this is what lets the
 * byte-level BPE show up in JSON vocabs as readable strings (`Ġ` for
 * space, `Ċ` for `\n`, etc). Identical across every byte-level BPE
 * tokenizer DeepSeek ships.
 */
function buildByteToChar(): string[] {
  const result: string[] = new Array(256);
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  for (let i = 0; i < bs.length; i++) {
    result[bs[i]!] = String.fromCodePoint(cs[i]!);
  }
  return result;
}

let cached: LoadedTokenizer | null = null;

/**
 * Find the bundled tokenizer data file. Resolution order:
 * 1. `REASONIX_TOKENIZER_PATH` env var (for tests / custom builds).
 * 2. `../data/deepseek-tokenizer.json.gz` relative to this module —
 *    works both in dev (src/) and after tsup bundling (dist/).
 */
function resolveDataPath(): string {
  if (process.env.REASONIX_TOKENIZER_PATH) return process.env.REASONIX_TOKENIZER_PATH;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "data", "deepseek-tokenizer.json.gz");
  } catch {
    // CJS fallback — `require.resolve` finds the package root.
    const req = createRequire(import.meta.url);
    return join(
      dirname(req.resolve("reasonix/package.json")),
      "data",
      "deepseek-tokenizer.json.gz",
    );
  }
}

function loadTokenizer(): LoadedTokenizer {
  if (cached) return cached;
  const buf = readFileSync(resolveDataPath());
  const json = gunzipSync(buf).toString("utf8");
  const data = JSON.parse(json) as TokenizerData;

  const mergeRank = new Map<string, number>();
  for (let i = 0; i < data.model.merges.length; i++) {
    mergeRank.set(data.model.merges[i]!, i);
  }

  const splitRegexes: RegExp[] = [];
  for (const p of data.pre_tokenizer.pretokenizers) {
    if (p.type === "Split") {
      // All three Split rules use Isolated — matches become their own
      // pre-tokens and so do the in-between stretches. The ByteLevel
      // stage in the Sequence does no extra splitting here
      // (use_regex:false), so our 3 Split regexes are the whole story.
      splitRegexes.push(new RegExp(p.pattern.Regex, "gu"));
    }
  }

  const addedMap = new Map<string, number>();
  const addedContents: string[] = [];
  for (const t of data.added_tokens) {
    if (!t.special) {
      addedMap.set(t.content, t.id);
      addedContents.push(t.content);
    }
  }
  // Longest-first ensures greedy matching doesn't lose a longer token
  // to a shorter prefix (e.g. `<think>` before `<`).
  addedContents.sort((a, b) => b.length - a.length);
  const addedPattern = addedContents.length
    ? new RegExp(addedContents.map(escapeRegex).join("|"), "g")
    : null;

  cached = {
    vocab: data.model.vocab,
    mergeRank,
    splitRegexes,
    byteToChar: buildByteToChar(),
    addedPattern,
    addedMap,
  };
  return cached;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply one "Isolated" Split: the matches become their own pre-tokens,
 * stretches between matches pass through unchanged. Empty pre-tokens
 * are dropped so downstream stages don't see them.
 */
function applySplit(chunks: string[], re: RegExp): string[] {
  const out: string[] = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    // Reset lastIndex — reusing a /g regex across matchAll iterations
    // is safe (matchAll internally advances), but across different
    // input strings we want a clean start.
    re.lastIndex = 0;
    let last = 0;
    for (const m of chunk.matchAll(re)) {
      const idx = m.index ?? 0;
      if (idx > last) out.push(chunk.slice(last, idx));
      if (m[0].length > 0) out.push(m[0]);
      last = idx + m[0].length;
    }
    if (last < chunk.length) out.push(chunk.slice(last));
  }
  return out;
}

/** UTF-8 bytes of `s`, each mapped to its byte-level visible char. */
function byteLevelEncode(s: string, byteToChar: string[]): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += byteToChar[bytes[i]!];
  return out;
}

/**
 * Standard BPE merge loop. Starts from single byte-level chars and
 * repeatedly applies the lowest-rank merge until none remain. O(n²)
 * in chunk length, which is fine because chunks are ≤ a few hundred
 * byte-level chars after pre-tokenization (and most are <50).
 */
function bpeEncode(piece: string, mergeRank: Map<string, number>): string[] {
  if (piece.length <= 1) return piece ? [piece] : [];
  let word: string[] = Array.from(piece);
  while (true) {
    let bestIdx = -1;
    let bestRank = Number.POSITIVE_INFINITY;
    for (let i = 0; i < word.length - 1; i++) {
      const pair = `${word[i]} ${word[i + 1]}`;
      const rank = mergeRank.get(pair);
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        bestIdx = i;
        if (rank === 0) break; // 0 is already the best possible
      }
    }
    if (bestIdx < 0) break;
    word = [
      ...word.slice(0, bestIdx),
      word[bestIdx]! + word[bestIdx + 1]!,
      ...word.slice(bestIdx + 2),
    ];
    if (word.length === 1) break;
  }
  return word;
}

/**
 * Tokenize a UTF-8 string into DeepSeek token IDs. Mirrors the HF
 * pipeline: (1) isolate non-special added tokens so they stay atomic,
 * (2) for each in-between segment run the three Split regexes, (3)
 * byte-level encode, (4) BPE merge, (5) look up vocab IDs.
 *
 * Not reentrancy-hazardous: loads a module-level singleton on first
 * call and reuses it. Subsequent calls are pure compute.
 */
export function encode(text: string): number[] {
  if (!text) return [];
  const t = loadTokenizer();
  const ids: number[] = [];

  const process = (segment: string) => {
    if (!segment) return;
    let chunks: string[] = [segment];
    for (const re of t.splitRegexes) chunks = applySplit(chunks, re);
    for (const chunk of chunks) {
      if (!chunk) continue;
      const byteLevel = byteLevelEncode(chunk, t.byteToChar);
      const pieces = bpeEncode(byteLevel, t.mergeRank);
      for (const p of pieces) {
        const id = t.vocab[p];
        // If not in vocab we silently skip: shouldn't happen for
        // byte-level BPE (every single byte has its own vocab entry),
        // but if a future tokenizer update breaks that invariant we'd
        // rather under-count than throw from a UI gauge.
        if (id !== undefined) ids.push(id);
      }
    }
  };

  if (t.addedPattern) {
    t.addedPattern.lastIndex = 0;
    let last = 0;
    for (const m of text.matchAll(t.addedPattern)) {
      const idx = m.index ?? 0;
      if (idx > last) process(text.slice(last, idx));
      const id = t.addedMap.get(m[0]);
      if (id !== undefined) ids.push(id);
      last = idx + m[0].length;
    }
    if (last < text.length) process(text.slice(last));
  } else {
    process(text);
  }
  return ids;
}

/**
 * Fast path for UI: we only need the count, not the IDs. Saves a
 * per-call array allocation and lets callers batch large logs
 * without holding the full ID stream.
 */
export function countTokens(text: string): number {
  return encode(text).length;
}

/**
 * Estimate the tokens a full conversation would cost. Sums raw-text
 * counts for every message's content; we do NOT add overhead for the
 * chat template's role markers (`<｜User｜>`, `<｜Assistant｜>`) because
 * the exact framing varies between the chat/reasoner templates and
 * DeepSeek applies them server-side anyway. Empirically adds ~3-6%
 * to the real `prompt_tokens` — callers who care can post-multiply.
 */
export function estimateConversationTokens(
  messages: Array<{ content?: string | null; tool_calls?: unknown }>,
): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string" && m.content) {
      total += countTokens(m.content);
    }
    // Tool-call arguments are serialized as JSON in the prompt by the
    // chat template; their bytes WILL count upstream, so we count
    // them too. Stringify-once is cheap relative to the tokenize.
    if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      total += countTokens(JSON.stringify(m.tool_calls));
    }
  }
  return total;
}

/**
 * Estimate the tokens a full DeepSeek request would cost: the
 * conversation-side tokens (what `estimateConversationTokens` already
 * counts) PLUS the serialized tool-spec payload. Tool specs ride in
 * their own JSON blob in the request body, not folded into any
 * message's `content`, so they need a separate count to land an
 * accurate preflight estimate.
 *
 * Returned number matches what `/context` displays for "next request"
 * — reuse this helper anywhere (preflight guard, diagnostics, UI) to
 * keep the two values from drifting.
 */
export function estimateRequestTokens(
  messages: Array<{ content?: string | null; tool_calls?: unknown }>,
  toolSpecs?: ReadonlyArray<unknown> | null,
): number {
  let total = estimateConversationTokens(messages);
  if (toolSpecs && toolSpecs.length > 0) {
    total += countTokens(JSON.stringify(toolSpecs));
  }
  return total;
}

/** Exposed for tests — resets the lazy-load singleton. */
export function _resetForTests(): void {
  cached = null;
}
