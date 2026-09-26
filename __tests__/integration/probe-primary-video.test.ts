/**
 * Integration (real ffmpeg): probeMedia describes the video stream the
 * preview and the export use (the primary: the first `default`-flagged, else
 * the first real video), not merely the first video stream. Upload records
 * `files.has_alpha` and the size from it, and alpha gates the proxy
 * (proxy_gen refuses VPx alpha, `pickVideoUrl` serves the original), so the
 * answer must describe the stream that is actually played.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { alphaRecoverableInPreview } from "@/lib/ffmpeg/alpha";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore", timeout: 60_000 });
}

skipIf("probeMedia on files with two differing video streams (real ffmpeg)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-probe-primary-"));
    // An opaque H.264 64×64 stream and a VP9-alpha 48×32 stream, in both
    // default orders.
    for (const [name, defaults] of [["alpha-default.mkv", ["0", "default"]], ["opaque-default.mkv", ["default", "0"]]] as const) {
      ff(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=10:d=1",
        "-f", "lavfi", "-i", "color=c=red@0.5:s=48x32:r=10:d=1,format=yuva420p",
        "-map", "0:v", "-map", "1:v", "-c:v:0", "libx264", "-pix_fmt:v:0", "yuv420p",
        "-c:v:1", "libvpx-vp9", "-pix_fmt:v:1", "yuva420p",
        "-disposition:v:0", defaults[0], "-disposition:v:1", defaults[1], path.join(dir, name)]);
    }
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the alpha stream is primary: VP9, 48×32, has alpha, and alpha gating treats it as a VPx cutout", async () => {
    const p = await probeMedia(path.join(dir, "alpha-default.mkv"));
    expect(p).toMatchObject({ primaryVideoStreamIndex: 1, videoCodec: "vp9", width: 48, height: 32, hasAlpha: true });
    expect(alphaRecoverableInPreview({ hasAlpha: p.hasAlpha, videoCodec: p.videoCodec })).toBe(true);
  });

  it("the opaque stream is primary: H.264, 64×64, no alpha, so it gets a proxy as normal", async () => {
    const p = await probeMedia(path.join(dir, "opaque-default.mkv"));
    expect(p).toMatchObject({ primaryVideoStreamIndex: 0, videoCodec: "h264", width: 64, height: 64, hasAlpha: false });
    expect(alphaRecoverableInPreview({ hasAlpha: p.hasAlpha, videoCodec: p.videoCodec })).toBe(false);
  });

  it("an MKV whose cover art is a plain MJPEG track listed first: the real H.264 video is primary", async () => {
    // ffmpeg's Matroska muxer stores an attached_pic as an ordinary video track
    // (no flag survives), so only the codec tells it apart.
    const cover = path.join(dir, "cover.png");
    ff(["-f", "lavfi", "-i", "color=c=red:s=32x32", "-frames:v", "1", cover]);
    const file = path.join(dir, "coverfirst.mkv");
    ff(["-i", cover, "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10:d=1",
      "-map", "0:v", "-map", "1:v", "-c:v:0", "mjpeg", "-disposition:v:0", "attached_pic",
      "-c:v:1", "libx264", "-pix_fmt:v:1", "yuv420p", file]);
    expect(await probeMedia(file)).toMatchObject({ primaryVideoStreamIndex: 1, videoCodec: "h264", width: 64, height: 64 });
  });
});

