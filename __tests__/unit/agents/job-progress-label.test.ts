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
  it("a non-job tool's message is shown verbatim; a blank one falls back to the job line", () => {
    expect(
      formatJobProgressText({ jobId: "", kind: "", done: 5000, total: 20000, unit: "", etaMs: null, message: "sleeping — 5/20s" }),
    ).toBe("sleeping — 5/20s");
    expect(
      formatJobProgressText({ jobId: "j", kind: "tracking", done: 1, total: 2, unit: "frames", etaMs: null, message: "   " }),
    ).toBe("tracking 1/2 frames (50%)");
  });

  // Final review F7: an export waiting its turn in the export lane says so, not "0/1 (0%)".
  it("an export waiting behind another export says so", () => {
    expect(formatJobProgressText({ jobId: "j", kind: "export", done: 0, total: 1, unit: "waiting", etaMs: null })).toBe("Waiting for another export to finish");
    expect(formatJobProgressText({ jobId: "j", kind: "export", done: 0, total: 1, unit: "waiting", etaMs: null, progressLabel: "4K" })).toBe(
      "4K — Waiting for another export to finish",
    );
  });
});
