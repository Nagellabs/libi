import { describe, it, expect } from "vitest";
import { rejectWrongSubjectRuns } from "@/lib/tracking/reject-wrong-subject";
import { APPEARANCE_TAU } from "@/lib/tracking/summary";
import type { TrackSample } from "@/lib/tracking/types";

function smp(t: number, sim: number | null): TrackSample {
  return { t, x: 1, y: 1, w: 10, h: 10, confidence: 1, visible: true,
    targetSim: sim };
}

describe("rejectWrongSubjectRuns", () => {
  it("blanks a sustained visible run below APPEARANCE_TAU to visible:false", () => {
    // 0.0..1.0s @ 0.1s steps, all sim ~0.6 (cameraman) — ≥0.5s sustained
    const samples = Array.from({ length: 11 }, (_, i) => smp(i / 10, 0.6));
    const out = rejectWrongSubjectRuns(samples);
    expect(out.every((s) => s.visible === false)).toBe(true);
    expect(out.every((s) => s.confidence === 0)).toBe(true);
  });

  it("keeps a brief dip below tau (shorter than the sustained window)", () => {
    const samples = [
      smp(0, 0.95), smp(0.1, 0.6), smp(0.2, 0.6), smp(0.3, 0.95),
    ];
    expect(rejectWrongSubjectRuns(samples).filter((s) => s.visible).length)
      .toBe(4);
  });

  it("never touches samples whose targetSim is null (no appearance signal)", () => {
    const samples = Array.from({ length: 11 }, (_, i) => smp(i / 10, null));
    expect(rejectWrongSubjectRuns(samples).every((s) => s.visible)).toBe(true);
  });

  it("keeps a high-sim run (the real subject)", () => {
    const samples = Array.from({ length: 11 }, (_, i) => smp(i / 10, 0.95));
    expect(rejectWrongSubjectRuns(samples).every((s) => s.visible)).toBe(true);
    expect(APPEARANCE_TAU).toBe(0.78);
  });

  it("rejects a run of EXACTLY the minimum span (>= boundary)", () => {
    const s = Array.from({ length: 6 }, (_, i) => smp(i / 10, 0.6))
      .concat(smp(0.6, 0.95));
    const out = rejectWrongSubjectRuns(s);
    expect(out.slice(0, 6).every((x) => x.visible === false)).toBe(true);
    expect(out[6].visible).toBe(true);
  });

  it("keeps a run just under the minimum span", () => {
    const s = [smp(0, 0.6), smp(0.1, 0.6), smp(0.2, 0.6),
               smp(0.3, 0.6), smp(0.49, 0.6), smp(0.6, 0.95)];
    expect(rejectWrongSubjectRuns(s).slice(0, 5).every((x) => x.visible)).toBe(true);
  });

  it("rejects a sustained low run at the very END of the array (trailing flush)", () => {
    const s = [smp(0, 0.95), smp(0.1, 0.95)]
      .concat(Array.from({ length: 6 }, (_, i) => smp(0.5 + i / 10, 0.6)));
    const out = rejectWrongSubjectRuns(s);
    expect(out.slice(0, 2).every((x) => x.visible)).toBe(true);
    expect(out.slice(2).every((x) => x.visible === false)).toBe(true);
  });

  it("evaluates two runs independently — only the sustained one is rejected", () => {
    const s = [smp(0, 0.95), smp(0.1, 0.6), smp(0.2, 0.6), smp(0.3, 0.95)]
      .concat(Array.from({ length: 6 }, (_, i) => smp(1.0 + i / 10, 0.6)))
      .concat(smp(1.6, 0.95));
    const out = rejectWrongSubjectRuns(s);
    expect(out[1].visible).toBe(true);
    expect(out[5].visible).toBe(false);
  });

  it("a single low sample is a 0-duration run → kept", () => {
    const s = [smp(0, 0.95), smp(0.1, 0.6), smp(0.2, 0.95)];
    expect(rejectWrongSubjectRuns(s).every((x) => x.visible)).toBe(true);
  });
});
