/**
 * Integration (real mediabunny, real ffmpeg): AAC and MP3 in Matroska, where
 * each run's audio starts (lib/audio/packet-grid.ts). Review round 4: the
 * preview placed a run by its first packet's whole-ms time, up to 0.5 ms off
 * ffmpeg's decode (measured ±0.33 ms on AAC in MKV, −0.02 on MP3). ffmpeg
 * plays the samples back to back from its first kept sample, which it stamps
 * at the first packet's whole-ms time plus the whole-ms CodecDelay; the
 * packets are the EXACT priming before that. Every packet must land there.
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
import { audioTimelineShift, originFromTiming } from "@/lib/engine/source-time-origin";
import { gridShift, matroskaPacketGrid } from "@/lib/audio/packet-grid";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

skipIf("AAC and MP3 in Matroska: every run on ffmpeg's sample (real files, review round 4)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-mkv-grid-"));
    const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });
    const SWEEP = (sr: number) => ["-f", "lavfi", "-i", `aevalsrc=0.3*sin(2*PI*(200+300*t)*t):s=${sr}:d=5`];
    ff([...SWEEP(48000), "-c:a", "aac", path.join(dir, "aac48.mkv")]);
    ff([...SWEEP(44100), "-c:a", "aac", path.join(dir, "aac44.mkv")]);
    ff([...SWEEP(48000), "-c:a", "libmp3lame", path.join(dir, "mp3.mkv")]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each(["aac48.mkv", "aac44.mkv", "mp3.mkv"])("%s", async (name) => {
    const file = path.join(dir, name);
    const t = (await fileTiming(file))!;
    expect(t.audioCodecDelay).toBeGreaterThan(0);
    expect(t.audioPadding).toBeGreaterThan(0);
    const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
    const [track] = await input.getAudioTracks();
    const grid = (await matroskaPacketGrid(track))!;
    expect(grid).not.toBeNull();
    const rate = track.sampleRate;
    // ffmpeg's first kept sample, and where the packets truly are from it.
    const firstFrame = parseFloat(
      execFileSync(resolveFfprobePath(), ["-v", "error", "-select_streams", "a:0", "-read_intervals", "%+0.5", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file])
        .toString().trim().split("\n")[0],
    );
    const origin = (originFromTiming(t) ?? 0) + audioTimelineShift(await track.getCodec(), t);
    const packets = new EncodedPacketSink(track);
    let p = await packets.getFirstPacket({ metadataOnly: true });
    let worstRaw = 0;
    for (let k = 0; p; k++, p = await packets.getNextPacket(p, { metadataOnly: true })) {
      const exact = firstFrame - t.audioPadding + k * grid.frame; // on the file's timeline
      const placed = p.timestamp + gridShift(grid, p.timestamp, t) - origin;
      expect(placed).toBeCloseTo(exact, 7);
      worstRaw = Math.max(worstRaw, Math.abs(p.timestamp - origin - exact));
    }
    // Unsnapped, the whole-ms times are off by a fraction of a ms.
    expect(worstRaw).toBeGreaterThan(0.00001);
    expect(worstRaw).toBeLessThanOrEqual(0.0005 + 1e-9);
    // The grid is the codec's frame.
    expect(Math.round(grid.frame * rate)).toBe(name.startsWith("mp3") ? 1152 : 1024);
  });
});
