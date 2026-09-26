/**
 * probeMedia reports the video stream's pixel format and colour tags, and
 * reports an UNSET tag as absent — ffprobe spells "not tagged" as `unknown`
 * (or omits the key), and the export's base-colour rule
 * (lib/export/untagged-color.ts) must not mistake that word for a tag.
 */
import { describe, it, expect, vi } from "vitest";

let stream: Record<string, unknown> = {};
vi.mock("child_process", () => ({
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (e: Error | null, o: { stdout: string; stderr: string }) => void;
    cb(null, {
      stdout: JSON.stringify({
        format: { duration: "2.0" },
        streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, ...stream }],
      }),
      stderr: "",
    });
  },
}));

import { probeMedia } from "@/lib/ffmpeg/probe";

describe("probeMedia colour fields", () => {
  it("returns the pixel format and the colour tags of a tagged stream", async () => {
    stream = { pix_fmt: "yuv420p", color_space: "bt709", color_primaries: "bt709", color_transfer: "bt709", color_range: "tv" };
    const p = await probeMedia("/x.mp4");
    expect(p).toMatchObject({
      pixFmt: "yuv420p", colorSpace: "bt709", colorPrimaries: "bt709", colorTransfer: "bt709", colorRange: "tv",
    });
  });

  it("reports `unknown` / missing tags as absent", async () => {
    stream = { pix_fmt: "yuv420p", color_space: "unknown", color_primaries: "unknown", color_transfer: "unknown", color_range: "unknown" };
    const p = await probeMedia("/x.mp4");
    expect(p.pixFmt).toBe("yuv420p");
    expect(p.colorSpace).toBeUndefined();
    expect(p.colorPrimaries).toBeUndefined();
    expect(p.colorTransfer).toBeUndefined();
    expect(p.colorRange).toBeUndefined();

    stream = { pix_fmt: "yuv420p" };
    const q = await probeMedia("/x.mp4");
    expect(q.colorSpace).toBeUndefined();
    expect(q.colorRange).toBeUndefined();
  });
});
