import { describe, it, expect } from "vitest";
import {
  formatTokens,
  formatReset,
  usageSeverity,
} from "@/lib/chat/format-usage";

describe("formatTokens", () => {
  it("formats counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(82_000)).toBe("82k");
    expect(formatTokens(82_500)).toBe("83k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_000_000)).toBe("1m");
    expect(formatTokens(1_500_000)).toBe("1.5m");
  });
});

describe("formatReset", () => {
  // now: 2026-07-04T10:00:00 local — build from local parts so the test is
  // timezone-independent.
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();

  it("same local day → local time", () => {
    const resetsAt = Math.floor(new Date(2026, 6, 4, 18, 0, 0).getTime() / 1000);
    expect(formatReset(resetsAt, now)).toBe("6:00 PM");
  });

  it("different day → weekday name", () => {
    const resetsAt = Math.floor(new Date(2026, 6, 7, 9, 0, 0).getTime() / 1000);
    expect(formatReset(resetsAt, now)).toBe("Tue");
  });
});

describe("usageSeverity", () => {
  it("thresholds at 80% and 95%", () => {
    expect(usageSeverity(0.5)).toBe("ok");
    expect(usageSeverity(0.79)).toBe("ok");
    expect(usageSeverity(0.8)).toBe("warn");
    expect(usageSeverity(0.94)).toBe("warn");
    expect(usageSeverity(0.95)).toBe("critical");
    expect(usageSeverity(1.2)).toBe("critical");
  });
});
