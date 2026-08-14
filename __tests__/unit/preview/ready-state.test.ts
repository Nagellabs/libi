import { describe, it, expect } from "vitest";
import {
  computeReadyState,
  type ActiveSourceState,
} from "@/lib/preview/ready-state";

const src = (id: string, o: Partial<ActiveSourceState> = {}): ActiveSourceState => ({
  id,
  canPaint: o.canPaint ?? true,
  runway: o.runway ?? 0.5,
  priority: o.priority ?? 0.5,
});

describe("computeReadyState", () => {
  it("empty active set → nothing gates (allCanPaint, Infinity runway, no dominant)", () => {
    const d = computeReadyState([]);
    expect(d.allCanPaint).toBe(true);
    expect(d.dominantId).toBeNull();
    expect(d.dominantRunway).toBe(Infinity);
  });

  it("dominant = highest priority; runway reported is the DOMINANT's, not the worst", () => {
    const d = computeReadyState([
      src("big", { priority: 0.9, runway: 0.6 }),
      src("pip", { priority: 0.1, runway: 0.0 }), // worse runway, low priority
    ]);
    expect(d.dominantId).toBe("big");
    expect(d.dominantRunway).toBe(0.6); // NOT the min (0.0)
  });

  it("a starved SECONDARY does not lower the reported (dominant) runway", () => {
    // Mid-play: the big video is healthy; a small PIP is dropping frames (runway
    // -1) but still can paint (held last-good). The re-buffer path keys off
    // dominantRunway, so this must stay healthy → no whole-comp re-buffer.
    const d = computeReadyState([
      src("big", { priority: 0.9, runway: 0.5, canPaint: true }),
      src("pip", { priority: 0.1, runway: -1, canPaint: true }),
    ]);
    expect(d.dominantRunway).toBe(0.5);
    expect(d.allCanPaint).toBe(true);
  });

  it("a starved DOMINANT lowers the reported runway (re-buffer trips on it)", () => {
    const d = computeReadyState([
      src("big", { priority: 0.9, runway: -1 }),
      src("pip", { priority: 0.1, runway: 0.8 }),
    ]);
    expect(d.dominantId).toBe("big");
    expect(d.dominantRunway).toBe(-1);
  });

  it("any black source clears allCanPaint (gate must hold to avoid a black flash)", () => {
    const d = computeReadyState([
      src("big", { priority: 0.9, canPaint: true }),
      src("cold", { priority: 0.1, canPaint: false }), // never painted → black
    ]);
    expect(d.allCanPaint).toBe(false);
    // dominant is still the healthy big one — re-buffer won't trip, but the gate
    // (which also requires allCanPaint) will hold.
    expect(d.dominantId).toBe("big");
  });

  it("all can paint → allCanPaint true", () => {
    const d = computeReadyState([
      src("a", { canPaint: true }),
      src("b", { canPaint: true }),
    ]);
    expect(d.allCanPaint).toBe(true);
  });

  it("single source is its own dominant", () => {
    const d = computeReadyState([src("only", { priority: 0.3, runway: 0.42 })]);
    expect(d.dominantId).toBe("only");
    expect(d.dominantRunway).toBe(0.42);
  });

  it("all-NaN priorities still resolve a dominant with a REAL runway (no -1 sentinel)", () => {
    // Regression: a NaN priority loses every `>` comparison. computeReadyState
    // must still pick a dominant (the first source) and report ITS runway, not
    // a leftover sentinel that would wedge the gate into a false re-buffer.
    const d = computeReadyState([
      src("a", { priority: NaN, runway: 0.63, canPaint: true }),
      src("b", { priority: NaN, runway: 0.5, canPaint: true }),
    ]);
    expect(d.dominantId).toBe("a");
    expect(d.dominantRunway).toBe(0.63);
    expect(d.allCanPaint).toBe(true);
  });

  it("dominant tie broken by lowest id (stable frame-to-frame)", () => {
    const d = computeReadyState([
      src("b", { priority: 0.5, runway: 0.2 }),
      src("a", { priority: 0.5, runway: 0.9 }),
    ]);
    expect(d.dominantId).toBe("a");
    expect(d.dominantRunway).toBe(0.9);
  });
});
