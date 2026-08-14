import { describe, it, expect } from "vitest";
import { DEFAULT_DUCK, sanitizeDuck, validateDuck } from "@/lib/audio/duck-params";

describe("duck-params", () => {
  it("DEFAULT_DUCK is musically sensible (-30 dB threshold, 4:1 ratio, 50ms attack, 250ms release)", () => {
    expect(DEFAULT_DUCK).toEqual({
      sidechainClipId: "",
      thresholdDb: -30,
      ratio: 4,
      attackMs: 50,
      releaseMs: 250,
      reductionDb: -12,
    });
  });

  it("sanitizeDuck clamps numeric ranges", () => {
    expect(sanitizeDuck({
      sidechainClipId: "x",
      thresholdDb: -100,    // < -60 floor
      ratio: 0.5,           // < 1 floor
      attackMs: -5,         // < 1 floor
      releaseMs: 99999,     // > 5000 ceiling
      reductionDb: 5,       // positive — clamp to 0 max
    })).toEqual({
      sidechainClipId: "x",
      thresholdDb: -60,
      ratio: 1,
      attackMs: 1,
      releaseMs: 5000,
      reductionDb: 0,
    });
  });

  it("validateDuck rejects an empty sidechainClipId", () => {
    expect(validateDuck({ ...DEFAULT_DUCK, sidechainClipId: "" }, []).ok).toBe(false);
    expect(validateDuck({ ...DEFAULT_DUCK, sidechainClipId: "abc" }, [{ id: "abc", duck: undefined }]).ok).toBe(true);
  });

  it("validateDuck detects a direct cycle (A ducks B, B ducks A)", () => {
    // A's duck targets B; B's duck targets A — proposing A→B closes a cycle.
    const clips = [
      { id: "A", duck: { sidechainClipId: "B" } },
      { id: "B", duck: { sidechainClipId: "A" } },
    ];
    const result = validateDuck(
      { ...DEFAULT_DUCK, sidechainClipId: "B" },
      clips,
      "A",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cycle/i);
  });

  it("validateDuck detects a transitive cycle (A→B→C→A)", () => {
    const clips = [
      { id: "A", duck: undefined },
      { id: "B", duck: { sidechainClipId: "C" } },
      { id: "C", duck: { sidechainClipId: "A" } },
    ];
    const result = validateDuck(
      { ...DEFAULT_DUCK, sidechainClipId: "B" },
      clips,
      "A",
    );
    expect(result.ok).toBe(false);
  });

  it("validateDuck allows non-cyclic chains (A→B→C, no return edge)", () => {
    const clips = [
      { id: "A", duck: undefined },
      { id: "B", duck: { sidechainClipId: "C" } },
      { id: "C", duck: undefined },
    ];
    const result = validateDuck(
      { ...DEFAULT_DUCK, sidechainClipId: "B" },
      clips,
      "A",
    );
    expect(result.ok).toBe(true);
  });
});
