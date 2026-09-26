/**
 * Integration (real ffmpeg, real ffprobe, real mediabunny): the preview's
 * origin and audio shift for an MP4 stream-copied at a non-keyframe, which is
 * exactly what libi's own `trim_video` makes (review round 2, C1).
 *
 * Such a file carries an edit list: ffmpeg starts it at 0 and hides the
 * pre-roll packets before the cut, while mediabunny lists them (its first
 * audio packet is ~0.3 s earlier than ffmpeg's). The two demuxers agree on
 * every packet they both list. The round-1 shift compared their FIRST
 * packets, took that 0.3 s for an encoder delay, and played the audio 302 ms
 * late (measured in Electron 36). The shift now comes only from a Matroska
 * CodecDelay in the file's own metadata, so here it is 0 and the origin is 0.
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
import { primaryAudioTrack } from "@/lib/engine/primary-track";
import { audioTimelineShift, fallbackOrigin, originFromTiming } from "@/lib/engine/source-time-origin";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

skipIf("an MP4 cut the way trim_video cuts it (real ffmpeg + mediabunny)", () => {
  let dir: string;
  let cut: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-cut-origin-"));
    const src = path.join(dir, "src.mp4");
    cut = path.join(dir, "src-trim.mp4");
    const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });
    ff(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=25:d=8",
      "-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*(200+300*t)*t):s=44100:d=8:c=mono",
      "-c:v", "libx264", "-g", "50", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
    // mcp/tools/ffmpeg-tools.ts trim_video: -ss/-to before -i, -c copy, +faststart.
    ff(["-ss", "1.3", "-to", "5.3", "-i", src, "-c", "copy", "-movflags", "+faststart", cut]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("mediabunny lists audio packets ffmpeg hides (the trap), and libi's origin and shift are both 0", async () => {
    const ffFirst = Number(
      execFileSync(resolveFfprobePath(), ["-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time",
        "-read_intervals", "%+#1", "-of", "csv=p=0", cut]).toString().split(",")[0],
    );
    const probed = await probeMedia(cut);
    const timing = {
      startTime: probed.startTime ?? null, audioCodecDelay: probed.audioCodecDelay ?? 0,
      audioStart: probed.audioStart ?? null, oggFirstPacket: null, oggFirstPacketDuration: 0,
    };

    const input = new Input({ source: new FilePathSource(cut), formats: ALL_FORMATS });
    try {
      const track = (await primaryAudioTrack(input))!;
      const mbFirst = (await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true }))!.timestamp;
      expect(ffFirst - mbFirst).toBeGreaterThan(0.1); // what round 1 mistook for an encoder delay

      expect(originFromTiming(timing) ?? (await fallbackOrigin(input))).toBe(0);
      expect(audioTimelineShift(await track.getCodec(), timing)).toBe(0);
    } finally {
      input.dispose();
    }
  });
});
