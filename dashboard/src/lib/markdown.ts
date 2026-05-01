import hljs from "https://esm.sh/highlight.js@11.10.0/lib/common";
import { marked } from "https://esm.sh/marked@12.0.2";

export function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SEARCH_REPLACE_RE = /<{7}\s*SEARCH\s*\n([\s\S]*?)\n={7}\s*\n([\s\S]*?)\n>{7}\s*REPLACE/;

export function renderSearchReplace(search: string, replace: string, file: string): string {
  const safeSearch = typeof search === "string" ? search : String(search ?? "");
  const safeReplace = typeof replace === "string" ? replace : String(replace ?? "");
  const oldLines = safeSearch
    .split("\n")
    .map((l) => `<span class="diff-line del">- ${escapeHtml(l)}</span>`)
    .join("\n");
  const newLines = safeReplace
    .split("\n")
    .map((l) => `<span class="diff-line ins">+ ${escapeHtml(l)}</span>`)
    .join("\n");
  const header = file ? `<span class="diff-line hunk">▸ edit ${escapeHtml(file)}</span>\n` : "";
  return `<pre class="diff-block">${header}${oldLines}\n${newLines}</pre>`;
}

export function renderUnifiedDiff(text: string): string {
  const safe = typeof text === "string" ? text : String(text ?? "");
  const lines = safe
    .split("\n")
    .map((l) => {
      if (l.startsWith("+++") || l.startsWith("---")) {
        return `<span class="diff-line meta">${escapeHtml(l)}</span>`;
      }
      if (l.startsWith("+")) return `<span class="diff-line ins">${escapeHtml(l)}</span>`;
      if (l.startsWith("-")) return `<span class="diff-line del">${escapeHtml(l)}</span>`;
      if (l.startsWith("@@")) return `<span class="diff-line hunk">${escapeHtml(l)}</span>`;
      return escapeHtml(l);
    })
    .join("\n");
  return `<pre class="diff-block">${lines}</pre>`;
}

const renderer = new marked.Renderer();
renderer.code = function reasonixCode(arg1: unknown, arg2?: string): string {
  let text: unknown;
  let lang: string | undefined;
  if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1)) {
    text = (arg1 as { text?: unknown }).text;
    lang = (arg1 as { lang?: string }).lang;
  } else {
    text = arg1;
    lang = arg2;
  }
  if (text == null) text = "";
  const codeText: string = typeof text === "string" ? text : String(text);
  const sr = SEARCH_REPLACE_RE.exec(codeText);
  if (sr) {
    const [, search = "", replace = ""] = sr;
    const file = typeof lang === "string" && lang.startsWith("edit:") ? lang.slice(5) : "";
    return renderSearchReplace(search, replace, file);
  }
  if (lang === "diff") return renderUnifiedDiff(codeText);
  if (lang && typeof lang === "string" && hljs.getLanguage(lang)) {
    try {
      const h = hljs.highlight(codeText, { language: lang, ignoreIllegals: true }).value;
      return `<pre><code class="hljs language-${lang}">${h}</code></pre>`;
    } catch {
      /* fall through to auto */
    }
  }
  try {
    const auto = hljs.highlightAuto(codeText);
    return `<pre><code class="hljs">${auto.value}</code></pre>`;
  } catch {
    return `<pre><code>${escapeHtml(codeText)}</code></pre>`;
  }
};

marked.use({ renderer, gfm: true, breaks: false, pedantic: false });

export function renderMarkdownToString(text: string): string {
  return marked.parse(text) as string;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  xml: "xml",
  html: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  sql: "sql",
  vue: "xml",
  svelte: "xml",
  tex: "latex",
  proto: "protobuf",
  dockerfile: "dockerfile",
};

export function langFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const lower = path.toLowerCase();
  if (lower.endsWith("dockerfile")) return "dockerfile";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);
  return LANG_BY_EXT[ext] ?? null;
}

export function renderHighlightedBlock(text: string, lang: string | null | undefined): string {
  if (!text) return "";
  const safeLang = lang && hljs.getLanguage(lang) ? lang : null;
  try {
    const out = safeLang
      ? hljs.highlight(text, { language: safeLang, ignoreIllegals: true })
      : hljs.highlightAuto(text);
    return `<pre class="md"><code class="hljs ${safeLang ? `language-${safeLang}` : ""}">${out.value}</code></pre>`;
  } catch {
    return `<pre><code>${escapeHtml(text)}</code></pre>`;
  }
}

export function hlLine(text: string | null | undefined, lang: string | null | undefined): string {
  if (text == null) return "";
  if (text === "") return "";
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}
