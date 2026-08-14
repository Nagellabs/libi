import { describe, it, expect } from "vitest";
import { shouldHoldForMonotonic } from "@/lib/engine/media-bunny-frame-source";
import { COVERAGE_EPS } from "@/lib/preview/tuning";

/**
 * The play-start "whole-frame flash" was getFrame serving frames OUT OF ORDER
 * (0.83 → 0.63 → 0.83 …) while the decode ring filled up to the playhead. This
 * guard holds the last painted frame instead of stepping backward — but it MUST
 * NEVER withhold a forward frame (that was the earlier freeze regression).
 */
describe("shouldHoldForMonotonic", () => {
  const eps = COVERAGE_EPS;

  it("HOLDS a meaningful backward step while playing (the play-start flash)", () => {
    // last painted 0.83, ring offers 0.63 → backward → hold.
    expect(shouldHoldForMonotonic(true, 0.63, 0.83, eps)).toBe(true);
  });

  it("NEVER holds a forward frame (no freeze on an advancing playhead)", () => {
    expect(shouldHoldForMonotonic(true, 0.84, 0.83, eps)).toBe(false);
    expect(shouldHoldForMonotonic(true, 1.5, 0.83, eps)).toBe(false);
  });

  it("does not hold the same frame (within eps) — steady playback serves", () => {
    expect(shouldHoldForMonotonic(true, 0.83, 0.83, eps)).toBe(false);
    expect(shouldHoldForMonotonic(true, 0.83 - eps / 2, 0.83, eps)).toBe(false);
  });

  it("NEVER holds while paused (a scrub must show any frame, including backward)", () => {
    expect(shouldHoldForMonotonic(false, 0.63, 0.83, eps)).toBe(false);
    expect(shouldHoldForMonotonic(false, 0.1, 5.0, eps)).toBe(false);
  });

  it("does not hold when there is no selected frame (null → black/last-good path)", () => {
    expect(shouldHoldForMonotonic(true, null, 0.83, eps)).toBe(false);
  });

  it("with a fresh anchor (-Infinity, e.g. just after seek) nothing is held", () => {
    expect(shouldHoldForMonotonic(true, 0.0, -Infinity, eps)).toBe(false);
    expect(shouldHoldForMonotonic(true, 100, -Infinity, eps)).toBe(false);
  });
});
