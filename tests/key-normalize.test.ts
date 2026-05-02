/** CSI recovery boundary — every Ink keystroke runs through `recoverCsiTail`; regressions here re-break arrows / paste / Shift+Tab on Windows ConPTY. */

import { describe, expect, it } from "vitest";
import {
  STRIPPABLE_CSI_FRAGMENTS,
  recoverCsiTail,
  stripCsiFragments,
} from "../src/cli/ui/key-normalize.js";

describe("recoverCsiTail — ESC-stripped fallbacks (Windows ConPTY)", () => {
  it("recovers arrow keys from bare CSI tails", () => {
    expect(recoverCsiTail("[A")).toEqual({ upArrow: true });
    expect(recoverCsiTail("[B")).toEqual({ downArrow: true });
    expect(recoverCsiTail("[C")).toEqual({ rightArrow: true });
    expect(recoverCsiTail("[D")).toEqual({ leftArrow: true });
  });

  it("recovers page navigation tails", () => {
    expect(recoverCsiTail("[5~")).toEqual({ pageUp: true });
    expect(recoverCsiTail("[6~")).toEqual({ pageDown: true });
  });

  it("recovers forward-delete tail", () => {
    expect(recoverCsiTail("[3~")).toEqual({ delete: true });
  });

  it("recovers Shift+Tab tail", () => {
    expect(recoverCsiTail("[Z")).toEqual({ shift: true, tab: true });
  });
});

describe("recoverCsiTail — full CSI sequences (well-behaved terminals)", () => {
  it("also matches ESC-prefixed forms (in case parse-keypress merged them)", () => {
    expect(recoverCsiTail("\x1b[A")).toEqual({ upArrow: true });
    expect(recoverCsiTail("\x1b[5~")).toEqual({ pageUp: true });
    expect(recoverCsiTail("\x1b[Z")).toEqual({ shift: true, tab: true });
  });
});

describe("recoverCsiTail — pass-through cases", () => {
  it("returns null for unrelated input", () => {
    expect(recoverCsiTail("hello")).toBeNull();
    expect(recoverCsiTail("")).toBeNull();
    expect(recoverCsiTail("a")).toBeNull();
  });

  it("returns null for paste markers (handled separately by accumulator)", () => {
    expect(recoverCsiTail("[200~")).toBeNull();
    expect(recoverCsiTail("[201~")).toBeNull();
    expect(recoverCsiTail("\x1b[200~")).toBeNull();
  });

  it("returns null when Ink already populated a structured nav flag", () => {
    // Ink parsed `\x1b[A` correctly and set upArrow — don't second-guess
    // by also recovering from the raw `input` (the input would be ""
    // anyway in that case, but the guard is defence-in-depth).
    expect(recoverCsiTail("[A", { upArrow: true })).toBeNull();
    expect(recoverCsiTail("[C", { rightArrow: true })).toBeNull();
    expect(recoverCsiTail("[5~", { pageUp: true })).toBeNull();
  });

  it("returns null for already-structured Shift+Tab", () => {
    expect(recoverCsiTail("[Z", { shift: true, tab: true })).toBeNull();
  });

  it("plain `[` or `[A` substring within other text is NOT rewritten", () => {
    // The recover is exact-match on `input`. A user typing a Markdown
    // link `[A](url)` should not have it eaten as up-arrow.
    expect(recoverCsiTail("[A](url)")).toBeNull();
    expect(recoverCsiTail("[")).toBeNull();
    expect(recoverCsiTail("[ABC")).toBeNull();
  });
});

describe("stripCsiFragments", () => {
  it("removes paste markers (with and without ESC)", () => {
    expect(stripCsiFragments("\x1b[200~hello\x1b[201~")).toBe("hello");
    expect(stripCsiFragments("[200~hello[201~")).toBe("hello");
  });

  it("removes recognised arrow tails embedded in text", () => {
    // An arrow tail that somehow ended up inside a paste blob — this
    // can happen if the user pastes content immediately followed by
    // an arrow key on a slow terminal. We scrub them out so no
    // garbage text lands in the prompt buffer.
    expect(stripCsiFragments("hello[Aworld")).toBe("helloworld");
    expect(stripCsiFragments("a\x1b[5~b")).toBe("ab");
  });

  it("leaves non-fragment text alone", () => {
    expect(stripCsiFragments("hello world")).toBe("hello world");
    expect(stripCsiFragments("foo[](url)bar")).toBe("foo[](url)bar");
  });
});

describe("STRIPPABLE_CSI_FRAGMENTS", () => {
  it("includes both ESC-prefixed and bare forms of each tail", () => {
    // Sanity check: every bare form has its ESC-prefixed sibling.
    for (const frag of STRIPPABLE_CSI_FRAGMENTS) {
      if (frag.startsWith("[")) {
        expect(STRIPPABLE_CSI_FRAGMENTS).toContain(`\x1b${frag}`);
      }
    }
  });
});
