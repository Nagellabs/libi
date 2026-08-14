import { describe, it, expect } from "vitest";
import { revealFraction } from "@/lib/engine/text-anim/caption-reveal";

describe("revealFraction", () => {
  it("derives fraction from durationMs / element duration (800ms on an 8s clip)", () => {
    expect(revealFraction({ mode: "typewriter", durationMs: 800 } as never, 8)).toBeCloseTo(0.1, 5);
  });

  it("durationMs wins over a legacy fraction", () => {
    expect(
      revealFraction({ mode: "typewriter", durationMs: 500, fraction: 0.9 } as never, 5),
    ).toBeCloseTo(0.1, 5);
  });

  it("falls back to legacy fraction when durationMs is absent", () => {
    expect(revealFraction({ mode: "typewriter", fraction: 0.4 } as never, 8)).toBe(0.4);
  });

  it("falls back to full window (1) when neither is set", () => {
    expect(revealFraction({ mode: "typewriter" } as never, 8)).toBe(1);
  });

  it("clamps to <= 1 when the reveal duration exceeds the element", () => {
    expect(revealFraction({ mode: "typewriter", durationMs: 20000 } as never, 2)).toBe(1);
  });

  it("clamps to a tiny floor (never 0) for a near-instant reveal", () => {
    const f = revealFraction({ mode: "typewriter", durationMs: 50 } as never, 600);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThanOrEqual(0.02);
  });

  it("is safe for a zero/negative element duration", () => {
    expect(revealFraction({ mode: "typewriter", durationMs: 800 } as never, 0)).toBe(1);
  });

  it("returns 1 for a null reveal", () => {
    expect(revealFraction(null, 8)).toBe(1);
  });
});
