import { describe, it, expect } from "vitest";
import {
  dbToGain,
  staticGain,
  envelopeDbAt,
  crossfadePlan,
  clipGainAt,
  shapeGainAt,
  isPlainVolume,
  sanitizeClipGain,
  upsertVolumeKey,
  splitVolumeKeyframes,
  type GainClip,
} from "@/lib/audio/clip-gain";

const clip = (over: Partial<GainClip> & { id: string }): GainClip => ({
  fileId: "f", startTime: 0, duration: 10, volume: 1, enabled: true, ...over,
});
const NO_PLAN = crossfadePlan([]);

describe("dbToGain / staticGain", () => {
  it("is unity at 0 dB, doubles in amplitude at +6.02 dB, is silent at the floor", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6.0206)).toBeCloseTo(2, 3);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 6);
    expect(dbToGain(-60)).toBe(0);
    expect(dbToGain(-90)).toBe(0);
  });

  it("multiplies volume (0..1) with the dB gain, so a clip can be boosted past unity", () => {
    expect(staticGain({ volume: 1, gainDb: 3.8 })).toBeCloseTo(1.549, 3); // the Dreams bed: gain 1.55
    expect(staticGain({ volume: 0.5, gainDb: 6.0206 })).toBeCloseTo(1, 3);
    expect(staticGain({ volume: 0.8 })).toBe(0.8);
  });
});

describe("volume envelope", () => {
  const dip = clip({
    id: "m",
    volumeKeyframes: { keyframes: [{ t: 2, value: 0 }, { t: 4, value: -12 }, { t: 6, value: -12 }, { t: 8, value: 0 }] },
  });

  it("holds the first key before it and the last after it, and is linear in dB between keys", () => {
    expect(envelopeDbAt(dip, 0)).toBe(0);
    expect(envelopeDbAt(dip, 3)).toBeCloseTo(-6, 6);
    expect(envelopeDbAt(dip, 5)).toBe(-12);
    expect(envelopeDbAt(dip, 7)).toBeCloseTo(-6, 6);
    expect(envelopeDbAt(dip, 9.5)).toBe(0);
  });

  it("reads time from the clip's start, not the composition's", () => {
    const moved = { ...dip, startTime: 20 };
    expect(envelopeDbAt(moved, 5)).toBe(envelopeDbAt(dip, 5));
    expect(clipGainAt(moved, NO_PLAN, 25)).toBeCloseTo(dbToGain(-12), 6);
    expect(clipGainAt(moved, NO_PLAN, 5)).toBe(dbToGain(0)); // before the clip's own t=0: held at the first key
  });

  it("shapes a segment with the LEFT key's easing", () => {
    const eased = clip({ id: "e", volumeKeyframes: { keyframes: [{ t: 0, value: 0, easing: "ease-in" }, { t: 4, value: -12 }] } });
    const linear = clip({ id: "l", volumeKeyframes: { keyframes: [{ t: 0, value: 0 }, { t: 4, value: -12 }] } });
    // ease-in starts slow: at the midpoint it has fallen less than the linear ramp.
    expect(envelopeDbAt(eased, 2)).toBeGreaterThan(envelopeDbAt(linear, 2));
    expect(envelopeDbAt(eased, 4)).toBeCloseTo(-12, 6);
  });

  it("combines with volume, gainDb and the in/out fades multiplicatively", () => {
    const c = clip({
      id: "c", volume: 0.5, gainDb: 6.0206,
      volumeKeyframes: { keyframes: [{ t: 0, value: -6.0206 }] },
      effects: { in: { effectId: "audio-fade-in", durationMs: 2000 } },
    });
    // 0.5 × 2.0 × 0.5 × (fade at 1 s of 2 s = 0.5)
    expect(clipGainAt(c, NO_PLAN, 1)).toBeCloseTo(0.25, 3);
    expect(clipGainAt(c, NO_PLAN, 5)).toBeCloseTo(0.5, 3);
  });

  it("a clip with no boost and no envelope is plain volume", () => {
    expect(isPlainVolume(clip({ id: "p", volume: 0.7 }), NO_PLAN)).toBe(true);
    expect(isPlainVolume(clip({ id: "p", gainDb: 3 }), NO_PLAN)).toBe(false);
    expect(isPlainVolume(dip, NO_PLAN)).toBe(false);
    expect(clipGainAt(clip({ id: "p", volume: 0.7 }), NO_PLAN, 3)).toBe(0.7);
  });
});

describe("crossfadePlan", () => {
  const a = clip({ id: "a", startTime: 0, duration: 10 });

  it("fades the later clip in and the earlier one out over min(crossfadeMs, overlap), linearly", () => {
    const b = clip({ id: "b", startTime: 9.9, duration: 8, crossfadeMs: 80 }); // overlap 100 ms, 80 ms asked
    const plan = crossfadePlan([a, b]);
    expect(shapeGainAt(b, plan, 9.9)).toBeCloseTo(0, 6);
    expect(shapeGainAt(b, plan, 9.94)).toBeCloseTo(0.5, 6);
    expect(shapeGainAt(b, plan, 9.98)).toBeCloseTo(1, 6);
    expect(shapeGainAt(a, plan, 9.9)).toBeCloseTo(1, 6);
    expect(shapeGainAt(a, plan, 9.94)).toBeCloseTo(0.5, 6);
    // A stays silent for the rest of its tail, B is whole.
    expect(shapeGainAt(a, plan, 9.99)).toBe(0);
    expect(shapeGainAt(b, plan, 12)).toBe(1);
    // Before the crossfade the earlier clip is untouched.
    expect(shapeGainAt(a, plan, 5)).toBe(1);
  });

  it("sums to unity amplitude across the window (a splice of coherent material does not dip)", () => {
    const b = clip({ id: "b", startTime: 9.5, duration: 8, crossfadeMs: 500 });
    const plan = crossfadePlan([a, b]);
    for (let t = 9.5; t <= 10; t += 0.05) {
      expect(shapeGainAt(a, plan, t) + shapeGainAt(b, plan, t)).toBeCloseTo(1, 6);
    }
  });

  it("is capped by the overlap: a long crossfadeMs on a short overlap ramps over the overlap", () => {
    const b = clip({ id: "b", startTime: 9.8, duration: 8, crossfadeMs: 2000 });
    const plan = crossfadePlan([a, b]);
    expect(shapeGainAt(b, plan, 9.9)).toBeCloseTo(0.5, 6);
    expect(shapeGainAt(b, plan, 10)).toBeCloseTo(1, 6);
  });

  it("does nothing without an earlier clip of the SAME file overlapping the start", () => {
    const abut = clip({ id: "b", startTime: 10, duration: 0.5, crossfadeMs: 80 });
    const gap = clip({ id: "g", startTime: 11, duration: 5, crossfadeMs: 80 });
    const other = clip({ id: "o", fileId: "other", startTime: 9.9, duration: 5, crossfadeMs: 80 });
    const plan = crossfadePlan([a, abut, gap, other]);
    expect(plan.size).toBe(0);
    expect(shapeGainAt(abut, plan, 10)).toBe(1);
  });

  it("ignores a disabled earlier clip", () => {
    const off = { ...a, enabled: false };
    const b = clip({ id: "b", startTime: 9.9, duration: 8, crossfadeMs: 80 });
    expect(crossfadePlan([off, b]).size).toBe(0);
  });

  it("picks the nearest earlier clip when several overlap", () => {
    const far = clip({ id: "far", startTime: 0, duration: 20 });
    const near = clip({ id: "near", startTime: 5, duration: 10 });
    const b = clip({ id: "b", startTime: 12, duration: 5, crossfadeMs: 500 });
    const plan = crossfadePlan([far, near, b]);
    expect(plan.has("near")).toBe(true);
    expect(plan.has("far")).toBe(false);
  });
});

describe("sanitizeClipGain", () => {
  it("clamps gainDb and crossfadeMs, drops zeros and junk", () => {
    const c: Record<string, unknown> = { gainDb: 40, crossfadeMs: 99999 };
    sanitizeClipGain(c);
    expect(c).toEqual({ gainDb: 12, crossfadeMs: 5000 });
    const z: Record<string, unknown> = { gainDb: 0, crossfadeMs: 0 };
    sanitizeClipGain(z);
    expect(z).toEqual({});
    const j: Record<string, unknown> = { gainDb: "loud", crossfadeMs: NaN };
    sanitizeClipGain(j);
    expect(j).toEqual({});
  });

  it("sorts keys, lets the last of a shared time win, clamps dB, and drops an empty track", () => {
    const c: Record<string, unknown> = {
      volumeKeyframes: { keyframes: [{ t: 5, value: -90 }, { t: 1, value: 2 }, { t: 1, value: 3, easing: "linear" }, { t: -1, value: 0 }, { t: "x", value: 1 }] },
    };
    sanitizeClipGain(c);
    expect(c.volumeKeyframes).toEqual({ keyframes: [{ t: 1, value: 3, easing: "linear" }, { t: 5, value: -60 }] });
    const e: Record<string, unknown> = { volumeKeyframes: { keyframes: [] } };
    sanitizeClipGain(e);
    expect("volumeKeyframes" in e).toBe(false);
  });
});

describe("editing the envelope", () => {
  it("upserts within the snap tolerance instead of adding a near-duplicate", () => {
    const one = upsertVolumeKey(undefined, 2, -6);
    const two = upsertVolumeKey(one, 2.003, -9, "ease-out");
    expect(two.keyframes).toEqual([{ t: 2, value: -9, easing: "ease-out" }]);
    const three = upsertVolumeKey(two, 1, 0);
    expect(three.keyframes.map((k) => k.t)).toEqual([1, 2]);
  });

  it("splits an envelope so each half plays what the whole did", () => {
    const whole = clip({
      id: "w",
      volumeKeyframes: { keyframes: [{ t: 0, value: 0 }, { t: 4, value: -12 }, { t: 8, value: 0, easing: "linear" }] },
    });
    const parts = splitVolumeKeyframes(whole, 6)!;
    const head = { ...whole, duration: 6, volumeKeyframes: parts.head };
    const tail = { ...whole, startTime: 6, duration: 4, volumeKeyframes: parts.tail };
    for (const t of [0, 2, 4, 5, 5.99]) expect(clipGainAt(head, NO_PLAN, t)).toBeCloseTo(clipGainAt(whole, NO_PLAN, t), 6);
    for (const t of [6, 7, 8, 9.9]) expect(clipGainAt(tail, NO_PLAN, t)).toBeCloseTo(clipGainAt(whole, NO_PLAN, t), 6);
    expect(splitVolumeKeyframes(clip({ id: "n" }), 3)).toBeNull();
  });
});
