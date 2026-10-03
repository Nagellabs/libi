/**
 * Integration: the EXPORT applies a clip's gain, volume envelope and crossfade
 * with the same numbers the PREVIEW's evaluator gives (`lib/audio/clip-gain.ts`).
 * Real ffmpeg: the shape track is rendered by `renderClipShapeEnvelopes`,
 * multiplied in by `buildAudioMixGraph`, and the mixed audio is measured in
 * 100 ms windows against the same source un-processed. The measured gain curve
 * must equal `clipGainAt` sampled at the window centres: this is the parity
 * test the duck lacked (its preview and export drifted by 5 dB).
 *
 * The B3 plan: a bed that dips under narration and comes back, boosted +3.8 dB,
 * used to be baked in an ffmpeg expression and re-uploaded to six pieces.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, execSync, spawnSync } from "child_process";
import { buildAudioMixGraph } from "@/lib/export/audio-mix";
import { planCrossfades, renderClipShapeEnvelopes } from "@/lib/export/gain-envelopes";
import { renderDuckEnvelopes } from "@/lib/export/duck-envelopes";
import { clipGainAt, gainToDb } from "@/lib/audio/clip-gain";
import type { AudioClip } from "@/lib/engine/types";

function hasFfmpeg(): boolean {
  try { execSync("ffmpeg -version", { stdio: "ignore", timeout: 2000 }); return true; }
  catch { return false; }
}
const ffmpegPresent = hasFfmpeg();
if (!ffmpegPresent) console.info("[skip] export clip gain — ffmpeg not on PATH");
const skipIf = ffmpegPresent ? describe : describe.skip;

const TOTAL = 14;
const WINDOW = 0.1;

let dir: string;
let music: string;
let reference: string;

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

/** Mono float samples of a file (the music is mono; both channels of the export are identical). */
function samples(file: string): Float32Array {
  const raw = path.join(dir, `raw-${path.basename(file)}.f32`);
  ff(["-i", file, "-af", "pan=mono|c0=c0", "-ar", "44100", "-f", "f32le", raw]);
  const buf = fs.readFileSync(raw);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** RMS of [from, to) seconds. */
function rms(x: Float32Array, from: number, to: number): number {
  const a = Math.round(from * 44100);
  const b = Math.min(x.length, Math.round(to * 44100));
  let sum = 0;
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, b - a));
}

/** Mean volume (dB) of [from, to) of a file, via volumedetect. */
function volume(file: string, from: number, to: number): number {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-ss", String(from), "-t", String(to - from), "-i", file, "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  if (!m) throw new Error(`no volumedetect output for ${file}: ${r.stderr}`);
  return parseFloat(m[1]);
}

const clip = (over: Partial<AudioClip> & { id: string }): AudioClip => ({
  kind: "standalone", fileId: "f", startTime: 0, duration: TOTAL, trimStart: 0, volume: 1, enabled: true, ...over,
});

/** Export `clips` the way the backends do: shape tracks as extra inputs, one input per clip. */
async function exportClips(clips: AudioClip[], name: string): Promise<string> {
  const plan = planCrossfades(clips);
  const shapes = await renderClipShapeEnvelopes({ mixClips: clips, manifestClips: clips, plan, outDir: dir });
  const inputPaths = clips.map(() => music);
  const inputIndex = new Map(clips.map((c, i) => [c.id, i]));
  const gainEnvelopeIndex = new Map<string, number>();
  for (const [id, p] of shapes) {
    inputPaths.push(p);
    gainEnvelopeIndex.set(id, inputPaths.length - 1);
  }
  const { chain } = buildAudioMixGraph({
    baseAudio: null,
    clips,
    inputIndex,
    gainEnvelopeIndex,
    mixDuration: "longest",
    inputChannels: new Map(clips.map((_, i) => [i, 1])),
  });
  const out = path.join(dir, `${name}.wav`);
  ff([...inputPaths.flatMap((p) => ["-i", p]), "-filter_complex", chain!, "-map", "[aout]", "-t", String(TOTAL), out]);
  return out;
}

/**
 * The measured gain curve (dB, vs the un-processed source) of an export against
 * the evaluator, over every 100 ms window in [from, to]. Returns the largest
 * disagreement in dB.
 */
function maxDeviationDb(out: Float32Array, src: Float32Array, clips: AudioClip[], from: number, to: number): number {
  const plan = planCrossfades(clips);
  let worst = 0;
  for (let t = from; t + WINDOW <= to; t += WINDOW) {
    const expected = clips.reduce((sum, c) => sum + clipGainAt(c, plan, t + WINDOW / 2), 0);
    const measured = rms(out, t, t + WINDOW) / rms(src, t, t + WINDOW);
    // Skip windows where the expectation is near silence: a dB comparison there is noise.
    if (expected < 0.01) { expect(measured).toBeLessThan(0.03); continue; }
    worst = Math.max(worst, Math.abs(gainToDb(measured) - gainToDb(expected)));
  }
  return worst;
}

skipIf("export: clip gain, volume envelope and crossfade vs the preview's evaluator", () => {
  let src: Float32Array;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-clip-gain-"));
    music = path.join(dir, "music.wav");
    reference = path.join(dir, "reference.wav");
    ff(["-f", "lavfi", "-i", `sine=frequency=440:duration=${TOTAL}:sample_rate=44100`, "-af", "volume=0.3", "-ac", "1", music]);
    ff(["-i", music, "-af", "pan=stereo|c0=c0|c1=c0", reference]);
    src = samples(reference);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("gainDb boosts past what volume 1 allows: +6.02 dB doubles the amplitude", async () => {
    const out = await exportClips([clip({ id: "m", gainDb: 6.0206 })], "gain");
    expect(volume(out, 2, 12) - volume(reference, 2, 12)).toBeCloseTo(6.02, 1);
    expect(maxDeviationDb(samples(out), src, [clip({ id: "m", gainDb: 6.0206 })], 1, TOTAL - 1)).toBeLessThan(0.1);
  });

  it("gainDb combines with volume multiplicatively", async () => {
    const c = clip({ id: "m", volume: 0.5, gainDb: 6.0206 });
    const out = await exportClips([c], "gain-volume");
    expect(volume(out, 2, 12) - volume(reference, 2, 12)).toBeCloseTo(0, 1);
  });

  it("a volume envelope dips by 12 dB over a range and comes back, matching the evaluator window by window", async () => {
    const c = clip({
      id: "m",
      gainDb: 4,
      volumeKeyframes: { keyframes: [{ t: 3, value: 0 }, { t: 4, value: -12, easing: "linear" }, { t: 8, value: -12 }, { t: 10, value: 0, easing: "ease-in-out" }] },
    });
    const out = await exportClips([c], "envelope");
    // The plateau sits 12 dB under the un-dipped level, which is +4 over the source.
    expect(volume(out, 5, 7.5) - volume(reference, 5, 7.5)).toBeCloseTo(4 - 12, 1);
    expect(volume(out, 0.5, 2.5) - volume(reference, 0.5, 2.5)).toBeCloseTo(4, 1);
    expect(volume(out, 11, 13.5) - volume(reference, 11, 13.5)).toBeCloseTo(4, 1);
    expect(maxDeviationDb(samples(out), src, [c], 0.5, TOTAL - 0.5)).toBeLessThan(0.3);
  });

  it("composes with the in/out fades the clip already had", async () => {
    const c = clip({
      id: "m",
      volumeKeyframes: { keyframes: [{ t: 0, value: -6 }, { t: 10, value: 3 }] },
      effects: { in: { effectId: "audio-fade-in", durationMs: 2000 }, out: { effectId: "audio-fade-out", durationMs: 2000 } },
    });
    const out = await exportClips([c], "envelope-fades");
    expect(maxDeviationDb(samples(out), src, [c], 0.3, TOTAL - 0.3)).toBeLessThan(0.5);
  });

  it("keeps the envelope when the clip is placed later on the timeline and trimmed into its source", async () => {
    const c = clip({
      id: "m", startTime: 2, duration: 8, trimStart: 3,
      volumeKeyframes: { keyframes: [{ t: 2, value: 0 }, { t: 3, value: -12 }, { t: 6, value: -12 }, { t: 7, value: 0 }] },
    });
    const out = await exportClips([c], "envelope-placed");
    const o = samples(out);
    // Envelope time is the clip's own: the dip is at 4..8 on the timeline. The source is a steady tone,
    // so the level is comparable to the reference at any offset.
    const level = (a: number, b: number) => 20 * Math.log10(rms(o, a, b) / rms(src, 0, 1));
    expect(level(5, 7.5)).toBeCloseTo(-12, 0);
    expect(level(2.2, 3.7)).toBeGreaterThan(-3);
    expect(level(8.5, 9.8)).toBeGreaterThan(-3);
    expect(rms(o, 0.2, 1.8)).toBeLessThan(0.001); // before the clip: silence
  });

  it("stacks with a duck: the envelope's level before the voice, the duck's reduction on top of it during", async () => {
    const vo = path.join(dir, "vo.wav");
    ff(["-f", "lavfi", "-i", "anoisesrc=color=white:amplitude=0.7:duration=3:sample_rate=44100", "-ac", "1", vo]);
    const duck = { sidechainClipIds: ["vo"], thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 };
    const c = clip({ id: "m", duck, volumeKeyframes: { keyframes: [{ t: 0, value: -6 }] } });
    const plan = planCrossfades([c]);
    const shapes = await renderClipShapeEnvelopes({ mixClips: [c], manifestClips: [c], plan, outDir: dir });
    const ducks = await renderDuckEnvelopes({
      inputs: [{ clipId: "m", duck, sidechains: [{ path: vo, startTime: 6, trimStart: 0, duration: 3, volume: 1 }] }],
      timelineSeconds: TOTAL,
      outDir: dir,
    });
    const { chain } = buildAudioMixGraph({
      baseAudio: null, clips: [c], inputIndex: new Map([["m", 0]]), mixDuration: "longest", inputChannels: new Map([[0, 1]]),
      gainEnvelopeIndex: new Map([["m", 1]]), envelopeIndex: new Map([["m", 2]]),
    });
    const out = path.join(dir, "shape-and-duck.wav");
    ff(["-i", music, "-i", shapes.get("m")!, "-i", ducks.get("m")!, "-filter_complex", chain!, "-map", "[aout]", "-t", String(TOTAL), out]);
    expect(volume(out, 1, 5) - volume(reference, 1, 5)).toBeCloseTo(-6, 1); // the envelope alone, before the voice
    expect(volume(out, 7, 8.5) - volume(reference, 7, 8.5)).toBeLessThan(-6 - 5); // and the duck on top of it
    expect(volume(out, 11, 13) - volume(reference, 11, 13)).toBeCloseTo(-6, 1); // released again
  });

  it("crossfades two clips of one file: B in as A out over the overlap, no dip at the join", async () => {
    // A plays 0..8; B starts at 7.92 (an 80 ms overlap) and crossfades over it.
    const a = clip({ id: "a", startTime: 0, duration: 8 });
    const b = clip({ id: "b", startTime: 7.92, duration: 6, trimStart: 1, crossfadeMs: 80 });
    const out = await exportClips([a, b], "crossfade");
    const o = samples(out);
    // The same tone in both halves is coherent here (a sine at one phase per file offset), so just
    // compare against the evaluator: the sum of the two clips' gains, each applied to its own source.
    const plain = await exportClips([clip({ id: "a", startTime: 0, duration: 8 })], "crossfade-a-only");
    const aOnly = samples(plain);
    // Before the overlap B is silent and A is whole; after it A is gone and B is whole.
    expect(Math.abs(rms(o, 6, 7.8) / rms(aOnly, 6, 7.8) - 1)).toBeLessThan(0.02);
    expect(rms(o, 9, 13) / rms(src, 0, 4)).toBeGreaterThan(0.97);
    expect(rms(o, 9, 13) / rms(src, 0, 4)).toBeLessThan(1.03);
    // Up to the window A is whole; B has not started.
    expect(rms(o, 7.8, 7.9) / rms(aOnly, 7.8, 7.9)).toBeGreaterThan(0.97);
  });
});
