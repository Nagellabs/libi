/**
 * Integration (real mediabunny, real ffprobe): where the preview places each
 * Opus run, against where ffmpeg (and so the export) has it. Review round 3:
 *
 * - R3-C1: an Opus track that starts after its file. A browser recording
 *   (Chrome MediaRecorder, `mr-late-opus.webm`: the video from 0, the Opus
 *   track 0.348 s in, pre-skip 0) was placed as if its first packet started
 *   at the file's start: the voice ran 343 ms ahead of the picture. Its first
 *   run must start where the track does, and every later run on the grid of
 *   its 60 ms frames (MediaRecorder stamps them ±2 ms off).
 * - R3-M4: mediabunny reads an Ogg stream from its start as if its granules
 *   began at 0, and after a seek past the second page from the real granules.
 *   An Ogg cut (`-ss 1.3 -c copy`: ffmpeg starts it at −0.3 s) played 300 ms
 *   early after a seek, and an Ogg stream that starts after its file 400 ms
 *   late from its start. Every run must start where ffmpeg has that packet.
 *
 * Each run's start is checked against ffprobe's own time for the very packet
 * mediabunny's sink would decode from (matched by position in the stream).
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md (round 3)
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
import { opusSeekInfo, planOpusRun, SEEK_PREROLL_S, type OpusPlacement } from "@/lib/audio/opus-seek";
import { oggSeqShift } from "@/lib/audio/ogg-timeline";
import { primaryAudioTrack } from "@/lib/engine/primary-track";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

const MR = path.join(__dirname, "../fixtures/audio/mr-late-opus.webm");

/** ffprobe's packet times of the primary audio stream, in stream order. */
function ffPackets(file: string, stream: number): number[] {
  return execFileSync(resolveFfprobePath(), ["-v", "error", "-select_streams", String(stream), "-show_entries", "packet=pts_time", "-of", "csv=p=0", file])
    .toString().trim().split("\n").map((l) => parseFloat(l));
}

async function openOpus(file: string) {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  const track = (await primaryAudioTrack(input))!;
  const info = (await opusSeekInfo(track))!;
  // mediabunny's packets in stream order: sequence number → index.
  const index = new Map<number, number>();
  const walk = new EncodedPacketSink(track);
  let p = await walk.getFirstPacket({ metadataOnly: true });
  for (let i = 0; p; i++, p = await walk.getNextPacket(p, { metadataOnly: true })) index.set(p.sequenceNumber, i);
  return { input, track, info, index };
}

/** The placement the engine takes from `/timing` (web-audio-engine.ts placementFor). */
async function placement(file: string, info: { preSkip: number; ogg: unknown }): Promise<OpusPlacement> {
  const pr = await probeMedia(file);
  const startTime = pr.startTime ?? 0;
  if (info.ogg) {
    const seqShift = oggSeqShift(
      { startTime, oggFirstPacket: pr.oggFirstPacket ?? null, oggFirstPacketDuration: pr.oggFirstPacketDuration ?? 0 },
      -info.preSkip / 48000,
      false,
    );
    return { origin: startTime, audioLead: 0, seqShift };
  }
  return { origin: Math.max(0, startTime), audioLead: Math.max(0, pr.audioStart ?? 0), seqShift: 0 };
}

skipIf("Opus runs start where ffmpeg has them (real files, review round 3)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-opus-place-"));
    const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });
    const SWEEP = "aevalsrc=0.3*sin(2*PI*(200+300*t)*t):s=48000:d=6";
    ff(["-f", "lavfi", "-i", SWEEP, "-c:a", "libopus", path.join(dir, "full.ogg")]);
    ff(["-ss", "1.3", "-to", "5.3", "-i", path.join(dir, "full.ogg"), "-c", "copy", path.join(dir, "cut.ogg")]);
    ff(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=25:d=5", "-itsoffset", "0.4", "-f", "lavfi", "-i", SWEEP, "-t", "5",
      "-map", "0:v", "-map", "1:a", "-c:v", "libtheora", "-c:a", "libopus", path.join(dir, "lead.ogg")]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("R3-C1: a browser recording's Opus track starts 0.348 s after its video, and its first run starts there", async () => {
    const pr = await probeMedia(MR);
    expect(pr.videoLead).toBe(0);
    expect(pr.audioStart).toBeCloseTo(0.348, 3);
    const { input, info } = await openOpus(MR);
    expect(info.preSkip).toBe(0);
    const place = await placement(MR, info);
    const first = await planOpusRun(info, new EncodedPacketSink(info.noPreSkipTrack), 0, place);
    expect(first.decodeFrom + first.shift).toBeCloseTo(0.348, 3);
    // The bug: the first packet taken to start at the file's start put it 348 ms early.
    const wrong = await planOpusRun(info, new EncodedPacketSink(info.noPreSkipTrack), 0, { ...place, audioLead: 0 });
    expect(wrong.decodeFrom + wrong.shift).toBeCloseTo(0, 3);
    input.dispose();
  });

  it("R3-C1: every later run starts on the grid of the recording's 60 ms frames, whatever its stamp's jitter", async () => {
    const { input, info } = await openOpus(MR);
    expect(info.firstPacketSamples).toBe(2880);
    const place = await placement(MR, info);
    const packets = new EncodedPacketSink(info.noPreSkipTrack);
    let jittered = 0;
    for (const t of [0.5, 0.9, 1.2, 1.5, 1.8, 2.1]) {
      const plan = await planOpusRun(info, packets, t, place);
      const start = plan.decodeFrom + plan.shift;
      const n = (start - 0.348) / 0.06;
      expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-6);
      expect(start).toBeLessThanOrEqual(t - SEEK_PREROLL_S + 1e-9);
      if (Math.abs(plan.shift) > 1e-6) jittered++;
    }
    expect(jittered).toBeGreaterThan(0); // the file's stamps really do jitter
    input.dispose();
  });

  it.each([
    ["an Ogg cut (ffmpeg starts it at −0.3 s)", "cut.ogg"],
    ["an Ogg stream that starts 0.4 s after its file", "lead.ogg"],
    ["an ordinary Ogg file", "full.ogg"],
  ])("R3-M4: %s: every run starts where ffmpeg has its first packet", async (_label, name) => {
    const file = path.join(dir, name);
    const pr = await probeMedia(file);
    const ff = ffPackets(file, pr.primaryAudioStreamIndex!);
    const { input, info, index } = await openOpus(file);
    expect(info.ogg).not.toBeNull();
    const place = await placement(file, info);
    for (const source of [0, 0.3, 0.9, 1.5, 1.9, 2.3, 2.8, 3.4]) {
      const raw = source + place.origin; // the engine's `from`
      const plan = await planOpusRun(info, new EncodedPacketSink(info.noPreSkipTrack), raw, place);
      // The packet mediabunny's sink decodes from, as it would find it.
      const packet = await new EncodedPacketSink(info.noPreSkipTrack).getPacket(plan.decodeFrom, { metadataOnly: true });
      const i = index.get(packet!.sequenceNumber)!;
      expect(plan.decodeFrom + plan.shift, `${name} from ${source}`).toBeCloseTo(ff[i], 4);
      expect(ff[i]).toBeLessThanOrEqual(Math.max(raw, ff[0]) + 1e-9); // a target before the track: its first packet
    }
    input.dispose();
  });

  it("R3-M4: without the server's shift, the cut's runs before its second page were 0.3 s off", async () => {
    const file = path.join(dir, "cut.ogg");
    const pr = await probeMedia(file);
    const ff = ffPackets(file, pr.primaryAudioStreamIndex!);
    const { input, info, index } = await openOpus(file);
    const place = { ...(await placement(file, info)), seqShift: 0 };
    const plan = await planOpusRun(info, new EncodedPacketSink(info.noPreSkipTrack), 0.3 + place.origin, place);
    const packet = await new EncodedPacketSink(info.noPreSkipTrack).getPacket(plan.decodeFrom, { metadataOnly: true });
    expect(plan.decodeFrom + plan.shift - ff[index.get(packet!.sequenceNumber)!]).toBeCloseTo(0.3, 3);
    input.dispose();
  });
});
