/**
 * Built-in web search + fetch tools.
 *
 *   - `web_search(query, topK?)` — Mojeek's public search page. No API
 *     key, no signup. We originally shipped this backed by DuckDuckGo's
 *     HTML endpoint, but DDG started serving anti-bot interstitials
 *     (HTTP 202 with a challenge page) for every unauthenticated POST.
 *     Mojeek runs its own independent index, is bot-friendly, and
 *     returns parseable HTML.
 *   - `web_fetch(url)` — HTTP GET + naïve HTML-to-text extraction.
 *
 * Both are registered by default on `reasonix chat` / `reasonix code`;
 * set `search: false` in config (or `REASONIX_SEARCH=off`) to turn
 * them off. The model decides when to call them based on the query —
 * no slash command required.
 */

import type { ToolRegistry } from "../tools.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PageContent {
  url: string;
  title?: string;
  text: string;
  /** True when the extracted text was clipped to fit the cap. */
  truncated: boolean;
}

export interface WebFetchOptions {
  /** Max bytes of extracted text. Defaults to 32_000 to match tool-result cap. */
  maxChars?: number;
  /** Timeout in ms. Defaults to 15_000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WebSearchOptions {
  topK?: number;
  signal?: AbortSignal;
}

const DEFAULT_FETCH_MAX_CHARS = 32_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_TOPK = 5;
// Real-browser UA. Servers like Mojeek are bot-friendly but still gate
// obvious scraper UAs; a stock Chrome string avoids the fast-path block.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MOJEEK_ENDPOINT = "https://www.mojeek.com/search";

/**
 * Search the public web via Mojeek. Returns up to `topK` ranked
 * results with title, url, snippet.
 *
 * Mojeek is an independent index (not a Google/Bing front-end) which
 * means coverage on niche or very recent topics can be thinner, but
 * it's reliable from scripts and doesn't gate on cookies or sessions.
 * If the response has 0 results we distinguish "truly empty" from
 * "layout changed or blocked" so the caller isn't left guessing.
 */
export async function webSearch(
  query: string,
  opts: WebSearchOptions = {},
): Promise<SearchResult[]> {
  const topK = Math.max(1, Math.min(10, opts.topK ?? DEFAULT_TOPK));
  const resp = await fetch(`${MOJEEK_ENDPOINT}?q=${encodeURIComponent(query)}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: opts.signal,
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`web_search ${resp.status}`);
  const html = await resp.text();
  const results = parseMojeekResults(html).slice(0, topK);
  if (results.length === 0) {
    if (/no results found|did not match any documents/i.test(html)) return [];
    if (/captcha|verify you are human|access denied|forbidden/i.test(html)) {
      throw new Error("web_search: Mojeek anti-bot page — rate-limited or blocked");
    }
    throw new Error(
      `web_search: 0 results but response doesn't look like a real empty page (${html.length} chars, first 120: ${html.slice(0, 120).replace(/\s+/g, " ")})`,
    );
  }
  return results;
}

/**
 * Extract results from a Mojeek search page.
 *
 * Mojeek's stable shape (as of April 2026):
 *   <a … class="ob" href="URL"> … breadcrumb … </a>
 *   <h2><a class="title" href="URL">Title</a></h2>
 *   <p class="s">snippet text …</p>
 *
 * We do two tolerant passes — title anchors, then snippet paragraphs —
 * and pair them positionally. Attribute order inside a tag varies
 * between versions, so each pass captures the whole element and we
 * re-extract href / inner text with a second regex. Exported for
 * unit testing against a fixture.
 */
export function parseMojeekResults(html: string): SearchResult[] {
  const titles: string[] = [];
  const titleAnchorRe = /<a\b[^>]*\bclass="title"[^>]*>[\s\S]*?<\/a>/g;
  let m: RegExpExecArray | null;
  while (true) {
    m = titleAnchorRe.exec(html);
    if (m === null) break;
    titles.push(m[0]);
  }

  const snippets: string[] = [];
  const snippetRe = /<p\b[^>]*\bclass="s"[^>]*>([\s\S]*?)<\/p>/g;
  while (true) {
    m = snippetRe.exec(html);
    if (m === null) break;
    snippets.push(m[1] ?? "");
  }

  const hrefRe = /href="([^"]+)"/;
  const innerRe = /<a\b[^>]*>([\s\S]*?)<\/a>/;
  const results: SearchResult[] = [];
  for (let i = 0; i < titles.length; i++) {
    const anchor = titles[i]!;
    const hrefMatch = anchor.match(hrefRe);
    const innerMatch = anchor.match(innerRe);
    if (!hrefMatch?.[1]) continue;
    results.push({
      title: decodeHtmlEntities(stripHtml(innerMatch?.[1] ?? "")).trim(),
      url: hrefMatch[1],
      snippet: decodeHtmlEntities(stripHtml(snippets[i] ?? ""))
        .replace(/\s+/g, " ")
        .trim(),
    });
  }
  return results;
}

/**
 * Download a URL, strip HTML down to readable text, return it. Times
 * out at 15s, caps extracted text at 32k chars to fit the tool-result
 * budget.
 */
export async function webFetch(url: string, opts: WebFetchOptions = {}): Promise<PageContent> {
  const maxChars = opts.maxChars ?? DEFAULT_FETCH_MAX_CHARS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  // Forward the caller's abort too so an Esc during a long fetch is respected.
  const cancel = () => ctl.abort();
  opts.signal?.addEventListener("abort", cancel, { once: true });
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,*/*" },
      signal: ctl.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", cancel);
  }
  if (!resp.ok) throw new Error(`web_fetch ${resp.status} for ${url}`);
  const contentType = resp.headers.get("content-type") ?? "";
  const raw = await resp.text();
  const title = extractTitle(raw);
  const text = contentType.includes("text/html") ? htmlToText(raw) : raw;
  const truncated = text.length > maxChars;
  const finalText = truncated
    ? `${text.slice(0, maxChars)}\n\n[… truncated ${text.length - maxChars} chars …]`
    : text;
  return { url, title, text: finalText, truncated };
}

/**
 * Strip HTML to readable text. Removes scripts/styles/nav/footer/aside
 * blocks first, then tags, then collapses whitespace. Not a Readability
 * clone — purpose-built to keep the extracted text small enough for the
 * tool-result budget while preserving paragraph breaks.
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  s = s.replace(/<aside[\s\S]*?<\/aside>/gi, "");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  // Preserve paragraph breaks by turning common block tags into newlines.
  s = s.replace(/<\/?(p|div|br|h[1-6]|li|tr|section|article)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return undefined;
  return m[1].replace(/\s+/g, " ").trim() || undefined;
}

export interface WebToolsOptions {
  /** Default top-K for `web_search` when the model doesn't specify. */
  defaultTopK?: number;
  /** Byte cap for `web_fetch` extracted text. */
  maxFetchChars?: number;
}

/**
 * Register `web_search` + `web_fetch` on a ToolRegistry. The model
 * invokes them automatically when a question needs current info —
 * no slash command from the user is required.
 */
export function registerWebTools(registry: ToolRegistry, opts: WebToolsOptions = {}): ToolRegistry {
  const defaultTopK = opts.defaultTopK ?? DEFAULT_TOPK;
  const maxFetchChars = opts.maxFetchChars ?? DEFAULT_FETCH_MAX_CHARS;

  registry.register({
    name: "web_search",
    description:
      "Search the public web. Returns ranked results with title, url, and snippet. Use this when the question needs information more current than your training data, when you're unsure of a factual detail, or when the user asks about a specific webpage/library/release you haven't seen.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        topK: {
          type: "integer",
          description: `Number of results to return (1..10). Default ${defaultTopK}.`,
        },
      },
      required: ["query"],
    },
    fn: async (args: { query: string; topK?: number }, ctx) => {
      const results = await webSearch(args.query, {
        topK: args.topK ?? defaultTopK,
        signal: ctx?.signal,
      });
      return formatSearchResults(args.query, results);
    },
  });

  registry.register({
    name: "web_fetch",
    description:
      "Download a URL and return its visible text content (HTML pages get scripts/styles/nav stripped). Truncated at the tool-result cap. Use after web_search when a snippet isn't enough.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http:// or https:// URL." },
      },
      required: ["url"],
    },
    fn: async (args: { url: string }, ctx) => {
      if (!/^https?:\/\//i.test(args.url)) {
        throw new Error("web_fetch: url must start with http:// or https://");
      }
      const page = await webFetch(args.url, { maxChars: maxFetchChars, signal: ctx?.signal });
      const header = page.title ? `${page.title}\n${page.url}` : page.url;
      return `${header}\n\n${page.text}`;
    },
  });

  return registry;
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  const lines: string[] = [`query: ${query}`, `\nresults (${results.length}):`];
  results.forEach((r, i) => {
    lines.push(`\n${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  return lines.join("\n");
}
