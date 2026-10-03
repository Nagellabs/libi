/**
 * Integration (real ffmpeg): `libi.audio_analyze` measure renders the mix THROUGH THE EXPORT PATH and
 * reads levels off it. Generated tones of known level: a 1 kHz sine at peak -20 dBFS reads -20 LUFS,
 * RMS -23 dB, peak -20 dB; gain, an envelope, a duck and a crossfade must each move that by what the
 * clip-gain evaluator / duck law say (the same numbers the preview plays).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";
import { LocalFileStorage } from "@/lib/storage/local";
import { clipGainAt, crossfadePlan } from "@/lib/audio/clip-gain";
import type { AudioClip, Overlay } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { measureAudio, audioMixHash, checkRanges } from "@/lib/export/audio-measure";

const PIECE = "p-measure";
const TONE_DB = -20; // peak dBFS of the music tone
const file = (id: string, filename: string): FileRecord => ({ id, pieceId: PIECE, filename, name: filename, size: 1, mediaDuration: null } as unknown as FileRecord);
const FILES = [file("f-music", "music.wav"), file("f-vo", "vo.wav")];

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { stdio: "ignore", timeout: 60_000 });
}

const clip = (over: Partial<AudioClip> & { id: string }): AudioClip => ({
  kind: "standalone", fileId: "f-music", startTime: 0, duration: 30, trimStart: 0, volume: 1, enabled: true, ...over,
});

/** The envelope-law level over [from, to] as RMS dB relative to a steady tone: 10 log10(mean g^2). */
function expectedDbOver(c: AudioClip, clips: AudioClip[], from: number, to: number): number {
  const plan = crossfadePlan(clips);
  let sum = 0;
  let n = 0;
  for (let t = from; t < to; t += 0.001) { const g = clipGainAt(c, plan, t); sum += g * g; n++; }
  return 10 * Math.log10(sum / n);
}

skipIf("libi.audio_analyze measure: the mix, through the export path (real ffmpeg)", () => {
  beforeAll(() => {
    tempDir = createTempStorageDir();
    const dir = path.join(tempDir, PIECE);
    fs.mkdirSync(dir, { recursive: true });
    // Music: a 1 kHz tone, mono, peak TONE_DB. Narration: loud noise.
    ff(["-f", "lavfi", "-i", `aevalsrc=${Math.pow(10, TONE_DB / 20)}*sin(2*PI*1000*t):s=44100:d=30:c=mono`, path.join(dir, "music.wav")]);
    ff(["-f", "lavfi", "-i", "anoisesrc=color=white:amplitude=0.7:duration=3:sample_rate=44100", "-ac", "1", path.join(dir, "vo.wav")]);
  });
  afterAll(() => cleanupTempDir(tempDir));

  it("reads a -20 dBFS 1 kHz tone as -20 LUFS, RMS -23 dB, peak -20 dB (mono music on both sides at unity)", async () => {
    const r = await measureAudio({ audioClips: [clip({ id: "m" })], files: FILES, ranges: [{ from: 5, to: 15 }] });
    const m = r.ranges[0];
    expect(m.lufs!).toBeGreaterThan(-20.2);
    expect(m.lufs!).toBeLessThan(-19.8);
    expect(m.rmsDb).toBeCloseTo(-23.0, 0);
    expect(m.peakDb).toBeCloseTo(-20, 0);
    expect(m.silent).toBe(false);
    expect(m.shortTermMaxLufs!).toBeCloseTo(m.lufs!, 0);
  });

  it("gainDb and volume move the level by what the law says: +6.02 dB, and x0.5 undoes it", async () => {
    const boosted = await measureAudio({ audioClips: [clip({ id: "m", gainDb: 6.0206 })], files: FILES, ranges: [{ from: 5, to: 15 }] });
    expect(boosted.ranges[0].peakDb).toBeCloseTo(-14, 0);
    expect(boosted.ranges[0].lufs!).toBeCloseTo(-14, 0);
    const both = await measureAudio({ audioClips: [clip({ id: "m", gainDb: 6.0206, volume: 0.5 })], files: FILES, ranges: [{ from: 5, to: 15 }] });
    expect(both.ranges[0].peakDb).toBeCloseTo(-20, 0);
  });

  it("an envelope: the plateau sits where the evaluator says, and a ramp range matches the evaluator's mean power", async () => {
    const m = clip({
      id: "m",
      gainDb: 2,
      volumeKeyframes: { keyframes: [{ t: 0, value: 0 }, { t: 4, value: -12, easing: "linear" }, { t: 8, value: -12 }, { t: 10, value: 0, easing: "ease-in-out" }] },
    });
    const r = await measureAudio({ audioClips: [m], files: FILES, ranges: [{ from: 5, to: 7.5 }, { from: 1, to: 3.5 }, { from: 8.2, to: 9.8 }, { from: 12, to: 20 }] });
    const [plateau, ramp, back, tail] = r.ranges;
    expect(plateau.rmsDb).toBeCloseTo(-23 + 2 - 12, 0);
    expect(ramp.rmsDb).toBeCloseTo(-23 + expectedDbOver(m, [m], 1, 3.5), 0);
    expect(Math.abs(ramp.rmsDb - (-23 + expectedDbOver(m, [m], 1, 3.5)))).toBeLessThan(0.3);
    expect(Math.abs(back.rmsDb - (-23 + expectedDbOver(m, [m], 8.2, 9.8)))).toBeLessThan(0.3);
    expect(tail.rmsDb).toBeCloseTo(-23 + 2, 0);
  });

  it("a duck: per clip, the music drops by the duck's reduction while the narration speaks, and not before", async () => {
    const duck = { sidechainClipIds: ["vo"], thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 };
    const music = clip({ id: "m", duck });
    const vo = clip({ id: "vo", fileId: "f-vo", startTime: 10, duration: 3 });
    const r = await measureAudio({
      audioClips: [music, vo], files: FILES, per: "clip",
      ranges: [{ from: 2, to: 8 }, { from: 11, to: 12.5 }],
    });
    const [before, during] = r.ranges;
    const musicBefore = before.clips!.find((c) => c.clipId === "m")!;
    const musicDuring = during.clips!.find((c) => c.clipId === "m")!;
    expect(musicBefore.rmsDb).toBeCloseTo(-23, 0);
    expect(musicDuring.rmsDb).toBeLessThan(-23 - 10.5);
    expect(musicDuring.rmsDb).toBeGreaterThan(-23 - 13.5);
    // The narration is not on in the first range, and is the loud thing in the second.
    expect(before.clips!.map((c) => c.clipId)).toEqual(["m"]);
    const voDuring = during.clips!.find((c) => c.clipId === "vo")!;
    expect(voDuring.rmsDb).toBeGreaterThan(-12);
    // The mix of the second range is the narration plus the ducked bed.
    expect(during.rmsDb).toBeGreaterThanOrEqual(voDuring.rmsDb - 0.5);
  });

  it("a crossfade is in the measure: two coherent halves of one tone hold the level through the overlap; without it they sum to +6 dB", async () => {
    const a = clip({ id: "a", startTime: 0, duration: 10, trimStart: 0 });
    const b = clip({ id: "b", startTime: 9, duration: 11, trimStart: 9, crossfadeMs: 1000 });
    const withFade = await measureAudio({ audioClips: [a, b], files: FILES, ranges: [{ from: 9.1, to: 9.9 }, { from: 12, to: 15 }] });
    expect(Math.abs(withFade.ranges[0].rmsDb - (-23))).toBeLessThan(0.7);
    expect(withFade.ranges[1].rmsDb).toBeCloseTo(-23, 0);
    const without = await measureAudio({ audioClips: [a, { ...b, crossfadeMs: 0 }], files: FILES, ranges: [{ from: 9.1, to: 9.9 }] });
    expect(without.ranges[0].rmsDb).toBeCloseTo(-23 + 6.02, 0);
  });

  it("reports silence where nothing sounds, past the end of the audio, and for a disabled clip", async () => {
    const m = clip({ id: "m", duration: 10 });
    const r = await measureAudio({ audioClips: [m], files: FILES, ranges: [{ from: 12, to: 14 }, { from: 5, to: 6 }] });
    expect(r.ranges[0].silent).toBe(true);
    expect(r.ranges[0].lufs).toBeNull();
    expect(r.ranges[0].rmsDb).toBe(-90);
    expect(r.ranges[1].silent).toBe(false);
    const off = await measureAudio({ audioClips: [{ ...m, enabled: false }], files: FILES, ranges: [{ from: 1, to: 3 }] });
    expect(off.ranges[0].silent).toBe(true);
    expect(off.note).toMatch(/Nothing is in the mix/);
  });

  it("per clip, a clipId that is not in the mix is named, not measured", async () => {
    const r = await measureAudio({ audioClips: [clip({ id: "m" })], files: FILES, per: "clip", clipIds: ["m", "ghost"], ranges: [{ from: 1, to: 3 }] });
    expect(r.ranges[0].clips!.map((c) => c.clipId)).toEqual(["m"]);
    expect(r.clipsNotMeasured).toEqual([{ clipId: "ghost", why: expect.stringContaining("not in the mix") }]);
  });

  it("reports progress up to 1", async () => {
    const ticks: number[] = [];
    await measureAudio({ audioClips: [clip({ id: "m" })], files: FILES, ranges: [{ from: 1, to: 3 }], onProgress: (x) => ticks.push(x) });
    expect(ticks.at(-1)).toBe(1);
  });
});

describe("checkRanges", () => {
  it("refuses empty, backwards, negative, too many and too long", () => {
    expect(checkRanges([])).toMatch(/empty/);
    expect(checkRanges([{ from: 5, to: 5 }])).toMatch(/not valid/);
    expect(checkRanges([{ from: -1, to: 5 }])).toMatch(/not valid/);
    expect(checkRanges(Array.from({ length: 9 }, (_, i) => ({ from: i, to: i + 1 })))).toMatch(/at most 8/);
    expect(checkRanges([{ from: 0, to: 1 }, { from: 900, to: 901 }])).toMatch(/at most 600/);
    expect(checkRanges([{ from: 0, to: 10 }, { from: 20, to: 30 }])).toBeNull();
  });
});

describe("audioMixHash: the cache key of a measure", () => {
  const files = [{ id: "f-music", filename: "music.wav", size: 10, mediaDuration: 30 }, { id: "f-vo", filename: "vo.wav", size: 5, mediaDuration: 3 }];
  const overlays = [] as unknown as Overlay[];
  const base = [clip({ id: "m" }), clip({ id: "vo", fileId: "f-vo", startTime: 10, duration: 3 })];
  const hash = (audioClips: AudioClip[], f = files, o = overlays) => audioMixHash({ overlays: o, audioClips }, f);

  it("is the same for the same audio, whatever the clip order or the key order", () => {
    expect(hash(base)).toBe(hash([...base].reverse()));
    expect(hash(base)).toBe(hash(base.map((c) => ({ ...c }))));
  });
  it("changes with a gain, an envelope, a duck, a time, a disabled flag, or a different file", () => {
    const h = hash(base);
    expect(hash([{ ...base[0], gainDb: 3 }, base[1]])).not.toBe(h);
    expect(hash([{ ...base[0], volumeKeyframes: { keyframes: [{ t: 1, value: -6 }] } }, base[1]])).not.toBe(h);
    expect(hash([{ ...base[0], duck: { sidechainClipIds: ["vo"], thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 } }, base[1]])).not.toBe(h);
    expect(hash([base[0], { ...base[1], startTime: 11 }])).not.toBe(h);
    expect(hash([base[0], { ...base[1], enabled: false }])).not.toBe(h);
    expect(hash(base, [{ ...files[0], size: 11 }, files[1]])).not.toBe(h);
  });
  it("ignores files no clip reads, and a hidden layer's inline sound (the export drops it)", () => {
    const h = hash(base);
    expect(hash(base, [...files, { id: "f-other", filename: "x.wav", size: 1, mediaDuration: 1 }])).toBe(h);
    const video = { id: "o1", kind: "video", fileId: "f-music", hidden: true } as unknown as Overlay;
    const inline = clip({ id: "i", kind: "inline", linkedOverlayId: "o1" });
    expect(hash([...base, inline], files, [video])).toBe(h);
    expect(hash([...base, inline], files, [{ ...video, hidden: false } as Overlay])).not.toBe(h);
  });
});
