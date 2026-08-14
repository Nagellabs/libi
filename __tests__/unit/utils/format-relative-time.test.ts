import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRelativeTime } from "@/lib/utils/format";

const NOW = new Date("2026-08-04T12:00:00.000Z").getTime();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function at(now: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  it("never says '0m ago'", () => {
    // The 45-59s window used to fall through to `Math.floor(s / 60)` === 0.
    // Live QA caught it as "Opened 0m ago" on a piece opened seconds earlier.
    at(NOW);
    for (const s of [0, 30, 44, 45, 50, 59]) {
      expect(formatRelativeTime(ago(s))).toBe("just now");
    }
  });

  it("switches to minutes at a full minute", () => {
    at(NOW);
    expect(formatRelativeTime(ago(60))).toBe("1m ago");
    expect(formatRelativeTime(ago(59 * 60))).toBe("59m ago");
  });

  it("switches to hours, then days", () => {
    at(NOW);
    expect(formatRelativeTime(ago(60 * 60))).toBe("1h ago");
    expect(formatRelativeTime(ago(23 * 3600))).toBe("23h ago");
    expect(formatRelativeTime(ago(24 * 3600))).toBe("1d ago");
    expect(formatRelativeTime(ago(29 * 24 * 3600))).toBe("29d ago");
  });

  it("falls back to a plain date past 30 days", () => {
    at(NOW);
    const out = formatRelativeTime(ago(40 * 24 * 3600));
    expect(out).not.toMatch(/ago|just now/);
    expect(out).toBe(new Date(ago(40 * 24 * 3600)).toLocaleDateString());
  });

  it("returns an em dash for absent or unparseable input", () => {
    expect(formatRelativeTime(undefined)).toBe("—");
    expect(formatRelativeTime(null)).toBe("—");
    expect(formatRelativeTime("")).toBe("—");
    expect(formatRelativeTime("not-a-date")).toBe("—");
  });
});
