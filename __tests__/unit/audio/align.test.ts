/**
 * `libi.audio_analyze` align: where does a short excerpt sit inside a longer recording? Generated
 * "music" (random notes over a beat) with a known offset, a different level, added noise, a
 * repeating structure (the answer is ambiguous and the confidence must say so), and an unrelated
 * excerpt (no answer).
 */
import { describe, it, expect } from "vitest";
import { alignOffset, ALIGN_RATE } from "@/lib/audio/align";
import { rng, synthMusic } from "@/__tests__/helpers/synth-music";

const R = ALIGN_RATE;

const slice = (x: Float32Array, from: number, to: number) => x.slice(Math.round(from * R), Math.round(to * R));
const scaled = (x: Float32Array, g: number) => x.map((v) => v * g);
function withNoise(x: Float32Array, amp: number, seed: number): Float32Array {
  const rand = rng(seed);
  return x.map((v) => v + amp * (rand() * 2 - 1));
}

describe("alignOffset", () => {
  const song = synthMusic(60, 7);

  it("finds an excerpt's exact offset, to a few milliseconds, with high confidence", () => {
    const ref = slice(song, 17.3, 24.3);
    const r = alignOffset(ref, song, R)!;
    expect(r.offsetSec).toBeCloseTo(17.3, 2);
    expect(Math.abs(r.offsetSec - 17.3)).toBeLessThan(0.005);
    expect(r.confidence).toBeGreaterThan(0.7);
    expect(r.score).toBeGreaterThan(0.8);
  });

  it("is blind to level and to a noise bed under the excerpt", () => {
    const ref = withNoise(scaled(slice(song, 31.04, 38.04), 0.35), 0.03, 3);
    const r = alignOffset(ref, song, R)!;
    expect(Math.abs(r.offsetSec - 31.04)).toBeLessThan(0.01);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("honours a search window, and refuses an offset outside it", () => {
    const ref = slice(song, 40, 46);
    const inside = alignOffset(ref, song, R, { windowFrom: 35, windowTo: 55 })!;
    expect(inside.offsetSec).toBeCloseTo(40, 1);
    const outside = alignOffset(ref, song, R, { windowFrom: 0, windowTo: 30 })!;
    expect(outside.confidence).toBeLessThan(0.3);
  });

  it("an excerpt that is not in the recording has low confidence", () => {
    const other = synthMusic(6, 99);
    const r = alignOffset(other, song, R)!;
    expect(r.confidence).toBeLessThan(0.25);
  });

  it("a repeating structure is ambiguous: low confidence, and the repeats are listed as alternatives", () => {
    const phrase = synthMusic(8, 21);
    const looped = new Float32Array(phrase.length * 6);
    for (let i = 0; i < 6; i++) looped.set(phrase, i * phrase.length);
    const ref = slice(looped, 9, 14); // sits 1 s into the second copy of the phrase
    const r = alignOffset(ref, looped, R)!;
    expect(r.confidence).toBeLessThan(0.35);
    const offsets = [r.offsetSec, ...r.alternatives.map((a) => a.offsetSec)].map((o) => Math.round(o * 10) / 10);
    // 1, 9, 17, 25, … : the repeats every 8 s are all candidates.
    expect(offsets.filter((o) => Math.abs((o - 1) % 8) < 0.15 || Math.abs((o - 1) % 8 - 8) < 0.15).length).toBeGreaterThanOrEqual(2);
  });

  it("returns null when the reference is longer than the searched part", () => {
    expect(alignOffset(slice(song, 0, 30), slice(song, 0, 10), R)).toBeNull();
  });

  it("an excerpt at the very start and one at the very end are found", () => {
    expect(alignOffset(slice(song, 0, 5), song, R)!.offsetSec).toBeCloseTo(0, 1);
    expect(alignOffset(slice(song, 55, 60), song, R)!.offsetSec).toBeCloseTo(55, 1);
  });
});
