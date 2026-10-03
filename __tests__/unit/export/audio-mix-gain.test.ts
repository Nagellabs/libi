import { describe, it, expect } from "vitest";
import { buildAudioMixGraph } from "@/lib/export/audio-mix";
import { placeOnTimeline } from "@/lib/export/duck-envelopes";
import { clipGainAt, crossfadePlan } from "@/lib/audio/clip-gain";
import type { AudioClip } from "@/lib/engine/types";

const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: "m", kind: "standalone", fileId: "f", startTime: 2, duration: 10, trimStart: 1, volume: 0.5, enabled: true, ...over,
});
const graph = (clips: AudioClip[], extra: Partial<Parameters<typeof buildAudioMixGraph>[0]> = {}) =>
  buildAudioMixGraph({ baseAudio: null, clips, inputIndex: new Map(clips.map((c, i) => [c.id, i])), mixDuration: "longest", ...extra }).chain!;

describe("buildAudioMixGraph: gain and shape", () => {
  it("a clip with no gain, envelope or crossfade is built exactly as before (an empty shape map changes nothing)", () => {
    expect(graph([clip()], { gainEnvelopeIndex: new Map() })).toBe(graph([clip()]));
    expect(graph([clip()])).toContain("volume=0.5,");
  });

  it("gainDb is folded into the one volume filter: 0.5 at +6.02 dB is 1", () => {
    const g = graph([clip({ gainDb: 6.0206 })]);
    const v = /volume=([\d.]+)/.exec(g)![1];
    expect(Number(v)).toBeCloseTo(1, 3);
    expect(g).not.toContain("amultiply");
  });

  it("a shaped clip is upmixed at unity, multiplied against its track in its own time, then delayed", () => {
    const g = graph([clip({ gainDb: 3 })], { gainEnvelopeIndex: new Map([["m", 5]]), inputChannels: new Map([[0, 1]]) });
    const parts = g.split(";");
    // [0:a]…,volume=…,pan=stereo|c0=c0|c1=c0[a_c0_gpre] — the unity upmix comes BEFORE aformat (which would be -3 dB)
    expect(parts[0]).toMatch(/volume=[\d.]+,pan=stereo\|c0=c0\|c1=c0\[a_c0_gpre\]$/);
    expect(parts[1]).toContain("aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo");
    expect(parts[2]).toMatch(/^\[5:a\]pan=stereo\|c0=c0\|c1=c0,aformat/);
    expect(parts[3]).toBe("[a_c0_gfmt][a_c0_genv]amultiply[a_c0_gmul]");
    // adelay (the clip is placed at 2 s) comes after the multiply, and the upmix is not done twice
    expect(parts[4]).toBe("[a_c0_gmul]anull,adelay=2000|2000[apre]"); // a lone clip is relabelled [apre]
  });

  it("a shaped clip that is the only one still ends in [aout]", () => {
    const g = graph([clip()], { gainEnvelopeIndex: new Map([["m", 1]]) });
    expect(g).toContain("[apre]aresample=async=1[aout]");
    expect(g).toContain("amultiply");
  });

  it("a clip that is shaped AND ducked multiplies by its shape first, then by the duck's curve", () => {
    const g = graph([clip({ duck: { sidechainClipIds: ["vo"], thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 } })], {
      gainEnvelopeIndex: new Map([["m", 3]]),
      envelopeIndex: new Map([["m", 4]]),
      inputChannels: new Map([[0, 1]]),
    });
    expect(g.indexOf("[a_c0_gmul]anull")).toBeGreaterThan(-1);
    expect(g.indexOf("amultiply[a_c0_gmul]")).toBeLessThan(g.indexOf("amultiply[a_c0]") === -1 ? g.indexOf("amultiply[apre]") : g.indexOf("amultiply[a_c0]"));
    expect(g.match(/amultiply/g)).toHaveLength(2);
    expect(g).toContain("[a_c0_pre]aformat");
    expect(g).toContain("[4:a]pan=stereo");
  });

  it("two clips: only the shaped one gets a multiply stage", () => {
    const a = clip({ id: "a" });
    const b = clip({ id: "b", startTime: 0 });
    const g = graph([a, b], { gainEnvelopeIndex: new Map([["b", 4]]) });
    expect(g.match(/amultiply/g)).toHaveLength(1);
    expect(g).toContain("[a_c1_gmul]");
    expect(g).not.toContain("a_c0_gmul");
  });
});

describe("a duck's sidechain hears the sidechain clip's post-gain level", () => {
  it("placeOnTimeline scales the decoded voice by the clip's curve, not just its volume", () => {
    const sr = 1000;
    const decoded = new Float32Array(10 * sr).fill(1);
    const vo = clip({ id: "vo", startTime: 0, duration: 10, trimStart: 0, volume: 1, gainDb: 6.0206, volumeKeyframes: { keyframes: [{ t: 0, value: 0 }, { t: 10, value: -6.0206 }] } });
    const plan = crossfadePlan([vo]);
    const timeline = placeOnTimeline(decoded, { path: "x", startTime: 0, trimStart: 0, duration: 10, volume: 1, gainAt: (t) => clipGainAt(vo, plan, t) }, 10 * sr, sr);
    expect(timeline[0]).toBeCloseTo(2, 3);
    expect(timeline[5000]).toBeCloseTo(clipGainAt(vo, plan, 5), 2);
    expect(timeline[9990]).toBeCloseTo(1, 2);
  });

  it("without gainAt it is the constant volume, as before", () => {
    const tl = placeOnTimeline(new Float32Array(100).fill(1), { path: "x", startTime: 0, trimStart: 0, duration: 0.1, volume: 0.4 }, 100, 1000);
    expect(tl[50]).toBeCloseTo(0.4, 6);
  });
});
