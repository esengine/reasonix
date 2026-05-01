import { describe, expect, it, vi } from "vitest";
import { fmtBytes, fmtNum, fmtPct, fmtRelativeTime, fmtUsd } from "../dashboard/src/lib/format.js";

describe("fmtUsd", () => {
  it("returns em-dash for null/undefined", () => {
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(undefined)).toBe("—");
  });

  it("returns $0 for zero", () => {
    expect(fmtUsd(0)).toBe("$0");
  });

  it("uses 4 decimals for >= 0.01", () => {
    expect(fmtUsd(0.01)).toBe("$0.0100");
    expect(fmtUsd(1.234567)).toBe("$1.2346");
  });

  it("uses 6 decimals for < 0.01 to keep micro-costs visible", () => {
    expect(fmtUsd(0.001234)).toBe("$0.001234");
    expect(fmtUsd(0.000001)).toBe("$0.000001");
  });
});

describe("fmtPct", () => {
  it("returns em-dash for null/undefined", () => {
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(undefined)).toBe("—");
  });

  it("multiplies by 100 with 1 decimal", () => {
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(0.945)).toBe("94.5%");
    expect(fmtPct(1)).toBe("100.0%");
  });
});

describe("fmtNum", () => {
  it("returns em-dash for null/undefined", () => {
    expect(fmtNum(null)).toBe("—");
    expect(fmtNum(undefined)).toBe("—");
  });

  it("uses locale separators", () => {
    expect(fmtNum(0)).toBe("0");
    expect(fmtNum(1234567)).toBe(Number(1234567).toLocaleString());
  });
});

describe("fmtBytes", () => {
  it("returns em-dash for null/undefined", () => {
    expect(fmtBytes(null)).toBe("—");
    expect(fmtBytes(undefined)).toBe("—");
  });

  it("uses bytes under 1 KiB", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1023)).toBe("1023 B");
  });

  it("uses KB for 1 KiB to under 1 MiB", () => {
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
  });

  it("uses MB for 1 MiB to under 1 GiB", () => {
    expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
    expect(fmtBytes(1024 * 1024 * 5.5)).toBe("5.5 MB");
  });

  it("uses GB for 1 GiB and above", () => {
    expect(fmtBytes(1024 ** 3)).toBe("1.00 GB");
    expect(fmtBytes(1024 ** 3 * 2.5)).toBe("2.50 GB");
  });
});

describe("fmtRelativeTime", () => {
  it("returns em-dash for falsy / unparseable", () => {
    expect(fmtRelativeTime(null)).toBe("—");
    expect(fmtRelativeTime(undefined)).toBe("—");
    expect(fmtRelativeTime("")).toBe("—");
    expect(fmtRelativeTime("not a date")).toBe("—");
  });

  it("renders bands when given a recent timestamp", () => {
    const now = new Date("2026-05-01T12:00:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(fmtRelativeTime(now - 30 * 1000)).toBe("just now");
      expect(fmtRelativeTime(now - 5 * 60 * 1000)).toBe("5m ago");
      expect(fmtRelativeTime(now - 3 * 3600 * 1000)).toBe("3h ago");
      expect(fmtRelativeTime(now - 2 * 86400 * 1000)).toBe("2d ago");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("falls back to ISO date past 30 days", () => {
    const now = new Date("2026-05-01T12:00:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const sixtyDaysAgo = now - 60 * 86400 * 1000;
      expect(fmtRelativeTime(sixtyDaysAgo)).toBe(new Date(sixtyDaysAgo).toISOString().slice(0, 10));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("accepts numbers and ISO strings interchangeably", () => {
    const now = new Date("2026-05-01T12:00:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const isoAgo = new Date(now - 90 * 1000).toISOString();
      expect(fmtRelativeTime(isoAgo)).toBe("1m ago");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
