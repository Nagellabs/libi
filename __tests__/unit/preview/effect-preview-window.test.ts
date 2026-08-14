import { describe, it, expect } from "vitest";
import { effectPreviewWindowSec } from "@/lib/preview/effect-preview-window";

describe("effectPreviewWindowSec", () => {
  const base = { elementStart: 10, elementDuration: 4 } as const;

  it("in → head window of the effective duration", () => {
    expect(
      effectPreviewWindowSec({ ...base, family: "animation", phase: "in", durationMs: 600 }),
    ).toEqual({ startSec: 10, endSec: 10.6 });
  });

  it("in → falls back to defaultDurationMs, then 400ms", () => {
    expect(
      effectPreviewWindowSec({ ...base, family: "animation", phase: "in", defaultDurationMs: 800 }),
    ).toEqual({ startSec: 10, endSec: 10.8 });
    expect(effectPreviewWindowSec({ ...base, family: "animation", phase: "in" })).toEqual({
      startSec: 10,
      endSec: 10.4,
    });
  });

  it("out → tail window ending exactly at element end", () => {
    expect(
      effectPreviewWindowSec({ ...base, family: "animation", phase: "out", durationMs: 1000 }),
    ).toEqual({ startSec: 13, endSec: 14 });
  });

  it("loop → from start for one period (clamped to element)", () => {
    expect(
      effectPreviewWindowSec({ ...base, family: "animation", phase: "loop", durationMs: 1500 }),
    ).toEqual({ startSec: 10, endSec: 11.5 });
    expect(
      effectPreviewWindowSec({ ...base, family: "animation", phase: "loop", durationMs: 9000 }),
    ).toEqual({ startSec: 10, endSec: 14 });
  });

  it("reveal → spans the whole element regardless of phase", () => {
    expect(effectPreviewWindowSec({ ...base, family: "reveal" })).toEqual({ startSec: 10, endSec: 14 });
  });

  it("applies a minimum so a tiny duration is never a 1-frame flash", () => {
    expect(
      effectPreviewWindowSec({ ...base, family: "animation", phase: "in", durationMs: 50 }),
    ).toEqual({ startSec: 10, endSec: 10.3 });
  });

  it("returns null for a zero-duration element", () => {
    expect(
      effectPreviewWindowSec({ elementStart: 5, elementDuration: 0, family: "animation", phase: "in" }),
    ).toBeNull();
  });
});
