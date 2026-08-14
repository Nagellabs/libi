import { describe, it, expect } from "vitest";
import { resolveExportSettings, isUpscaling } from "@/lib/export/quality";

describe("resolveExportSettings", () => {
  it("uses source dimensions when quality is 'source'", () => {
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "source",
      sourceWidth: 1280,
      sourceHeight: 720,
    });
    expect(s.width).toBe(1280);
    expect(s.height).toBe(720);
    // Below-1080p sources get the 4 Mbps floor.
    expect(s.bitrate).toBeGreaterThanOrEqual(4_000_000);
  });

  it("applies the 1080p preset", () => {
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "1080p",
      sourceWidth: 1280,
      sourceHeight: 720,
    });
    expect(s.width).toBe(1920);
    expect(s.height).toBe(1080);
    expect(s.bitrate).toBe(8_000_000);
  });

  it("applies the 4k preset with a ~32 Mbps bitrate", () => {
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "4k",
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(s.width).toBe(3840);
    expect(s.height).toBe(2160);
    expect(s.bitrate).toBeGreaterThanOrEqual(30_000_000);
    expect(s.bitrate).toBeLessThanOrEqual(36_000_000);
  });

  it("rounds dimensions down to even (yuv420p requirement)", () => {
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "custom",
      customWidth: 1281,
      customHeight: 723,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(s.width).toBe(1280);
    expect(s.height).toBe(722);
  });

  it("custom requires both customWidth and customHeight", () => {
    expect(() =>
      resolveExportSettings({
        format: "mp4",
        codec: "avc",
        fps: 30,
        quality: "custom",
        sourceWidth: 1920,
        sourceHeight: 1080,
      }),
    ).toThrow();
  });
});

describe("isUpscaling", () => {
  it("is true when target dimensions exceed source", () => {
    const s = resolveExportSettings({
      format: "mp4", codec: "avc", fps: 30, quality: "4k",
      sourceWidth: 1920, sourceHeight: 1080,
    });
    expect(isUpscaling(s, 1920, 1080)).toBe(true);
  });
  it("is false at source", () => {
    const s = resolveExportSettings({
      format: "mp4", codec: "avc", fps: 30, quality: "source",
      sourceWidth: 1920, sourceHeight: 1080,
    });
    expect(isUpscaling(s, 1920, 1080)).toBe(false);
  });
});
