/**
 * Integration (real ffmpeg for the duck): `libi.audio_analyze` report: per clip, the effective gain
 * curve over a range, equal to the clip-gain evaluator's numbers, with the duck taken from the real
 * duck track and the nearly-silent spans named with their cause.
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

import { reportClipGain } from "@/lib/export/audio-report";

const PIECE = "p-report";
const file = (id: string, filename: string): FileRecord => ({ id, pieceId: PIECE, filename, name: filename, size: 1, mediaDuration: null } as unknown as FileRecord);
const FILES = [file("f-music", "music.wav"), file("f-vo", "vo.wav"), file("f-mute", "mute.mp4")];
const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { stdio: "ignore", timeout: 60_000 });
const clip = (over: Partial<AudioClip> & { id: string }): AudioClip => ({
  kind: "standalone", fileId: "f-music", startTime: 0, duration: 30, trimStart: 0, volume: 1, enabled: true, ...over,
});
const manifest = (audioClips: AudioClip[], overlays: Overlay[] = []) => ({ overlays, audioClips });
const db = (g: number) => 20 * Math.log10(g);

skipIf("libi.audio_analyze report: the effective gain curve of each clip over a range", () => {
  beforeAll(() => {
    tempDir = createTempStorageDir();
    const dir = path.join(tempDir, PIECE);
    fs.mkdirSync(dir, { recursive: true });
    ff(["-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*1000*t):s=44100:d=30:c=mono", path.join(dir, "music.wav")]);
    ff(["-f", "lavfi", "-i", "anoisesrc=color=white:amplitude=0.7:duration=3:sample_rate=44100", "-ac", "1", path.join(dir, "vo.wav")]);
    ff(["-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "mute.mp4")]); // no audio stream
  });
  afterAll(() => cleanupTempDir(tempDir));

  it("a plain clip is 0 dB across the range; times are inside the clip and include its edges", async () => {
    const r = await reportClipGain({ manifest: manifest([clip({ id: "m", startTime: 2, duration: 8 })]), files: FILES, from: 0, to: 20, step: 2 });
    const c = r.clips[0];
    expect(c.t[0]).toBe(2);
    expect(c.t.at(-1)).toBe(10);
    expect(new Set(c.outDb)).toEqual(new Set([0]));
    expect(c.level).toEqual({ volume: 1, staticDb: 0 });
    expect(c.quiet).toBeUndefined();
    expect(c.duck).toBeUndefined();
    expect(c.minDb).toBe(0);
  });

  it("gain, envelope and fades equal the evaluator at every sample; a dip to -60 is a quiet span that names the envelope", async () => {
    const m = clip({
      id: "m", label: "bed", gainDb: 4, volume: 0.8,
      volumeKeyframes: { keyframes: [{ t: 0, value: 0 }, { t: 10, value: -60, easing: "linear" }, { t: 14, value: -60 }, { t: 16, value: 0, easing: "linear" }] },
      effects: { out: { effectId: "audio-fade-out", durationMs: 2000 } },
    });
    const r = await reportClipGain({ manifest: manifest([m]), files: FILES, from: 5, to: 25, step: 1 });
    const c = r.clips[0];
    expect(c.label).toBe("bed");
    const plan = crossfadePlan([m]);
    c.t.forEach((t, i) => expect(Math.abs(c.gainDb[i] - Math.max(-90, db(clipGainAt(m, plan, t))))).toBeLessThan(0.11));
    expect(c.level.gainDb).toBe(4);
    expect(c.level.envelopeKeys).toBe(4);
    expect(c.level.fadeOutMs).toBe(2000);
    expect(c.quiet).toHaveLength(1);
    const q = c.quiet![0];
    // 2.1 dB (gain + volume) - 6 dB/s of the ramp reaches -40 dB at 7.0 s.
    expect(q.from).toBeGreaterThan(6.8);
    expect(q.from).toBeLessThan(7.4);
    expect(q.to).toBeGreaterThan(14);
    expect(q.to).toBeLessThan(15);
    expect(q.causes.join(" ")).toMatch(/volume envelope -?\d+(\.\d)? dB/);
    expect(c.minDb).toBeLessThanOrEqual(-40);
  });

  it("a duck is read from the real duck track: ~-12 dB while the narration speaks, 0 before, and out = gain + duck", async () => {
    const duck = { sidechainClipIds: ["vo"], thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 };
    const r = await reportClipGain({
      manifest: manifest([clip({ id: "m", duck, gainDb: 3 }), clip({ id: "vo", fileId: "f-vo", startTime: 10, duration: 3 })]),
      files: FILES, from: 5, to: 20, step: 0.5,
    });
    const m = r.clips.find((c) => c.clipId === "m")!;
    const at = (t: number) => m.t.indexOf(t);
    expect(m.duckDb![at(6)]).toBeCloseTo(0, 0);
    expect(m.duckDb![at(11.5)]).toBeLessThan(-10.5);
    expect(m.duckDb![at(11.5)]).toBeGreaterThan(-13.5);
    expect(m.duckDb![at(18)]).toBeCloseTo(0, 0);
    m.t.forEach((_, i) => expect(Math.abs(m.outDb[i] - (m.gainDb[i] + m.duckDb![i]))).toBeLessThan(0.21));
    expect(m.duck!.sidechains).toEqual(["vo"]);
    expect(m.duck!.status).toMatch(/actual level/);
    // The narration itself is a clip of the report, unducked.
    expect(r.clips.find((c) => c.clipId === "vo")!.duckDb).toBeUndefined();
  });

  it("a duck whose sidechain is not in the mix says it plays UNDUCKED, and names the missing clip", async () => {
    const duck = { sidechainClipIds: ["vo"], thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 };
    const r = await reportClipGain({
      manifest: manifest([clip({ id: "m", duck }), clip({ id: "vo", fileId: "f-vo", startTime: 10, duration: 3, enabled: false })]),
      files: FILES, from: 5, to: 20,
    });
    const m = r.clips.find((c) => c.clipId === "m")!;
    expect(m.duckDb).toBeUndefined();
    expect(m.duck!.status).toMatch(/UNDUCKED/);
    expect(m.duck!.missing).toEqual(["vo"]);
    expect(r.silentClips).toEqual([expect.objectContaining({ clipId: "vo", because: expect.stringMatching(/disabled/) })]);
  });

  it("a crossfade: the earlier clip is quiet after its window, and says crossfade", async () => {
    const a = clip({ id: "a", startTime: 0, duration: 15 });
    const b = clip({ id: "b", startTime: 9, duration: 11, trimStart: 9, crossfadeMs: 1000 });
    const r = await reportClipGain({ manifest: manifest([a, b]), files: FILES, from: 0, to: 20, step: 1 });
    const ra = r.clips.find((c) => c.clipId === "a")!;
    expect(ra.quiet![0].from).toBeGreaterThanOrEqual(9.9);
    expect(ra.quiet![0].to).toBeCloseTo(15, 0);
    expect(ra.quiet![0].causes[0]).toMatch(/crossfade/);
    expect(ra.level.crossfadeMs).toBeUndefined();
    expect(r.clips.find((c) => c.clipId === "b")!.level.crossfadeMs).toBe(1000);
  });

  it("names why a clip that should sound does not: hidden layer, no audio stream, disabled", async () => {
    const video = { id: "o1", kind: "video", fileId: "f-music", hidden: true } as unknown as Overlay;
    const r = await reportClipGain({
      manifest: manifest(
        [clip({ id: "hid", kind: "inline", linkedOverlayId: "o1" }), clip({ id: "mute", fileId: "f-mute", duration: 3 }), clip({ id: "off", enabled: false }), clip({ id: "ok" })],
        [video],
      ),
      files: FILES, from: 0, to: 3,
    });
    const why = Object.fromEntries((r.silentClips ?? []).map((s) => [s.clipId, s.because]));
    expect(why.hid).toMatch(/hidden/);
    expect(why.mute).toMatch(/no audio stream/);
    expect(why.off).toMatch(/disabled/);
    expect(r.clips.map((c) => c.clipId)).toEqual(["ok"]);
  });

  it("an empty range says so; a bad range is refused; a long one too", async () => {
    const empty = await reportClipGain({ manifest: manifest([clip({ id: "m", duration: 5 })]), files: FILES, from: 10, to: 12 });
    expect(empty.clips).toEqual([]);
    expect(empty.note).toMatch(/No audio clip/);
    await expect(reportClipGain({ manifest: manifest([]), files: FILES, from: 5, to: 5 })).rejects.toThrow(/not valid/);
    await expect(reportClipGain({ manifest: manifest([]), files: FILES, from: 0, to: 601 })).rejects.toThrow(/at most 600/);
  });

  it("caps the printed points: a wide range widens the step", async () => {
    const r = await reportClipGain({ manifest: manifest([clip({ id: "m", duration: 300 })]), files: FILES, from: 0, to: 300, step: 0.5 });
    expect(r.step).toBeGreaterThanOrEqual(2.5);
    expect(r.clips[0].t.length).toBeLessThanOrEqual(125);
  });
});
