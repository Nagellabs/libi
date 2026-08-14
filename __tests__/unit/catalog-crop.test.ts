import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ffmpeg/exec", () => ({
  runFfmpeg: vi.fn(async () => ({ stdout: "", stderr: "" })),
  resolveFfmpegPath: vi.fn(() => "/usr/local/bin/ffmpeg"),
}));

import { buildCropArgs } from "@/lib/catalog/crop";

describe("buildCropArgs", () => {
  it("image source — bbox crop only, no -ss", () => {
    const args = buildCropArgs({
      sourcePath: "/in/photo.jpg",
      outputPath: "/out/crop.jpg",
      bbox: { x: 10, y: 20, w: 100, h: 200 },
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(args).toContain("-i");
    expect(args).toContain("/in/photo.jpg");
    expect(args.find((a) => a.startsWith("crop=100:200:10:20"))).toBeTruthy();
    expect(args).not.toContain("-ss");
  });

  it("video source — uses -ss with frameTime BEFORE -i for keyframe seek", () => {
    const args = buildCropArgs({
      sourcePath: "/in/video.mp4",
      outputPath: "/out/crop.jpg",
      bbox: { x: 10, y: 20, w: 100, h: 200 },
      sourceWidth: 1920,
      sourceHeight: 1080,
      frameTime: 12.5,
    });
    const ssIdx = args.indexOf("-ss");
    const inputIdx = args.indexOf("-i");
    expect(ssIdx).toBeGreaterThanOrEqual(0);
    expect(ssIdx).toBeLessThan(inputIdx);
    expect(args[ssIdx + 1]).toBe("12.5");
    expect(args).toContain("-frames:v");
  });

  it("clamps bbox to source dimensions", () => {
    const args = buildCropArgs({
      sourcePath: "/in/photo.jpg",
      outputPath: "/out/crop.jpg",
      bbox: { x: 1900, y: 1000, w: 500, h: 500 },
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    // x+w would exceed 1920 → w gets clamped to 20; same for y+h → h=80
    expect(args.find((a) => a.startsWith("crop=20:80:1900:1000"))).toBeTruthy();
  });

  it("scales a normalized (0..1) bbox by the source dimensions", () => {
    // Analysis bboxes are normalized; the crop must convert to pixels instead
    // of flooring 0.38→0 into a degenerate crop.
    const args = buildCropArgs({
      sourcePath: "/in/video.mp4",
      outputPath: "/out/crop.jpg",
      bbox: { x: 0.32, y: 0.05, w: 0.38, h: 0.95 },
      sourceWidth: 1280,
      sourceHeight: 720,
      frameTime: 3,
    });
    // 0.32*1280=409.6→409, 0.05*720=36, 0.38*1280=486.4→486, 0.95*720=684
    expect(args.find((a) => a.startsWith("crop=486:684:409:36"))).toBeTruthy();
  });

  it("treats a pixel bbox (any coord > 1) as absolute, not normalized", () => {
    const args = buildCropArgs({
      sourcePath: "/in/photo.jpg",
      outputPath: "/out/crop.jpg",
      bbox: { x: 10, y: 20, w: 100, h: 200 },
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(args.find((a) => a.startsWith("crop=100:200:10:20"))).toBeTruthy();
  });

  it("throws on degenerate bbox", () => {
    expect(() =>
      buildCropArgs({
        sourcePath: "/in/photo.jpg",
        outputPath: "/out/crop.jpg",
        bbox: { x: 1920, y: 1080, w: 1, h: 1 },
        sourceWidth: 1920,
        sourceHeight: 1080,
      }),
    ).toThrow(/bbox/i);
  });
});
