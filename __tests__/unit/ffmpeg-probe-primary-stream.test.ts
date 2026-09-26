/**
 * probeMedia names the PRIMARY audio and video streams, chosen by the rule
 * the preview's decoder uses. mediabunny's primary track is the first track
 * flagged `default` (the MP4 tkhd "enabled" flag, the Matroska FlagDefault,
 * which ffprobe reports as disposition.default), else the first track of that
 * type. ffmpeg's own automatic selection is different: without `-map` it
 * picks the stream with the most channels, and a filter `[n:a]` takes the
 * first audio stream. So proxy generation and the export mix map these
 * indices explicitly (Review M6). audioChannels describes that same stream.
 */
import { describe, it, expect, vi } from "vitest";

let streams: Array<Record<string, unknown>> = [];
vi.mock("child_process", () => ({
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (e: Error | null, o: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: JSON.stringify({ format: { duration: "2.0" }, streams }), stderr: "" });
  },
}));

import { probeMedia, primaryStreamIndex } from "@/lib/ffmpeg/probe";

const v = (index: number, disp: Record<string, number> = {}) => ({ index, codec_type: "video", width: 64, height: 64, disposition: disp });
const a = (index: number, channels: number, disp: Record<string, number> = {}) => ({ index, codec_type: "audio", channels, disposition: disp });

describe("primaryStreamIndex", () => {
  it("is the first stream of the type flagged default", () => {
    expect(primaryStreamIndex([v(0), a(1, 1), a(2, 2, { default: 1 })], "audio")).toBe(2);
  });
  it("is the first of the type when several are default (mediabunny's sort is stable)", () => {
    expect(primaryStreamIndex([v(0), a(1, 1, { default: 1 }), a(2, 2, { default: 1 })], "audio")).toBe(1);
  });
  it("is the first of the type when none is default", () => {
    expect(primaryStreamIndex([v(0), a(1, 1), a(2, 6)], "audio")).toBe(1);
  });
  it("never picks cover art for video", () => {
    expect(primaryStreamIndex([v(0, { attached_pic: 1, default: 1 }), v(1)], "video")).toBe(1);
  });
  it("skips a still-image track (MJPEG/PNG cover stored as a plain track, as in MKV) when a real video exists", () => {
    const still = (index: number, codec: string) => ({ index, codec_type: "video", codec_name: codec, disposition: {} });
    const h264 = (index: number) => ({ index, codec_type: "video", codec_name: "h264", disposition: {} });
    expect(primaryStreamIndex([still(0, "mjpeg"), h264(1)], "video")).toBe(1);
    expect(primaryStreamIndex([still(0, "png"), h264(1)], "video")).toBe(1);
    // A motion-JPEG camera file has only image-codec video: it is still the video.
    expect(primaryStreamIndex([still(0, "mjpeg")], "video")).toBe(0);
  });
  it("is undefined when there is no such stream", () => {
    expect(primaryStreamIndex([v(0)], "audio")).toBeUndefined();
  });
});

describe("probeMedia primary streams", () => {
  it("reports the primary audio stream's index and ITS channel count", async () => {
    streams = [v(0), a(1, 1, { default: 1 }), a(2, 2, { default: 1 })];
    const p = await probeMedia("/x.mp4");
    expect(p).toMatchObject({ primaryAudioStreamIndex: 1, audioChannels: 1, primaryVideoStreamIndex: 0 });

    streams = [v(0), a(1, 1), a(2, 2, { default: 1 })];
    expect(await probeMedia("/x.mp4")).toMatchObject({ primaryAudioStreamIndex: 2, audioChannels: 2 });
  });
});

describe("probeMedia describes the PRIMARY video stream (final review note)", () => {
  it("size, codec, pixel format, alpha, rate and colour come from the primary stream, not the first", async () => {
    streams = [
      { index: 0, codec_type: "video", codec_name: "h264", width: 64, height: 64, pix_fmt: "yuv420p", color_space: "smpte170m", avg_frame_rate: "25/1", disposition: {} },
      { index: 1, codec_type: "video", codec_name: "vp9", width: 48, height: 32, pix_fmt: "yuv420p", tags: { alpha_mode: "1" }, color_space: "bt709", avg_frame_rate: "30/1", disposition: { default: 1 } },
    ];
    expect(await probeMedia("/x.mkv")).toMatchObject({
      primaryVideoStreamIndex: 1, width: 48, height: 32, videoCodec: "vp9", hasAlpha: true, colorSpace: "bt709", frameRate: 30,
    });
  });

  it("the reverse: an opaque primary with an alpha second stream is opaque", async () => {
    streams = [
      { index: 0, codec_type: "video", codec_name: "h264", width: 64, height: 64, pix_fmt: "yuv420p", disposition: { default: 1 } },
      { index: 1, codec_type: "video", codec_name: "vp9", width: 48, height: 32, pix_fmt: "yuv420p", tags: { alpha_mode: "1" }, disposition: {} },
    ];
    expect(await probeMedia("/x.mkv")).toMatchObject({ primaryVideoStreamIndex: 0, width: 64, videoCodec: "h264", hasAlpha: false });
  });

  it("cover art listed first is skipped; a file whose only picture IS cover art still reports it, as before", async () => {
    streams = [
      { index: 0, codec_type: "video", codec_name: "mjpeg", width: 600, height: 600, pix_fmt: "yuvj420p", disposition: { attached_pic: 1 } },
      { index: 1, codec_type: "video", codec_name: "h264", width: 64, height: 36, pix_fmt: "yuv420p", disposition: { default: 1 } },
    ];
    expect(await probeMedia("/x.mp4")).toMatchObject({ width: 64, height: 36, videoCodec: "h264" });
    streams = [
      { index: 0, codec_type: "audio", channels: 2, disposition: { default: 1 } },
      { index: 1, codec_type: "video", codec_name: "mjpeg", width: 600, height: 600, pix_fmt: "yuvj420p", disposition: { attached_pic: 1 } },
    ];
    expect(await probeMedia("/x.mp3")).toMatchObject({ width: 600, videoCodec: "mjpeg" });
  });
});
