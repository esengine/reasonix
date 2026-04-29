/**
 * Alternate screen buffer lifecycle for the TUI.
 *
 * Reasonix used to render to the main terminal buffer — every
 * historical event scrolled past in the user's normal scrollback.
 * That had nice properties (copy/paste from history, exit-and-still-
 * see-it) but made sticky chrome impossible: the StatsPanel pinned
 * to the top of the live region was always at the bottom of the
 * viewport, just above the prompt.
 *
 * The redesign requires a real "viewport-style" layout: chrome at
 * row 1, scrollable log in the middle, prompt at the bottom. That
 * needs the alternate screen buffer (`\x1b[?1049h`), which:
 *
 *   · gives the app the entire terminal viewport to manage cell-by-cell
 *   · saves the user's previous terminal state, restores on exit
 *   · means session output is NOT in the user's scrollback after quit —
 *     the transcript file is the durable record (Reasonix already writes
 *     `~/.reasonix/sessions/<name>.jsonl` and optional `--transcript`)
 *
 * Trade-off accepted: lose post-exit scrollback access in exchange for
 * a real fixed header / scrollable middle / fixed footer layout.
 *
 * The escape sequences are the standard `xterm` private modes:
 *   `\x1b[?1049h` → switch to alt buffer + save cursor
 *   `\x1b[?1049l` → restore main buffer + cursor
 *   `\x1b[H`      → cursor to home (1,1) — start clean inside alt buffer
 *
 * Compatibility: every modern terminal (iTerm2, Windows Terminal,
 * WezTerm, gnome-terminal, kitty, alacritty, VS Code) supports 1049.
 * Plain `xterm` does too. Old conhost falls back to no-op (the codes
 * print as garbage characters, but that's a museum-piece risk).
 */

import { useEffect } from "react";

/** True iff stdout looks like a real TTY we should write escapes to. */
function isInteractiveTty(): boolean {
  return Boolean(process.stdout?.isTTY);
}

/** Module-level mirror of "is mouse tracking active right now?". Mutated
 *  by both `useAltScreen` (on mount) and `setMouseTracking` (slash command). */
let mouseTrackingOn = false;

/**
 * Enter the alt screen on mount, restore on unmount. Mouse tracking
 * is ON by default in basic-button mode (1000 + 1006 SGR coords) so
 * the wheel can drive the log scroll — the most-asked-for thing after
 * the alt-screen switch. We deliberately use mode 1000 (press/release
 * only) instead of 1002 (button + drag) so drag events DON'T go to
 * the app: every modern terminal (Windows Terminal, iTerm2, WezTerm,
 * gnome-terminal, kitty, alacritty, VS Code) lets the user hold
 * **Shift while dragging** to bypass mouse tracking entirely and do
 * native cell selection. So the user gets:
 *   · plain wheel        → in-app log scroll (the regression we're fixing)
 *   · shift + click+drag → native terminal selection (copy/paste)
 *   · `/mouse off`       → fully disable for terminals that don't bypass
 *
 * Restore is idempotent and runs on SIGINT / SIGTERM / exit, so the
 * user's terminal returns to a sane state regardless of how the
 * process dies.
 */
export function useAltScreen(): void {
  useEffect(() => {
    if (!isInteractiveTty()) return;
    // Enter alt buffer + clear + cursor home + basic mouse tracking
    // with SGR coordinates. Mode 1000 = press/release only (includes
    // wheel as buttons 64/65). 1006 = SGR-encoded coords. Together
    // they let us read the wheel without intercepting drag motion.
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h");
    mouseTrackingOn = true;

    // Belt-and-suspenders restore on every plausible exit path.
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      try {
        // Disable every mouse mode we might have turned on (1000 +
        // 1002 + 1006), then leave alt screen.
        process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l");
      } catch {
        /* terminal closed, nothing to do */
      }
    };

    process.once("exit", restore);
    process.once("SIGINT", () => {
      restore();
      // Re-emit so default exit-on-SIGINT can still fire.
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      restore();
      process.exit(143);
    });

    return restore;
  }, []);
}

/**
 * Runtime toggle for mouse-event tracking (basic button + wheel).
 * Invoked by the `/mouse on|off` slash command. ON by default in
 * basic-button mode 1000 — see {@link useAltScreen} for the rationale
 * (wheel works, drag still does native shift+drag selection).
 *
 * `/mouse off` is the escape hatch for terminals that don't honor
 * shift+drag bypass — flipping it off restores fully-native mouse
 * behavior at the cost of in-app wheel scrolling (PgUp/PgDn still
 * work).
 */
export function setMouseTracking(on: boolean): void {
  if (!isInteractiveTty()) return;
  if (on === mouseTrackingOn) return;
  if (on) {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
  } else {
    // Disable both 1000 and 1002 modes (we may have inherited the
    // older 1002 default from a long-running session) plus SGR.
    process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
  }
  mouseTrackingOn = on;
}
export function isMouseTrackingOn(): boolean {
  return mouseTrackingOn;
}
