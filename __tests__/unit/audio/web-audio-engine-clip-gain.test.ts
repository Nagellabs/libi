/**
 * The PREVIEW applies a clip's gain, volume envelope and crossfade through
 * Web Audio gain automation. A recording AudioParam replays what was scheduled
 * and the result is compared with the evaluator the export renders too
 * (`lib/audio/clip-gain.ts`), on first play, on a seek into the middle of an
 * envelope segment, at a changed playback rate, and when the manifest changes
 * under a playing engine.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AudioClip } from "@/lib/engine/types";
import { clipGainAt, crossfadePlan } from "@/lib/audio/clip-gain";
import { crossfadeGain } from "@/lib/audio/schedule-math";

vi.mock("mediabunny", () => ({
  Input: class { async getPrimaryAudioTrack() { return null; } dispose() {} },
  UrlSource: class {},
  AudioBufferSink: class {},
  ALL_FORMATS: [],
  Logging: { on: () => () => {} },
}));

type Ev =
  | { kind: "set"; v: number; t: number }
  | { kind: "ramp"; v: number; t: number }
  | { kind: "curve"; values: Float32Array; t: number; d: number };

/** An AudioParam that records its automation and can be read at any context time. */
class RecordingParam {
  value = 1;
  events: Ev[] = [];
  curves = 0;
  setValueAtTime(v: number, t: number) { this.events.push({ kind: "set", v, t }); }
  linearRampToValueAtTime(v: number, t: number) { this.events.push({ kind: "ramp", v, t }); }
  setValueCurveAtTime(values: Float32Array, t: number, d: number) { this.curves++; this.events.push({ kind: "curve", values, t, d }); }
  // Per the spec: events at or after `t`, and a curve still running at `t`, are removed.
  cancelScheduledValues(t: number) {
    this.events = this.events.filter((e) => e.t < t && (e.kind !== "curve" || e.t + e.d <= t));
  }
  /** The scheduled value at context time `t` (the fake's own reading of the spec). */
  at(t: number): number {
    let v = this.value;
    const sorted = [...this.events].sort((a, b) => a.t - b.t);
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      if (e.kind === "curve") {
        if (t < e.t) break;
        if (t >= e.t + e.d) { v = e.values[e.values.length - 1]; continue; }
        const x = ((t - e.t) / e.d) * (e.values.length - 1);
        const k = Math.floor(x);
        return e.values[k] * (1 - (x - k)) + e.values[Math.min(k + 1, e.values.length - 1)] * (x - k);
      }
      if (e.kind === "set") { if (t >= e.t) v = e.v; else break; }
      else {
        // a linear ramp from the previous event's value
        const prevT = i > 0 ? sorted[i - 1].t : 0;
        if (t >= e.t) v = e.v;
        else { const f = (t - prevT) / (e.t - prevT); return v + (e.v - v) * Math.max(0, f); }
      }
    }
    return v;
  }
}
class FakeNode {
  connect(t: unknown) { return t; }
  disconnect() {}
}
class FakeGain extends FakeNode { gain = new RecordingParam(); }

let ctxTime = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  ctxTime = 0;
  vi.stubGlobal("AudioContext", class {
    state = "running"; sampleRate = 48000;
    get currentTime() { return ctxTime; }
    destination = new FakeNode();
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    async resume() {}
    async close() {}
    createGain() { return new FakeGain(); }
    createBufferSource() { return new FakeNode(); }
  });
});

function clip(id: string, extra: Partial<AudioClip> = {}): AudioClip {
  return { id, fileId: `f-${id}`, kind: "standalone", startTime: 0, duration: 20, trimStart: 0, volume: 1, enabled: true, ...extra } as AudioClip;
}

async function engine(clips: AudioClip[]) {
  const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
  const eng = new WebAudioEngine((fid) => `/${fid}`);
  eng.setClips(clips);
  await tick();
  const params = (id: string) => (eng as unknown as { clips: Map<string, { gain: FakeGain }> }).clips.get(id)!.gain.gain;
  return { eng, params };
}

const bed = (): AudioClip =>
  clip("bed", {
    volume: 0.8,
    gainDb: 4,
    volumeKeyframes: { keyframes: [{ t: 4, value: 0 }, { t: 6, value: -12 }, { t: 12, value: -12 }, { t: 14, value: 0, easing: "ease-in-out" }] },
    effects: { out: { effectId: "audio-fade-out", durationMs: 1500 } },
  });

/** What the preview should play at composition time `t`: the law, times the preview's 20 ms edge ramp. */
function expected(c: AudioClip, all: AudioClip[], t: number): number {
  const local = Math.min(Math.max(t - c.startTime, 0), c.duration);
  return clipGainAt(c, crossfadePlan(all), t) * crossfadeGain(local, c.duration);
}

describe("preview gain automation = the evaluator the export renders", () => {
  it("plays the gain, envelope and fade of a clip from the start", async () => {
    const c = bed();
    const { eng, params } = await engine([c]);
    eng.play();
    const p = params("bed");
    expect(p.curves).toBe(1);
    // Anchor: comp 0 at ctx 0, speed 1, so ctx time == comp time.
    for (const t of [0.5, 3.9, 4.5, 5, 6, 8, 12, 12.5, 13, 14, 15, 18.7, 19.4]) {
      expect(p.at(t)).toBeCloseTo(expected(c, [c], t), 2);
    }
    // The dip really is 12 dB down from the un-dipped level.
    expect(p.at(9) / p.at(1)).toBeCloseTo(Math.pow(10, -12 / 20), 2);
  });

  it("resumes mid-segment after a seek, with the playhead's own level from the first instant", async () => {
    const c = bed();
    const { eng, params } = await engine([c]);
    eng.play();
    ctxTime = 100;
    eng.seek(5); // inside the 4→6 s ramp down
    const p = params("bed");
    expect(p.at(100)).toBeCloseTo(expected(c, [c], 5), 2);
    for (const dt of [0.4, 1, 3, 7, 9]) expect(p.at(100 + dt)).toBeCloseTo(expected(c, [c], 5 + dt), 2);
  });

  it("follows a playback-rate change: the same curve over half the context time at 2x", async () => {
    const c = bed();
    const { eng, params } = await engine([c]);
    eng.play();
    ctxTime = 2; // comp 2
    eng.setSpeed(2);
    const p = params("bed");
    // comp 6 is 2 context seconds later at 2x.
    expect(p.at(2 + (6 - 2) / 2)).toBeCloseTo(expected(c, [c], 6), 2);
    expect(p.at(2 + (13 - 2) / 2)).toBeCloseTo(expected(c, [c], 13), 2);
  });

  it("reschedules when the manifest changes under a playing engine", async () => {
    const c = bed();
    const { eng, params } = await engine([c]);
    eng.play();
    ctxTime = 1;
    const moved = { ...c, gainDb: -6 };
    eng.setClips([moved]);
    expect(params("bed").at(1)).toBeCloseTo(expected(moved, [moved], 1), 2);
    expect(params("bed").at(9)).toBeCloseTo(expected(moved, [moved], 9), 2);
  });

  it("is silent before a clip that starts later, then rides its own curve", async () => {
    const c = { ...bed(), startTime: 3 };
    const { eng, params } = await engine([c]);
    eng.play();
    const p = params("bed");
    expect(p.at(1)).toBe(0);
    expect(p.at(2.99)).toBe(0);
    for (const t of [3.5, 8, 9.5, 15, 22]) expect(p.at(t)).toBeCloseTo(expected(c, [c], t), 2);
  });

  it("crossfades a clip over the earlier one of the same file", async () => {
    const a = clip("a", { fileId: "same", startTime: 0, duration: 10 });
    const b = clip("b", { fileId: "same", startTime: 9.5, duration: 10, crossfadeMs: 400 });
    const all = [a, b];
    const { eng, params } = await engine(all);
    eng.play();
    for (const t of [5, 9.4, 9.6, 9.7, 9.9, 10.5, 15]) {
      expect(params("a").at(t)).toBeCloseTo(t >= 10 ? 0 : expected(a, all, t), 2);
      expect(params("b").at(t)).toBeCloseTo(expected(b, all, t), 2);
    }
    // At the midpoint of the crossfade window each is half.
    expect(params("a").at(9.7) + params("b").at(9.7)).toBeCloseTo(1, 2);
  });

  it("keeps the old ramp scheduling for a clip with no envelope or crossfade (gainDb is a plain boost)", async () => {
    const c = clip("plain", { volume: 0.5, gainDb: 6.0206 });
    const { eng, params } = await engine([c]);
    eng.play();
    const p = params("plain");
    expect(p.curves).toBe(0);
    expect(p.at(5)).toBeCloseTo(1, 3);
  });
});
