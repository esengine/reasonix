/** Markdown→Frame compiler reusing `parseBlocks` from markdown.tsx; tables / edit blocks / citations fall back to plain text. */

import {
  type Cell,
  type Frame,
  type TextOpts,
  borderLeft,
  empty,
  pad,
  stringWidth,
  text,
  vstack,
} from "../../frame/index.js";
import { type Block, parseBlocks } from "./markdown.js";
import { COLOR } from "./theme.js";

/** Mirrors `markdown.tsx` INLINE_RE — link/bold/italic/code/strike/escape. */
const INLINE_RE =
  /(\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|```([^\n]+?)```|`([^`\n]+?)`|~~([^~\n]+?)~~|(?<![*\w])\*([^*\n]+?)\*(?!\w)|\\([*_~`[\](){}#+\-.!\\]))/g;

interface InlineSegment {
  text: string;
  opts: Omit<TextOpts, "width">;
}

function parseInline(input: string, baseOpts: Omit<TextOpts, "width">): InlineSegment[] {
  const out: InlineSegment[] = [];
  let lastEnd = 0;
  // The regex is /g so we must reset lastIndex when reusing it.
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(input); m !== null; m = INLINE_RE.exec(input)) {
    if (m.index > lastEnd) {
      out.push({ text: input.slice(lastEnd, m.index), opts: baseOpts });
    }
    const linkText = m[2];
    const linkUrl = m[3];
    const boldItalic = m[4];
    const bold = m[5];
    const code3 = m[6];
    const code1 = m[7];
    const strike = m[8];
    const italic = m[9];
    const escapeChar = m[10];
    if (linkText !== undefined) {
      out.push({
        text: linkText,
        opts: { ...baseOpts, fg: COLOR.accent, underline: true, href: linkUrl },
      });
    } else if (boldItalic !== undefined) {
      out.push({ text: boldItalic, opts: { ...baseOpts, bold: true, italic: true } });
    } else if (bold !== undefined) {
      out.push({ text: bold, opts: { ...baseOpts, bold: true } });
    } else if (code3 !== undefined) {
      // Strip leading "lang " prefix (consistent with the legacy renderer)
      const stripped = code3.replace(/^(\w+)\s+/, "");
      out.push({ text: stripped, opts: { ...baseOpts, fg: "#67e8f9", bg: "#0f172a" } });
    } else if (code1 !== undefined) {
      out.push({ text: code1, opts: { ...baseOpts, fg: "#67e8f9", bg: "#0f172a" } });
    } else if (strike !== undefined) {
      out.push({ text: strike, opts: { ...baseOpts, dim: true } });
    } else if (italic !== undefined) {
      out.push({ text: italic, opts: { ...baseOpts, italic: true } });
    } else if (escapeChar !== undefined) {
      out.push({ text: escapeChar, opts: baseOpts });
    }
    lastEnd = m.index + m[0]!.length;
  }
  if (lastEnd < input.length) {
    out.push({ text: input.slice(lastEnd), opts: baseOpts });
  }
  return out;
}

/** Single wrap loop over flattened (cell, style) atoms — keeps wrap logic in one place across styles. */
function segmentsToFrame(segs: readonly InlineSegment[], width: number): Frame {
  if (width <= 0) return empty(0);
  // Build a flat list of "atoms" — each atom is one grapheme + its
  // style. We reuse Frame's text() to handle grapheme width / 2-wide
  // chars correctly: rendering each segment to a 1-row Frame at a
  // very wide budget gives back its cell array, which we splice
  // together for the wrap.
  const atoms: Cell[] = [];
  for (const seg of segs) {
    if (!seg.text) continue;
    // Render at the segment's exact visual width so text() adds no padding cells
    const f = text(seg.text, { ...seg.opts, width: stringWidth(seg.text) });
    if (f.rows.length > 0) {
      for (const c of f.rows[0]!) atoms.push(c);
    }
    // Multi-line segments (rare with inline markup, but possible if
    // text contained \n) — append blank cells then continue.
    for (let li = 1; li < f.rows.length; li++) {
      atoms.push({ char: "\n", width: 1 });
      for (const c of f.rows[li]!) atoms.push(c);
    }
  }
  // Greedy wrap: walk atoms, accumulate cells until current row width
  // would exceed `width` (skipping tail cells from the count); on a
  // newline atom, force a row break.
  const SPACE: Cell = { char: " ", width: 1 };
  const rows: Cell[][] = [];
  let cur: Cell[] = [];
  let curW = 0;
  let lastSpaceIdx = -1;
  const flushRow = (forceNewline = false): void => {
    while (curW < width) {
      cur.push(SPACE);
      curW += 1;
    }
    rows.push(cur);
    cur = [];
    curW = 0;
    lastSpaceIdx = -1;
    if (forceNewline) return;
  };
  for (const a of atoms) {
    if (a.char === "\n") {
      flushRow(true);
      continue;
    }
    const w = a.tail ? 0 : a.width;
    if (curW + w > width) {
      // Try to break at the last whitespace we saw — soft wrap.
      if (lastSpaceIdx >= 0 && lastSpaceIdx > 0) {
        // Cut the row at lastSpaceIdx; carry overflow atoms into the
        // next row.
        const overflow = cur.slice(lastSpaceIdx + 1);
        cur = cur.slice(0, lastSpaceIdx);
        let newW = 0;
        for (const c of cur) newW += c.tail ? 0 : c.width;
        // Pad current row to width
        while (newW < width) {
          cur.push(SPACE);
          newW += 1;
        }
        rows.push(cur);
        cur = overflow;
        curW = 0;
        for (const c of cur) curW += c.tail ? 0 : c.width;
        lastSpaceIdx = -1;
      } else {
        // No whitespace to break at — hard wrap.
        flushRow();
      }
    }
    if (a.char === " ") lastSpaceIdx = cur.length;
    cur.push(a);
    curW += w;
  }
  if (cur.length > 0 || rows.length === 0) {
    flushRow();
  }
  return { width, rows };
}

function paragraphFrame(p: { text: string }, width: number): Frame {
  const segs = parseInline(p.text, {});
  return segmentsToFrame(segs, width);
}

function headingFrame(h: { level: number; text: string }, width: number): Frame {
  const isMajor = h.level <= 3;
  const fg = isMajor ? COLOR.brand : COLOR.accent;
  const segs = parseInline(h.text, { bold: true, fg, dim: !isMajor });
  return vstack(segmentsToFrame(segs, width), text("", { width }));
}

/** Continuation lines align under the body, not under the bullet. */
function bulletListFrame(
  b: { items: { text: string; task?: "done" | "todo" }[]; ordered?: boolean },
  width: number,
): Frame {
  const rows: Frame[] = [];
  for (let i = 0; i < b.items.length; i++) {
    const item = b.items[i]!;
    let prefix: string;
    let prefixOpts: Omit<TextOpts, "width">;
    if (item.task === "done") {
      prefix = "[x] ";
      prefixOpts = { fg: COLOR.ok, bold: true };
    } else if (item.task === "todo") {
      prefix = "[ ] ";
      prefixOpts = { fg: COLOR.warn, bold: true };
    } else if (b.ordered) {
      prefix = `${i + 1}. `;
      prefixOpts = { fg: COLOR.info, bold: true };
    } else {
      prefix = "• ";
      prefixOpts = { fg: COLOR.info, bold: true };
    }
    const prefixWidth = prefix.length;
    const indentRow = " ".repeat(prefixWidth);
    const innerSegs = parseInline(item.text, {});
    const innerFrame = segmentsToFrame(innerSegs, Math.max(8, width - prefixWidth));
    // Decorate first line with prefix, subsequent lines with spaces.
    const decoratedRows: Frame[] = innerFrame.rows.map((r, li) => {
      const indent =
        li === 0
          ? text(prefix, { width: prefixWidth, ...prefixOpts })
          : text(indentRow, { width: prefixWidth });
      return {
        width: prefixWidth + innerFrame.width,
        rows: [[...indent.rows[0]!, ...r]],
      };
    });
    rows.push(...decoratedRows);
  }
  return vstack(...rows);
}

function codeBlockFrame(c: { lang: string; text: string }, width: number): Frame {
  const lines = c.text.split("\n");
  const rows: Frame[] = [];
  if (c.lang) {
    rows.push(text(c.lang, { width, fg: COLOR.info, dim: true, italic: true }));
  }
  for (const line of lines) {
    rows.push(text(line || " ", { width, fg: "#67e8f9", bg: "#0f172a" }));
  }
  return vstack(...rows);
}

function blockquoteFrame(bq: { children: Block[] }, width: number): Frame {
  const inner = bq.children.map((child) => blockToFrame(child, Math.max(8, width - 2)));
  const stacked = inner.length === 0 ? empty(Math.max(8, width - 2)) : vstack(...inner);
  return borderLeft(pad(stacked, 0, 0, 0, 1), COLOR.info);
}

function hrFrame(width: number): Frame {
  return text("─".repeat(width), { width, fg: COLOR.info, dim: true });
}

function blockToFrame(b: Block, width: number): Frame {
  switch (b.kind) {
    case "paragraph":
      return paragraphFrame(b, width);
    case "heading":
      return headingFrame(b, width);
    case "bullet":
      return bulletListFrame(b, width);
    case "code":
      return codeBlockFrame(b, width);
    case "quote":
      return blockquoteFrame(b, width);
    case "hr":
      return hrFrame(width);
    case "table":
      // Tables: render as plain-text rows for now; full table layout
      // is a future migration. Header gets bold, body rows dim.
      return vstack(
        text(b.header.join(" | "), { width, bold: true }),
        text(b.header.map(() => "─").join("─┼─"), { width, dim: true }),
        text(b.rows.map((r) => r.join(" | ")).join("\n"), { width, dim: true }),
      );
    case "edit-block":
      // Aider edit blocks: render filename + SEARCH/REPLACE summaries
      // as plain text. The full diff renderer lives in EditBlockRow
      // which we keep on the legacy Ink path until migration.
      return text(`${b.filename}\n<<< SEARCH\n${b.search}\n=======\n${b.replace}\n>>> REPLACE`, {
        width,
        dim: true,
      });
    default:
      // Unknown block kind — should never happen given the parser's
      // exhaustive Block union, but stay defensive.
      return empty(width);
  }
}

export function markdownToFrame(markdown: string, width: number): Frame {
  if (!markdown) return empty(width);
  const blocks = parseBlocks(markdown);
  if (blocks.length === 0) return empty(width);
  const frames: Frame[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    frames.push(blockToFrame(b, width));
    // Inter-block separator. Skip after blocks that already include
    // their own trailing spacer (headings) so we don't double-space.
    const isLast = i === blocks.length - 1;
    const carriesOwnSpacer = b.kind === "heading";
    if (!isLast && !carriesOwnSpacer) {
      frames.push(text("", { width }));
    }
  }
  return vstack(...frames);
}
