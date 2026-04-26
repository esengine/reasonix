/**
 * Raw stdin reader with our own CSI parser.
 *
 * Replaces Ink's `useInput` chain (which uses `parse-keypress` with a
 * 100 ms intra-sequence timeout that's too short for Windows ConPTY).
 * That timeout was the root cause of every keyboard regression we
 * shipped a patch for in 0.7.x — paste markers leaking into the
 * buffer, arrow keys not crossing newlines, Shift+Tab silently failing.
 *
 * Design:
 *   - One reader owns `process.stdin`. We call `setRawMode(true)`,
 *     register a single `data` listener, and emit parsed `KeyEvent`s
 *     to subscribers. As long as no `useInput` is called inside the
 *     Ink tree, Ink itself never attaches its own listener — we're
 *     the sole consumer of stdin.
 *
 *   - The state machine is tiny: idle → esc → csi/ss3 → idle, plus a
 *     `paste` accumulator that swallows everything between `\x1b[200~`
 *     and `\x1b[201~`. ESC ambiguity (standalone Esc vs. start of a
 *     CSI) is resolved by a 250 ms timer — much longer than parse-
 *     keypress's 100 ms, so ConPTY-split sequences land in the
 *     correct branch.
 *
 *   - We also recognise the ESC-stripped variants (`[A`, `[200~`) at
 *     idle-state lookahead, in case ConPTY consumed the leading ESC
 *     before we even saw it. That used to be a recovery layer in
 *     `key-normalize.ts`; with this reader as the sole input source
 *     it folds into the parser proper.
 *
 *   - `paste` events carry the full content so the consumer can route
 *     it through paste-sentinel registration without re-parsing.
 */

import { stdin } from "node:process";

/**
 * Single keystroke event. Shape mirrors Ink's `(input, key)` callback
 * pair for migration ergonomics — consumers reading `key.upArrow`
 * etc. can keep doing so. `paste` is the one new field; consumers
 * that care about pastes (PromptInput) check it explicitly.
 */
export interface KeyEvent {
  /**
   * Printable character(s). Non-empty for normal typing, Ctrl+letter
   * (the letter goes here with `ctrl:true`), Alt+letter (with
   * `meta:true`), and bracketed paste content (with `paste:true`).
   * Always empty for control keystrokes like arrows / Enter / Esc.
   */
  input: string;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  delete?: boolean;
  backspace?: boolean;
  tab?: boolean;
  return?: boolean;
  escape?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  /**
   * True iff this event delivers bracketed-paste content. `input`
   * holds the entire paste; consumers MUST NOT re-interpret it as
   * keystrokes (e.g. a `\n` in a paste shouldn't fire submit).
   */
  paste?: boolean;
}

type Subscriber = (ev: KeyEvent) => void;

/** ESC ambiguity timeout. Long enough for ConPTY-split sequences. */
const ESC_TIMEOUT_MS = 250;

/** Bracketed-paste markers (DECSET 2004). */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** ESC-stripped variants — ConPTY occasionally eats the leading ESC. */
const PASTE_START_BARE = "[200~";
const PASTE_END_BARE = "[201~";

/**
 * CSI tails (the bytes that follow `\x1b[`) we recognise and the
 * structured event each produces. Order doesn't matter — lookups
 * are exact-match.
 */
const CSI_TAIL_MAP: ReadonlyArray<{ tail: string; ev: KeyEvent }> = [
  { tail: "A", ev: { input: "", upArrow: true } },
  { tail: "B", ev: { input: "", downArrow: true } },
  { tail: "C", ev: { input: "", rightArrow: true } },
  { tail: "D", ev: { input: "", leftArrow: true } },
  { tail: "H", ev: { input: "", home: true } },
  { tail: "F", ev: { input: "", end: true } },
  { tail: "1~", ev: { input: "", home: true } },
  { tail: "4~", ev: { input: "", end: true } },
  { tail: "5~", ev: { input: "", pageUp: true } },
  { tail: "6~", ev: { input: "", pageDown: true } },
  { tail: "3~", ev: { input: "", delete: true } },
  { tail: "Z", ev: { input: "", shift: true, tab: true } },
  // modifyOtherKeys (xterm CSI > 4 ; 2 m) sequences for Enter with
  // modifiers. Only fired when App.tsx has enabled the mode at
  // startup; otherwise Shift+Enter stays indistinguishable from Enter.
  // Modifier encoding: 2=shift, 3=alt, 4=alt+shift, 5=ctrl,
  // 6=ctrl+shift, 7=ctrl+alt, 8=ctrl+alt+shift. Keycode 13 = Enter.
  { tail: "27;2;13~", ev: { input: "", return: true, shift: true } },
  { tail: "27;5;13~", ev: { input: "", return: true, ctrl: true } },
  { tail: "27;6;13~", ev: { input: "", return: true, ctrl: true, shift: true } },
  // Kitty keyboard protocol — same idea, different envelope:
  // `\x1b[<keycode>;<mod>u`. Some terminals (kitty, recent Windows
  // Terminal previews) prefer this shape. Harmless to map here too.
  { tail: "13;2u", ev: { input: "", return: true, shift: true } },
  { tail: "13;5u", ev: { input: "", return: true, ctrl: true } },
  { tail: "13;6u", ev: { input: "", return: true, ctrl: true, shift: true } },
];

/** SS3 sequences (`\x1bO<letter>`) — some terminals send these for arrows. */
const SS3_MAP: Record<string, KeyEvent> = {
  A: { input: "", upArrow: true },
  B: { input: "", downArrow: true },
  C: { input: "", rightArrow: true },
  D: { input: "", leftArrow: true },
  H: { input: "", home: true },
  F: { input: "", end: true },
};

/**
 * Lookahead matcher for ESC-stripped sequences. When `chunk[i]` is
 * `[`, we check the bytes immediately after to see if they form a
 * recognised CSI tail. If so we emit the structured event and tell
 * the caller how many bytes to consume. Returns `null` when no
 * recognised tail starts here.
 */
function tryEscapelessCsi(chunk: string, i: number): { advance: number; ev: KeyEvent } | null {
  if (chunk[i] !== "[") return null;
  // Paste start as a special case (handled by caller).
  // Try each known tail.
  for (const entry of CSI_TAIL_MAP) {
    const candidate = `[${entry.tail}`;
    if (chunk.slice(i, i + candidate.length) === candidate) {
      return { advance: candidate.length, ev: entry.ev };
    }
  }
  return null;
}

/**
 * Final byte of a CSI sequence is in the range `0x40` (`@`) –
 * `0x7E` (`~`). Anything else is a parameter / intermediate byte.
 */
function isCsiFinal(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Look up the CSI event for a fully-assembled sequence (without the
 * leading `\x1b[`). Returns `null` if we don't recognise it — which
 * is fine, we just drop the bytes silently rather than insert them
 * into the buffer as garbage text.
 */
function lookupCsi(tail: string): KeyEvent | null {
  for (const entry of CSI_TAIL_MAP) {
    if (entry.tail === tail) return entry.ev;
  }
  return null;
}

export class StdinReader {
  private subscribers = new Set<Subscriber>();
  private state: "idle" | "esc" | "csi" | "ss3" | "paste" = "idle";
  /** Buffer for partial sequences across chunks. */
  private csiBuf = "";
  /** Buffer for paste content. */
  private pasteBuf = "";
  private escTimer: NodeJS.Timeout | null = null;
  private started = false;
  /** The actual `data` listener — kept as a field so `stop()` can detach it. */
  private listener: ((chunk: Buffer | string) => void) | null = null;

  start(): void {
    if (this.started) return;
    if (!stdin.isTTY) {
      // Non-TTY (piped input). We can't run interactively — don't try.
      return;
    }
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    this.listener = (chunk) =>
      this.handleChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    stdin.on("data", this.listener);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    if (this.listener) {
      stdin.off("data", this.listener);
      this.listener = null;
    }
    if (stdin.isTTY) {
      try {
        stdin.setRawMode(false);
      } catch {
        // setRawMode may throw if stdin is already closed; ignore.
      }
    }
    stdin.pause();
    this.cancelEscTimer();
    this.state = "idle";
    this.csiBuf = "";
    this.pasteBuf = "";
    this.started = false;
  }

  /**
   * Subscribe to parsed key events. Returns an unsubscribe function.
   * Multiple subscribers are supported — every event fans out to all
   * of them; the React Context layer above uses one subscriber and
   * dispatches further to its own consumer list.
   */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * Inject a chunk of bytes as if it came from stdin. Used by tests
   * to drive the parser without a real TTY.
   */
  feed(chunk: string): void {
    this.handleChunk(chunk);
  }

  private dispatch(ev: KeyEvent): void {
    for (const sub of this.subscribers) sub(ev);
  }

  private cancelEscTimer(): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  private scheduleEscTimer(): void {
    this.cancelEscTimer();
    this.escTimer = setTimeout(() => {
      // Standalone Esc — no follow-up byte arrived in time.
      if (this.state === "esc") {
        this.state = "idle";
        this.dispatch({ input: "", escape: true });
      }
    }, ESC_TIMEOUT_MS);
  }

  private handleChunk(chunk: string): void {
    this.cancelEscTimer();
    let i = 0;
    while (i < chunk.length) {
      // ── paste accumulator ──
      if (this.state === "paste") {
        // Look for end marker (with or without ESC).
        const endA = chunk.indexOf(PASTE_END, i);
        const endB = chunk.indexOf(PASTE_END_BARE, i);
        let endIdx = -1;
        let endLen = 0;
        if (endA !== -1 && (endB === -1 || endA <= endB)) {
          endIdx = endA;
          endLen = PASTE_END.length;
        } else if (endB !== -1) {
          endIdx = endB;
          endLen = PASTE_END_BARE.length;
        }
        if (endIdx === -1) {
          this.pasteBuf += chunk.slice(i);
          i = chunk.length;
          break;
        }
        this.pasteBuf += chunk.slice(i, endIdx);
        this.dispatch({ input: this.pasteBuf, paste: true });
        this.pasteBuf = "";
        this.state = "idle";
        i = endIdx + endLen;
        continue;
      }

      // ── CSI accumulator ──
      if (this.state === "csi") {
        const ch = chunk[i]!;
        this.csiBuf += ch;
        if (isCsiFinal(ch)) {
          this.dispatchCsi(this.csiBuf);
          this.csiBuf = "";
          // Only reset state if `dispatchCsi` didn't already mutate it
          // (it transitions to `paste` for the `200~` start marker —
          // resetting here would clobber that and the paste content
          // would be parsed as keystrokes).
          if (this.state === "csi") this.state = "idle";
        }
        i++;
        continue;
      }

      // ── SS3 single-byte tail ──
      if (this.state === "ss3") {
        const ev = SS3_MAP[chunk[i]!];
        if (ev) this.dispatch(ev);
        this.state = "idle";
        i++;
        continue;
      }

      // ── ESC pending ──
      if (this.state === "esc") {
        const ch = chunk[i]!;
        if (ch === "[") {
          this.state = "csi";
          this.csiBuf = "";
          i++;
          continue;
        }
        if (ch === "O") {
          this.state = "ss3";
          i++;
          continue;
        }
        // ESC + any other char = Alt+key (rare; we still dispatch).
        this.dispatch({ input: ch, meta: true });
        this.state = "idle";
        i++;
        continue;
      }

      // ── idle ──
      const ch = chunk[i]!;

      if (ch === "\x1b") {
        this.state = "esc";
        i++;
        continue;
      }

      // ESC-stripped paste-start (ConPTY): bare `[200~` at idle.
      if (chunk.slice(i, i + PASTE_START_BARE.length) === PASTE_START_BARE) {
        this.state = "paste";
        this.pasteBuf = "";
        i += PASTE_START_BARE.length;
        continue;
      }
      // ESC-stripped CSI tails — recover before treating `[` as text.
      const escapeless = tryEscapelessCsi(chunk, i);
      if (escapeless) {
        this.dispatch(escapeless.ev);
        i += escapeless.advance;
        continue;
      }

      // Single-byte control keys.
      // \r (CR, 0x0D) is Enter on every terminal in raw mode.
      // \n (LF, 0x0A) is what Ctrl+J emits — keep it distinct so the
      // multiline reducer can map it to "insert newline" instead of
      // "submit". Pastes containing \n still arrive via either the
      // bracketed-paste accumulator or a multi-byte printable chunk
      // that includes the newline; neither hits this single-byte
      // branch, so this split is safe.
      if (ch === "\r") {
        this.dispatch({ input: "", return: true });
        i++;
        continue;
      }
      if (ch === "\n") {
        this.dispatch({ input: "j", ctrl: true });
        i++;
        continue;
      }
      if (ch === "\t") {
        this.dispatch({ input: "", tab: true });
        i++;
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        this.dispatch({ input: "", backspace: true });
        i++;
        continue;
      }
      if (ch === "\x03") {
        // Ctrl+C — terminate the process. Raw mode disables the
        // default SIGINT, so we have to handle it ourselves.
        this.dispatch({ input: "c", ctrl: true });
        i++;
        continue;
      }

      const code = ch.charCodeAt(0);
      // Other Ctrl+letter (0x01-0x1A → A-Z, except already-handled).
      if (code >= 1 && code <= 26) {
        const letter = String.fromCharCode(0x60 + code); // a..z
        this.dispatch({ input: letter, ctrl: true });
        i++;
        continue;
      }

      // Regular printable input. Coalesce a run of printable chars
      // into one event so a multi-byte UTF-8 paste-burst arrives as
      // one `input` rather than N adjacent events.
      let end = i + 1;
      while (end < chunk.length) {
        const c = chunk[end]!;
        if (c === "\x1b" || c === "\r" || c === "\n" || c === "\t") break;
        if (c === "\x7f" || c === "\b" || c === "\x03") break;
        const cc = c.charCodeAt(0);
        if (cc >= 1 && cc <= 26) break;
        // Don't swallow into a printable run if a CSI / paste prefix
        // starts at this position.
        if (c === "[" && tryEscapelessCsi(chunk, end)) break;
        if (chunk.slice(end, end + PASTE_START_BARE.length) === PASTE_START_BARE) break;
        end++;
      }
      this.dispatch({ input: chunk.slice(i, end) });
      i = end;
    }

    // After processing, if we're still in `esc` state, schedule the
    // ambiguity timer. The next chunk may carry the rest of the CSI;
    // if not, the timer fires and dispatches a standalone Esc.
    if (this.state === "esc") {
      this.scheduleEscTimer();
    }
  }

  private dispatchCsi(seq: string): void {
    // seq is the bytes after `\x1b[`, e.g. "A", "5~", "200~", "Z".
    if (seq === "200~") {
      this.state = "paste";
      this.pasteBuf = "";
      return;
    }
    if (seq === "201~") {
      // Stray paste-end — we shouldn't reach here outside paste mode,
      // but if we do, drop it silently.
      return;
    }
    const ev = lookupCsi(seq);
    if (ev) this.dispatch(ev);
    // Unknown CSI → drop. Do NOT insert raw bytes as text.
  }
}

/** Singleton — one reader per process. */
let singleton: StdinReader | null = null;

export function getStdinReader(): StdinReader {
  if (!singleton) singleton = new StdinReader();
  return singleton;
}
