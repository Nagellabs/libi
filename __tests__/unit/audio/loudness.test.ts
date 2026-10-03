/**
 * The loudness numbers `libi.audio_analyze` reports: ITU-R BS.1770 K-weighted LUFS (integrated, gated;
 * short-term max), RMS and sample peak, on generated tones whose answers are known.
 */
import { describe, it, expect } from "vitest";
import { analyzeLoudness, LOUDNESS_RATE, SILENCE_DB } from "@/lib/audio/loudness";

const RATE = LOUDNESS_RATE;

/** Interleaved stereo float samples: a sine of `peakDb` (dBFS) at `hz`, left and right alike, for `seconds`. */
function stereoSine(seconds: number, hz: number, peakDb: number, rightPeakDb = peakDb): Float32Array {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n * 2);
  const a = Math.pow(10, peakDb / 20);
  const b = Math.pow(10, rightPeakDb / 20);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * hz * i) / RATE);
    out[2 * i] = a * s;
    out[2 * i + 1] = b * s;
  }
  return out;
}

const concat = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

describe("analyzeLoudness", () => {
  it("reads a -23 dBFS stereo 1 kHz sine as -23 LUFS (the EBU reference), RMS -26 dB, peak -23 dB", () => {
    const r = analyzeLoudness(stereoSine(6, 1000, -23));
    expect(r.lufs).toBeCloseTo(-23, 0);
    expect(Math.abs((r.lufs ?? 0) + 23)).toBeLessThan(0.15);
    expect(r.rmsDb).toBeCloseTo(-26.01, 1);
    expect(r.peakDb).toBeCloseTo(-23, 1);
    expect(r.shortTermMaxLufs).toBeCloseTo(-23, 0);
  });

  it("tracks level: 10 dB louder reads 10 LUFS higher", () => {
    const a = analyzeLoudness(stereoSine(5, 1000, -30));
    const b = analyzeLoudness(stereoSine(5, 1000, -20));
    expect((b.lufs ?? 0) - (a.lufs ?? 0)).toBeCloseTo(10, 1);
  });

  it("K-weighting: a 100 Hz tone reads quieter than a 1 kHz tone of the same peak (the filter's low-frequency roll-off)", () => {
    const low = analyzeLoudness(stereoSine(5, 100, -20));
    const mid = analyzeLoudness(stereoSine(5, 1000, -20));
    expect(low.lufs!).toBeLessThan(mid.lufs! - 0.4);
    // …while RMS and peak are blind to frequency.
    expect(low.rmsDb).toBeCloseTo(mid.rmsDb, 1);
  });

  it("a signal on one channel only is 3 dB quieter than the same on both", () => {
    const both = analyzeLoudness(stereoSine(5, 1000, -20));
    const left = analyzeLoudness(stereoSine(5, 1000, -20, -120));
    expect((both.lufs ?? 0) - (left.lufs ?? 0)).toBeCloseTo(3.01, 1);
  });

  it("the integrated value gates out silence (relative gate), the RMS does not", () => {
    const tone = stereoSine(5, 1000, -23);
    const withSilence = analyzeLoudness(concat(tone, new Float32Array(RATE * 2 * 10)));
    expect(withSilence.lufs).toBeCloseTo(-23, 0);
    // 5 s of tone in 15 s: RMS drops by 10*log10(3) = 4.77 dB.
    expect(withSilence.rmsDb).toBeCloseTo(-26.01 - 4.77, 1);
  });

  it("short-term max finds the loud 3 s inside a quiet passage", () => {
    const quiet = stereoSine(6, 1000, -40);
    const loud = stereoSine(4, 1000, -20);
    const r = analyzeLoudness(concat(quiet, loud, quiet));
    expect(r.shortTermMaxLufs).toBeCloseTo(-20, 0);
    expect(r.lufs!).toBeLessThan(-19);
    expect(r.lufs!).toBeGreaterThan(-30);
  });

  it("silence: no loudness, the floor for RMS and peak, silent flag", () => {
    const r = analyzeLoudness(new Float32Array(RATE * 2 * 3));
    expect(r.lufs).toBeNull();
    expect(r.rmsDb).toBe(SILENCE_DB);
    expect(r.peakDb).toBe(SILENCE_DB);
    expect(r.silent).toBe(true);
  });

  it("a range shorter than one 400 ms block has RMS and peak but no LUFS; shorter than 3 s has no short-term", () => {
    const r = analyzeLoudness(stereoSine(0.25, 1000, -12));
    expect(r.lufs).toBeNull();
    expect(r.shortTermMaxLufs).toBeNull();
    expect(r.peakDb).toBeCloseTo(-12, 1);
    const mid = analyzeLoudness(stereoSine(1, 1000, -12));
    expect(mid.lufs).not.toBeNull();
    expect(mid.shortTermMaxLufs).toBeNull();
  });

  it("a pre-roll warms the filter up without counting in the stats", () => {
    const x = stereoSine(4, 1000, -23);
    const pre = Math.round(0.5 * RATE) * 2;
    const r = analyzeLoudness(x.subarray(0), { preRollSamples: pre });
    expect(r.durationSec).toBeCloseTo(3.5, 2);
    expect(r.lufs).toBeCloseTo(-23, 0);
  });

  it("clips above full scale read above 0 dBFS peak (the float mix can exceed it before the limiter)", () => {
    const r = analyzeLoudness(stereoSine(2, 1000, 3));
    expect(r.peakDb).toBeCloseTo(3, 1);
  });
});
