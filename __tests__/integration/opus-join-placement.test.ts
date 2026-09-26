/**
 * Integration (real mediabunny, real ffmpeg): an Opus WebM joined from two
 * encodes by stream copy (`ffmpeg -f concat -c copy`). Review round 4: the
 * first encode's last packet carries a DiscardPadding that WebCodecs can't be
 * told about, so after the join the preview played 53.5 ms late (60 ms frames
 * joined to 20 ms ones) or 13.5 ms late (20 ms to 10 ms), and the frame-grid
 * snap put a same-size join 0.5 ms off.
 *
 * Every run must start, and every trim must fall, on the sample ffmpeg's own
 * decode has there: the sum of the samples it kept before (ffprobe's frames).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Input, FilePathSource, ALL_FORMATS, EncodedPacketSink } from "mediabunny";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";
import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { fileTiming } from "@/lib/ffmpeg/file-timing";
import { opusPacketSamples, opusSeekInfo, planOpusRun, type OpusPlacement } from "@/lib/audio/opus-seek";
import { primaryAudioTrack } from "@/lib/engine/primary-track";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

/** Samples ffmpeg keeps of each packet, and where each packet's kept audio starts (s from the first kept sample). */
function ffKept(file: string): number[] {
  const kept = execFileSync(resolveFfprobePath(), ["-v", "error", "-select_streams", "a:0", "-show_entries", "frame=nb_samples", "-of", "csv=p=0", file])
    .toString().trim().split("\n").map((l) => parseInt(l, 10));
  const starts: number[] = [];
  let at = 0;
  for (const n of kept) {
    starts.push(at / 48000);
    at += n;
  }
  return starts;
}

skipIf("an Opus WebM joined from two encodes: runs and trims on ffmpeg's samples (real files, review round 4)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-opus-join-"));
    const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });
    const SWEEP = (f: number) => `aevalsrc=0.3*sin(2*PI*(${f}+300*t)*t):s=48000:d=3`;
    const join = (name: string, a: number, b: number) => {
      ff(["-f", "lavfi", "-i", SWEEP(200), "-c:a", "libopus", "-frame_duration", String(a), path.join(dir, `${name}-1.webm`)]);
      ff(["-f", "lavfi", "-i", SWEEP(500), "-c:a", "libopus", "-frame_duration", String(b), path.join(dir, `${name}-2.webm`)]);
      fs.writeFileSync(path.join(dir, `${name}.txt`), `file '${name}-1.webm'\nfile '${name}-2.webm'\n`);
      ff(["-f", "concat", "-safe", "0", "-i", path.join(dir, `${name}.txt`), "-c", "copy", path.join(dir, `${name}.webm`)]);
    };
    join("mixed", 60, 20);
    join("mixed2", 20, 10);
    join("same", 20, 20);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each(["mixed", "mixed2", "same"])("%s.webm", async (name) => {
    const file = path.join(dir, `${name}.webm`);
    const t = (await fileTiming(file))!;
    // The join carries a trim (the stream's end one too).
    expect(t.opusTrims.length).toBeGreaterThanOrEqual(2);
    const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
    const track = (await primaryAudioTrack(input))!;
    const info = (await opusSeekInfo(track))!;
    // The engine's placement (web-audio-engine.ts placementFor).
    const place: OpusPlacement = {
      origin: Math.max(0, t.startTime ?? 0),
      audioLead: Math.max(0, t.audioStart ?? 0),
      seqShift: 0,
      skipsPreSkip: t.audioCodecDelay > 0,
      trims: t.opusTrims,
    };
    const firstKept = place.origin + place.audioLead;
    const packets = new EncodedPacketSink(info.noPreSkipTrack);
    const index = new Map<number, number>();
    let p = await packets.getFirstPacket({ metadataOnly: true });
    for (let i = 0; p; i++, p = await packets.getNextPacket(p, { metadataOnly: true })) index.set(p.timestamp, i);
    const kept = ffKept(file);

    for (const from of [0.5, 2.5, 3.01, 3.3, 5]) {
      const plan = await planOpusRun(info, packets, from + place.origin, place);
      const i = index.get(plan.decodeFrom)!;
      expect(plan.decodeFrom + plan.shift - firstKept).toBeCloseTo(kept[i], 6);
      const join = plan.trims.find((tr) => tr.at - firstKept > 2.5 && tr.at - firstKept < 3.5);
      if (from < 3) {
        // A run across the join cuts that packet as ffmpeg does, where ffmpeg has it.
        expect(join).toBeDefined();
        const at = join!.at - firstKept;
        const k = kept.findIndex((s) => Math.abs(s - at) < 1e-6);
        expect(k).toBeGreaterThan(0);
        expect(kept[k + 1] - kept[k]).toBeCloseTo((await packetLength(packets, k, index)) - join!.discard, 6);
      }
    }
    input.dispose?.();
  });
});

/** The full length (TOC) of the packet at stream index `k`, in seconds. */
async function packetLength(packets: EncodedPacketSink, k: number, index: Map<number, number>): Promise<number> {
  const ts = [...index.entries()].find(([, i]) => i === k)![0];
  const p = (await packets.getPacket(ts))!;
  return opusPacketSamples(p.data)! / 48000;
}
