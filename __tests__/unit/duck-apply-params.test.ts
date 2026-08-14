/**
 * applyDuckParams converts user-friendly DuckSettings (dB threshold,
 * dB reduction floor, ms attack/release) to the worklet's internal
 * representation (linear amplitudes, one-pole coefficients per sample).
 *
 * The math:
 *   thresholdLinear = 10^(thresholdDb / 20)
 *   reductionMin    = 10^(reductionDb / 20)
 *   attackCoeff     = 1 - exp(-1 / (attackMs/1000 * sampleRate))
 *   releaseCoeff    = 1 - exp(-1 / (releaseMs/1000 * sampleRate))
 */
import { describe, it, expect } from "vitest";
import { applyDuckParams } from "@/lib/audio/web-audio-mixer";
import { DEFAULT_DUCK } from "@/lib/audio/duck-params";

interface FakeParam { setValueAtTime(value: number, when: number): void; lastValue?: number }
function fakeWorklet(): { parameters: Map<string, FakeParam> } {
  const parameters = new Map<string, FakeParam>();
  for (const name of ["thresholdLinear", "ratio", "attackCoeff", "releaseCoeff", "reductionMin"]) {
    const p: FakeParam = {
      setValueAtTime(value: number) { p.lastValue = value; },
    };
    parameters.set(name, p);
  }
  return { parameters };
}

describe("applyDuckParams math", () => {
  it("-30 dB threshold → ~0.0316 linear", () => {
    const w = fakeWorklet();
    applyDuckParams(w as never, DEFAULT_DUCK, 48000);
    expect(w.parameters.get("thresholdLinear")!.lastValue).toBeCloseTo(0.0316, 4);
  });

  it("-12 dB reduction floor → ~0.251 linear", () => {
    const w = fakeWorklet();
    applyDuckParams(w as never, DEFAULT_DUCK, 48000);
    expect(w.parameters.get("reductionMin")!.lastValue).toBeCloseTo(0.2512, 3);
  });

  it("attack coefficient depends on sample rate (50 ms @ 48 kHz)", () => {
    const w = fakeWorklet();
    applyDuckParams(w as never, DEFAULT_DUCK, 48000);
    // 1 - exp(-1 / (0.05 * 48000)) ≈ 4.166e-4
    expect(w.parameters.get("attackCoeff")!.lastValue).toBeCloseTo(4.166e-4, 6);
  });

  it("release coefficient is smaller than attack for typical settings", () => {
    const w = fakeWorklet();
    applyDuckParams(w as never, DEFAULT_DUCK, 48000);
    expect(w.parameters.get("releaseCoeff")!.lastValue).toBeLessThan(
      w.parameters.get("attackCoeff")!.lastValue!,
    );
  });

  it("0 dB threshold maps to linear 1 (no compression triggered)", () => {
    const w = fakeWorklet();
    applyDuckParams(w as never, { ...DEFAULT_DUCK, thresholdDb: 0 }, 48000);
    expect(w.parameters.get("thresholdLinear")!.lastValue).toBeCloseTo(1, 6);
  });

  it("0 dB reductionDb maps to reductionMin=1 (no reduction allowed)", () => {
    const w = fakeWorklet();
    applyDuckParams(w as never, { ...DEFAULT_DUCK, reductionDb: 0 }, 48000);
    expect(w.parameters.get("reductionMin")!.lastValue).toBeCloseTo(1, 6);
  });

  it("ratio is passed through unchanged", () => {
    const w = fakeWorklet();
    applyDuckParams(w as never, { ...DEFAULT_DUCK, ratio: 8 }, 48000);
    expect(w.parameters.get("ratio")!.lastValue).toBe(8);
  });
});
