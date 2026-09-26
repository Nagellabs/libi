/**
 * Integration (real mediabunny, real ffmpeg): where the preview places each
 * run of Vorbis in WebM / MKV (lib/audio/vorbis-run.ts), against ffmpeg's
 * decode. Review round 4: the preview played Vorbis in WebM 3 to 22 ms early.
 * A run's first packet decodes to no audio, yet the chunks were stamped from
 * it; and Matroska's whole-ms packet times put the audio up to 0.5 ms off its
 * sample. Every run's first audio must start on the exact sample ffmpeg
 * decodes it at: the sum of the decoded frames before it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Input, FilePathSource, ALL_FORMATS, EncodedPacketSink } from "mediabunny";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";
import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { audioTimelineShift } from "@/lib/engine/source-time-origin";
import { vorbisPacketGrid, vorbisRun } from "@/lib/audio/vorbis-run";
import { SEEK_PREROLL_S } from "@/lib/audio/opus-seek";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

/** Where ffmpeg's decode puts each frame: its first sample, exact (frame k is packet k+1's audio). */
function ffFrameStarts(file: string, sampleRate: number): number[] {
  const n = execFileSync(resolveFfprobePath(), ["-v", "error", "-select_streams", "a:0", "-show_entries", "frame=nb_samples", "-of", "csv=p=0", file])
    .toString().trim().split("\n").map((l) => parseInt(l, 10));
  const starts: number[] = [];
  let at = 0;
  for (const s of n) {
    starts.push(at / sampleRate);
    at += s;
  }
  return starts;
}

skipIf("Vorbis in Matroska: each run starts on ffmpeg's sample (real files, review round 4)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-vorbis-place-"));
    const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });
    const SWEEP = (sr: number) => `aevalsrc=0.3*sin(2*PI*(200+300*t)*t):s=${sr}:d=6`;
    ff(["-f", "lavfi", "-i", SWEEP(48000), "-c:a", "libvorbis", path.join(dir, "v48.webm")]);
    ff(["-f", "lavfi", "-i", SWEEP(44100), "-c:a", "libvorbis", path.join(dir, "v44.mkv")]);
    ff(["-f", "lavfi", "-i", SWEEP(22050), "-c:a", "libvorbis", path.join(dir, "v22.webm")]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each([
    ["v48.webm", 48000, 64],
    ["v44.mkv", 44100, 64],
    ["v22.webm", 22050, 128],
  ])("%s: the run's audio lands on ffmpeg's sample, from the start and after any seek", async (name, sampleRate, gridSamples) => {
    const file = path.join(dir, name);
    const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
    const [track] = await input.getAudioTracks();
    expect(await track.getCodec()).toBe("vorbis");
    const config = await track.getDecoderConfig();
    const grid = vorbisPacketGrid(config!.description, config!.sampleRate);
    expect(grid).toBeCloseTo(gridSamples / sampleRate, 12);

    // The engine's placement (web-audio-engine.ts placementFor), from the probe /timing serves.
    const pr = await probeMedia(file);
    expect(pr.audioCodecDelay ?? 0).toBeGreaterThan(0); // ffmpeg's libvorbis keeps its priming
    const origin = (pr.startTime ?? 0) + audioTimelineShift("vorbis", {
      startTime: pr.startTime ?? 0, audioCodecDelay: pr.audioCodecDelay ?? 0, audioStart: pr.audioStart ?? 0,
      oggFirstPacket: null, oggFirstPacketDuration: 0,
    });

    // mediabunny's packets in stream order.
    const packets = new EncodedPacketSink(track);
    const index = new Map<number, number>();
    let p = await packets.getFirstPacket({ metadataOnly: true });
    for (let i = 0; p; i++, p = await packets.getNextPacket(p, { metadataOnly: true })) index.set(p.timestamp, i);
    const frames = ffFrameStarts(file, sampleRate);

    let unsnappedOff = 0;
    for (const from of [0, 0.25, 0.5, 1, 1.234, 2.001, 2.5, 3.3, 4.07, 5.5]) {
      const run = (await vorbisRun(packets, from + origin - SEEK_PREROLL_S, origin, grid))!;
      const i = index.get(run.decodeFrom)!;
      // The run decodes from packet i; its audio is packet i+1's, ffmpeg's frame i.
      const exact = frames[i];
      expect(run.decodeFrom + run.shift - origin).toBeCloseTo(exact, 7);
      const raw = (await vorbisRun(packets, from + origin - SEEK_PREROLL_S, origin, null))!;
      unsnappedOff = Math.max(unsnappedOff, Math.abs(raw.decodeFrom + raw.shift - origin - exact));
      // Never after the time asked for: the pre-roll covers it.
      expect(run.decodeFrom + run.shift - origin).toBeLessThanOrEqual(from + 1e-9);
    }
    // Without the grid, the whole-ms packet times are off by a fraction of a ms.
    expect(unsnappedOff).toBeGreaterThan(0);
    expect(unsnappedOff).toBeLessThanOrEqual(0.0005 + 1e-9);
    input.dispose?.();
  });

  it("reads the grid only from well-formed Vorbis headers", () => {
    expect(vorbisPacketGrid(undefined, 48000)).toBeNull();
    expect(vorbisPacketGrid(new Uint8Array([1, 2, 3]), 48000)).toBeNull();
    expect(vorbisPacketGrid(new Uint8Array(64), 48000)).toBeNull();
  });
});
