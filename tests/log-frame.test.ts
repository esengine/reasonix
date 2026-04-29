import { describe, expect, it } from "vitest";
import type { DisplayEvent } from "../src/cli/ui/EventLog.js";
import { eventToAtom, viewportLog } from "../src/cli/ui/log-frame.js";
import { rowText } from "../src/frame/index.js";

const W = 80;

function infoEvent(text: string, id = "i"): DisplayEvent {
  return { id, role: "info", text };
}

function warnEvent(text: string, id = "w"): DisplayEvent {
  return { id, role: "warning", text };
}

function errorEvent(text: string, id = "e"): DisplayEvent {
  return { id, role: "error", text };
}

describe("eventToAtom — info", () => {
  it("produces a frame atom for a short info message", () => {
    const a = eventToAtom(infoEvent("▸ hello world"), undefined, W);
    expect(a.kind).toBe("frame");
    if (a.kind !== "frame") return;
    expect(a.frame.rows.length).toBe(1);
    expect(rowText(a.frame.rows[0]!)).toContain("▸");
    expect(rowText(a.frame.rows[0]!)).toContain("hello world");
  });
  it("wraps long info text across multiple rows", () => {
    const long = "x".repeat(200);
    const a = eventToAtom(infoEvent(long), undefined, W);
    expect(a.kind).toBe("frame");
    if (a.kind !== "frame") return;
    expect(a.frame.rows.length).toBeGreaterThan(2);
    // Every row has the same width (the Frame invariant).
    for (const r of a.frame.rows) {
      let visible = 0;
      for (const c of r) if (!c.tail) visible += c.width;
      expect(visible).toBe(a.frame.width);
    }
  });
  it("auto-tones glyph color (warn / ok / err)", () => {
    const okAtom = eventToAtom(infoEvent("✓ done"), undefined, W);
    const warnAtom = eventToAtom(infoEvent("▲ careful"), undefined, W);
    const errAtom = eventToAtom(infoEvent("✗ failed"), undefined, W);
    if (okAtom.kind !== "frame" || warnAtom.kind !== "frame" || errAtom.kind !== "frame") {
      throw new Error("expected frame atoms");
    }
    // Just verify the glyph cell carries different colors. The bar
    // (first cell) shares the glyph color.
    expect(okAtom.frame.rows[0]![0]!.fg).not.toBe(warnAtom.frame.rows[0]![0]!.fg);
    expect(warnAtom.frame.rows[0]![0]!.fg).not.toBe(errAtom.frame.rows[0]![0]!.fg);
  });
});

describe("eventToAtom — warning / error", () => {
  it("warning atom carries the warn glyph", () => {
    const a = eventToAtom(warnEvent("be careful"), undefined, W);
    expect(a.kind).toBe("frame");
    if (a.kind !== "frame") return;
    expect(rowText(a.frame.rows[0]!)).toContain("▲ warn");
  });
  it("error atom carries the err glyph", () => {
    const a = eventToAtom(errorEvent("oops"), undefined, W);
    expect(a.kind).toBe("frame");
    if (a.kind !== "frame") return;
    expect(rowText(a.frame.rows[0]!)).toContain("✦ error");
  });
});

describe("eventToAtom — fallback to ink", () => {
  it("user role falls back to ink atom with rows estimate", () => {
    const a = eventToAtom({ id: "u1", role: "user", text: "hi" }, undefined, W);
    expect(a.kind).toBe("ink");
    if (a.kind !== "ink") return;
    expect(a.rows).toBeGreaterThan(0);
  });
  it("plan role falls back to ink atom", () => {
    const a = eventToAtom({ id: "p1", role: "plan", text: "..." }, undefined, W);
    expect(a.kind).toBe("ink");
  });
  it("assistant with reasoning falls back to ink atom", () => {
    const a = eventToAtom(
      { id: "a1", role: "assistant", text: "hi", reasoning: "thinking..." },
      undefined,
      W,
    );
    expect(a.kind).toBe("ink");
  });
});

describe("viewportLog — basic slicing", () => {
  // Build 10 single-row info atoms = 10 cumulative rows total.
  const atoms = Array.from({ length: 10 }, (_, i) =>
    eventToAtom(infoEvent(`row${i}`, `i${i}`), undefined, W),
  );

  it("offset=0 returns the bottom of the stack", () => {
    const v = viewportLog(atoms, 0, 5);
    expect(v.atoms.length).toBe(5);
    // The last 5 atoms (index 5..9). Each is a 1-row frame.
    expect(v.totalRows).toBe(10);
    expect(v.maxScrollRows).toBe(5);
  });
  it("offset>0 reveals older rows", () => {
    const v = viewportLog(atoms, 3, 5);
    expect(v.atoms.length).toBe(5);
    // Should be atoms 2..6 (cumulative rows 2..7, viewport 2..7).
    if (v.atoms[0]!.kind !== "frame") throw new Error("expected frame");
    expect(rowText(v.atoms[0]!.frame.rows[0]!)).toContain("row2");
  });
  it("clamps offset past max", () => {
    const v = viewportLog(atoms, 999, 5);
    expect(v.atoms.length).toBe(5);
    if (v.atoms[0]!.kind !== "frame") throw new Error("expected frame");
    expect(rowText(v.atoms[0]!.frame.rows[0]!)).toContain("row0");
  });
  it("topSkip / bottomSkip = 0 when atoms align with viewport", () => {
    const v = viewportLog(atoms, 0, 5);
    expect(v.topSkip).toBe(0);
    expect(v.bottomSkip).toBe(0);
  });
});

describe("viewportLog — mixed frame + ink atoms", () => {
  it("snaps at ink atom boundaries (no row-precise topSkip)", () => {
    // 1-row info + 5-row ink + 1-row info = 7 rows
    const atoms = [
      eventToAtom(infoEvent("first", "i0"), undefined, W),
      eventToAtom({ id: "u0", role: "user", text: "x".repeat(100) }, undefined, W),
      eventToAtom(infoEvent("last", "i1"), undefined, W),
    ];
    // Viewport = 4 rows, offset = 0 → last 4 rows: tail of ink + last info
    const v = viewportLog(atoms, 0, 4);
    // First atom in slice should be the ink one (since viewport starts mid-ink)
    // but topSkip stays 0 because ink atoms don't support row-precise clip.
    expect(v.atoms[0]!.kind).toBe("ink");
    expect(v.topSkip).toBe(0); // ink atoms snap; no clip
  });
  it("frame atom at top supports row-precise topSkip", () => {
    // Single 10-row info (long text wrapped) → only 5 rows visible at offset=0
    const longInfo = eventToAtom(
      infoEvent(Array.from({ length: 10 }, () => "x".repeat(60)).join("\n")),
      undefined,
      W,
    );
    if (longInfo.kind !== "frame") throw new Error("expected frame");
    const total = longInfo.frame.rows.length;
    expect(total).toBeGreaterThan(5);
    const v = viewportLog([longInfo], 0, 5);
    expect(v.atoms.length).toBe(1);
    expect(v.topSkip).toBe(total - 5); // clip the top so bottom 5 rows show
    expect(v.bottomSkip).toBe(0);
  });
});

describe("viewportLog — clamping invariants", () => {
  it("non-empty atoms always produces at least one rendered atom", () => {
    const atoms = [eventToAtom(infoEvent("only"), undefined, W)];
    const v = viewportLog(atoms, 0, 5);
    expect(v.atoms.length).toBeGreaterThan(0);
  });
  it("totalRows == sum of atom heights", () => {
    const atoms = [
      eventToAtom(infoEvent("a"), undefined, W),
      eventToAtom(infoEvent("b"), undefined, W),
      eventToAtom(infoEvent("c"), undefined, W),
    ];
    const v = viewportLog(atoms, 0, 10);
    expect(v.totalRows).toBe(3);
  });
  it("maxScrollRows == max(0, totalRows - available)", () => {
    const atoms = Array.from({ length: 10 }, (_, i) =>
      eventToAtom(infoEvent(`r${i}`, `i${i}`), undefined, W),
    );
    expect(viewportLog(atoms, 0, 4).maxScrollRows).toBe(6);
    expect(viewportLog(atoms, 0, 100).maxScrollRows).toBe(0);
  });
});
