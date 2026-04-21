/**
 * Minimal Markdown → Ink renderer for chat output.
 *
 * Handles the subset that actually shows up in LLM answers:
 *   - ATX headers (# ##)
 *   - Unordered / ordered lists
 *   - Fenced code blocks (```lang)
 *   - Inline **bold**, *italic*, `code`
 *   - Paragraphs separated by blank lines
 *   - LaTeX delimiters are stripped (\( \), \[ \], \boxed{X})
 *
 * The goal is not TeX-perfect math — it's "stop showing raw backslashes to
 * the user." When the model insists on LaTeX, we strip the scaffolding and
 * show the expression verbatim; terminals don't do math fonts anyway.
 */

import { Box, Text } from "ink";
import React from "react";

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  n: "ⁿ",
};
const SUBSCRIPT: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
};

function toSuperscript(s: string): string {
  let out = "";
  for (const c of s) out += SUPERSCRIPT[c] ?? c;
  return out;
}
function toSubscript(s: string): string {
  let out = "";
  for (const c of s) out += SUBSCRIPT[c] ?? c;
  return out;
}

export function stripMath(s: string): string {
  return (
    s
      // Delimiters
      .replace(/\\\(\s*/g, "")
      .replace(/\s*\\\)/g, "")
      .replace(/\\\[\s*/g, "\n")
      .replace(/\s*\\\]/g, "\n")
      // Fractions — \frac, \dfrac, \tfrac. Allow whitespace and one nesting
      // level inside braces (e.g. \frac{\sqrt{2}}{3}). Trim captured groups
      // so '\frac{ a }{ b }' renders as '(a)/(b)'.
      .replace(
        /\\[dt]?frac\s*\{((?:[^{}]|\{[^{}]*\})+)\}\s*\{((?:[^{}]|\{[^{}]*\})+)\}/g,
        (_m, num: string, den: string) => `(${num.trim()})/(${den.trim()})`,
      )
      .replace(
        /\\binom\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g,
        (_m, n: string, k: string) => `C(${n.trim()},${k.trim()})`,
      )
      .replace(/\\sqrt\s*\{([^{}]+)\}/g, (_m, g: string) => `√(${g.trim()})`)
      .replace(/\\boxed\s*\{([^{}]+)\}/g, (_m, g: string) => `【${g.trim()}】`)
      .replace(/\\text\s*\{([^{}]+)\}/g, (_m, g: string) => g.trim())
      .replace(/\\overline\s*\{([^{}]+)\}/g, (_m, g: string) => `${g.trim()}̄`)
      .replace(/\\hat\s*\{([^{}]+)\}/g, (_m, g: string) => `${g.trim()}̂`)
      .replace(/\\vec\s*\{([^{}]+)\}/g, (_m, g: string) => `→${g.trim()}`)
      // Operators & symbols
      .replace(/\\cdot/g, "·")
      .replace(/\\times/g, "×")
      .replace(/\\div/g, "÷")
      .replace(/\\pm/g, "±")
      .replace(/\\mp/g, "∓")
      .replace(/\\leq/g, "≤")
      .replace(/\\geq/g, "≥")
      .replace(/\\neq/g, "≠")
      .replace(/\\approx/g, "≈")
      .replace(/\\in\b/g, "∈")
      .replace(/\\notin\b/g, "∉")
      .replace(/\\infty/g, "∞")
      .replace(/\\sum\b/g, "Σ")
      .replace(/\\prod\b/g, "Π")
      .replace(/\\int\b/g, "∫")
      // Greek letters
      .replace(/\\alpha/g, "α")
      .replace(/\\beta/g, "β")
      .replace(/\\gamma/g, "γ")
      .replace(/\\delta/g, "δ")
      .replace(/\\theta/g, "θ")
      .replace(/\\lambda/g, "λ")
      .replace(/\\mu/g, "μ")
      .replace(/\\pi/g, "π")
      .replace(/\\sigma/g, "σ")
      .replace(/\\phi/g, "φ")
      .replace(/\\omega/g, "ω")
      // Arrows / logic
      .replace(/\\implies\b/g, "⇒")
      .replace(/\\iff\b/g, "⇔")
      .replace(/\\to\b/g, "→")
      .replace(/\\rightarrow/g, "→")
      .replace(/\\Rightarrow/g, "⇒")
      .replace(/\\leftarrow/g, "←")
      .replace(/\\Leftarrow/g, "⇐")
      .replace(/\\ldots/g, "…")
      .replace(/\\cdots/g, "⋯")
      // Spacing commands
      .replace(/\\quad/g, "  ")
      .replace(/\\qquad/g, "    ")
      .replace(/\\,/g, " ")
      .replace(/\\;/g, " ")
      .replace(/\\!/g, "")
      .replace(/\\\\/g, "\n")
      // Superscripts / subscripts — single token or {braced group of [\w+-]}
      .replace(/\^\{([\w+-]+)\}/g, (_m, g: string) => toSuperscript(g))
      .replace(/\^([0-9+\-n])/g, (_m, g: string) => toSuperscript(g))
      .replace(/_\{([\w+-]+)\}/g, (_m, g: string) => toSubscript(g))
      .replace(/_([0-9+\-])/g, (_m, g: string) => toSubscript(g))
      // Catch-all fallbacks for any LaTeX command we didn't explicitly handle.
      // Belt-and-braces: even if the model invents a new \weirdcommand{x}{y},
      // we'd rather show '(x)/(y)' or 'x' than a raw backslash.
      .replace(/\\[a-zA-Z]+\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "($1)/($2)")
      .replace(/\\[a-zA-Z]+\s*\{([^{}]+)\}/g, "$1")
      .replace(/\\[a-zA-Z]+/g, "")
      // Collapse multiple whitespace introduced by the stripping above.
      .replace(/[ \t]{2,}/g, " ")
  );
}

/** Split a single line into styled segments for bold / italic / inline code. */
const INLINE_RE = /(\*\*([^*\n]+?)\*\*|`([^`\n]+?)`|(?<![*\w])\*([^*\n]+?)\*(?!\w))/g;

function InlineMd({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let idx = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      parts.push(<Text key={`t${idx++}`}>{text.slice(last, start)}</Text>);
    }
    if (m[2] !== undefined) {
      parts.push(
        <Text key={`b${idx++}`} bold>
          {m[2]}
        </Text>,
      );
    } else if (m[3] !== undefined) {
      parts.push(
        <Text key={`c${idx++}`} color="yellow">
          {m[3]}
        </Text>,
      );
    } else if (m[4] !== undefined) {
      parts.push(
        <Text key={`i${idx++}`} italic>
          {m[4]}
        </Text>,
      );
    }
    last = start + m[0].length;
  }
  if (last < text.length) {
    parts.push(<Text key={`t${idx++}`}>{text.slice(last)}</Text>);
  }
  return <Text>{parts}</Text>;
}

interface ParagraphBlock {
  kind: "paragraph";
  text: string;
}
interface HeadingBlock {
  kind: "heading";
  level: number;
  text: string;
}
interface BulletBlock {
  kind: "bullet";
  items: string[];
  ordered: boolean;
  start: number;
}
interface CodeBlock {
  kind: "code";
  lang: string;
  text: string;
}
interface HrBlock {
  kind: "hr";
}

type Block = ParagraphBlock | HeadingBlock | BulletBlock | CodeBlock | HrBlock;

function parseBlocks(raw: string): Block[] {
  const lines = raw.split(/\r?\n/);
  const out: Block[] = [];
  let para: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listBuf: BulletBlock | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push({ kind: "paragraph", text: para.join(" ") });
      para = [];
    }
  };
  const flushList = () => {
    if (listBuf) {
      out.push(listBuf);
      listBuf = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");

    const fence = line.match(/^```(\w*)/);
    if (fence) {
      if (inCode) {
        out.push({ kind: "code", lang: codeLang, text: codeBuf.join("\n") });
        codeBuf = [];
        codeLang = "";
        inCode = false;
      } else {
        flushPara();
        flushList();
        inCode = true;
        codeLang = fence[1] ?? "";
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(rawLine);
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push({ kind: "hr" });
      continue;
    }

    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      flushPara();
      flushList();
      out.push({ kind: "heading", level: hm[1]!.length, text: hm[2]!.trim() });
      continue;
    }

    const bm = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bm) {
      flushPara();
      if (!listBuf || listBuf.ordered) {
        flushList();
        listBuf = { kind: "bullet", items: [], ordered: false, start: 1 };
      }
      listBuf.items.push(bm[1]!);
      continue;
    }

    const om = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (om) {
      flushPara();
      if (!listBuf || !listBuf.ordered) {
        flushList();
        listBuf = { kind: "bullet", items: [], ordered: true, start: Number(om[1]) };
      }
      listBuf.items.push(om[2]!);
      continue;
    }

    flushList();
    para.push(line);
  }

  if (inCode && codeBuf.length) {
    out.push({ kind: "code", lang: codeLang, text: codeBuf.join("\n") });
  }
  flushPara();
  flushList();
  return out;
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading":
      return (
        <Text bold color="cyan">
          <InlineMd text={block.text} />
        </Text>
      );
    case "paragraph":
      return <InlineMd text={block.text} />;
    case "bullet":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Box key={`${i}-${item.slice(0, 24)}`}>
              <Text color="cyan">{block.ordered ? ` ${block.start + i}. ` : "  • "}</Text>
              <InlineMd text={item} />
            </Box>
          ))}
        </Box>
      );
    case "code":
      return (
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color="yellow">{block.text}</Text>
        </Box>
      );
    case "hr":
      return <Text dimColor>{"────────────────────────"}</Text>;
  }
}

export function Markdown({ text }: { text: string }) {
  const cleaned = stripMath(text);
  const blocks = React.useMemo(() => parseBlocks(cleaned), [cleaned]);
  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((b, i) => (
        <BlockView key={`${i}-${b.kind}`} block={b} />
      ))}
    </Box>
  );
}
