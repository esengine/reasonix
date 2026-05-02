import stringWidthLib from "string-width";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Grapheme split — keeps ZWJ emoji + combining marks intact. */
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (seg) => seg.segment);
}

/** Clamp into {0,1,2} — Frame grid only knows narrow + wide cells. */
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

/** Clip to `maxCells` visual cells; appends `…` if cut. Grapheme-safe. */
export function clipToCells(s: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  if (stringWidthLib(s) <= maxCells) return s;
  const cap = maxCells - 1;
  let out = "";
  let cells = 0;
  for (const g of graphemes(s)) {
    const w = graphemeWidth(g);
    if (cells + w > cap) break;
    out += g;
    cells += w;
  }
  return `${out}…`;
}

/** Wrap to `maxCells`-wide chunks for tail-window semantics — caller can `slice(-N)` to pull true visual last lines. Empty input yields one empty chunk so paragraph breaks survive the round-trip. */
export function wrapToCells(s: string, maxCells: number): string[] {
  if (maxCells <= 0) return [];
  if (s.length === 0) return [""];
  const out: string[] = [];
  let cur = "";
  let cells = 0;
  for (const g of graphemes(s)) {
    const w = graphemeWidth(g);
    if (cells + w > maxCells) {
      out.push(cur);
      cur = g;
      cells = w;
    } else {
      cur += g;
      cells += w;
    }
  }
  if (cur.length > 0 || out.length === 0) out.push(cur);
  return out;
}
