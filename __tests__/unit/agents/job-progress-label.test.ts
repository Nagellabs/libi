import { describe, it, expect } from "vitest";
import { formatJobProgressText } from "@/lib/agents/session-event-handler";

describe("formatJobProgressText", () => {
  it("plain payload — kind, counts, pct, ETA", () => {
    expect(
      formatJobProgressText({
        jobId: "j",
        kind: "tracking",
        done: 45,
        total: 248,
        unit: "frames",
        etaMs: 29_000,
      }),
    ).toBe("tracking 45/248 frames (18%) — ETA 29s");
  });

  it("prepends the progressLabel when present", () => {
    expect(
      formatJobProgressText({
        jobId: "j",
        kind: "tracking",
        done: 5,
        total: 41,
        unit: "frames",
        etaMs: null,
        progressLabel: "segment 2/7",
      }),
    ).toBe("segment 2/7 — tracking 5/41 frames (12%)");
  });
});
