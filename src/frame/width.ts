/**
 * Visual cell-width calculations for the Frame compiler.
 *
 * Delegates to the `string-width` npm package — same library Ink uses
 * internally — so app-side measurements match the Unicode East Asian
 * Width tables `string-width` ships, instead of a hand-rolled subset
 * that drifts on niche scripts. Grapheme segmentation stays on
 * `Intl.Segmenter` (built-in, no dep) so ZWJ emoji and combining-mark
 * sequences count as one cell.
 *
 * Why not roll our own: maintaining the wide/zero-width tables
 * in-tree means every Unicode rev (yearly) leaves us behind, and
 * any one-cell drift corrupts every Frame layout downstream
 * (right-edge pills, scrollbar alignment, log row truncation). The
 * lib bumps a version; we get the new tables for free.
 */

import stringWidthLib from "string-width";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Split a string into grapheme clusters. A grapheme is what humans
 * read as "one character" — `é` (1), `👨‍👩‍👧` (1 emoji), `한` (1 syllable).
 * We layout cell-by-cell using graphemes so combining marks stay
 * attached to their base and ZWJ-emoji don't get torn at wrap
 * boundaries.
 */
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (seg) => seg.segment);
}

/**
 * Visual cell width of one grapheme: 0 (zero-width / combining), 1
 * (narrow), or 2 (wide). Computed by asking `string-width` and
 * clamping into the {0,1,2} domain — anything wider than 2 collapses
 * to 2 (the Frame grid only knows narrow + wide cells).
 */
export function graphemeWidth(g: string): 0 | 1 | 2 {
  if (g.length === 0) return 0;
  const w = stringWidthLib(g);
  if (w <= 0) return 0;
  if (w >= 2) return 2;
  return 1;
}

/** Total visual width of a string. Direct passthrough to `string-width`. */
export function stringWidth(s: string): number {
  return stringWidthLib(s);
}
