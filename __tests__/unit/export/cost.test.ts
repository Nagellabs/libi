import { describe, it, expect } from "vitest";
import { COST_TABLE, MB, PIXELS_1080P, estimateCost, softwareVariant } from "@/lib/export/cost";

const base = { width: 1920, height: 1080, format: "mp4" as const, cores: 16, hwEncoderAvailable: true, renderWorkers: 2 };

describe("estimateCost", () => {
  it("stream-copy-trim is cheap and needs no encoder", () => {
    expect(estimateCost({ ...base, backend: "stream-copy-trim" })).toEqual({
      backend: "stream-copy-trim",
      memoryBytes: COST_TABLE.streamCopy.memoryMB * MB,
      cpu: COST_TABLE.streamCopy.cpu,
      hwEncoder: false,
      softwareFallback: false,
      renderWorkers: 0,
    });
  });

  it("ffmpeg-overlay: a hardware session and one core when the encoder exists; frame buffers grow with the frame", () => {
    const hd = estimateCost({ ...base, backend: "ffmpeg-overlay" });
    expect(hd).toMatchObject({ hwEncoder: true, softwareFallback: true, cpu: 1 });
    expect(hd.memoryBytes).toBe(Math.round((COST_TABLE.ffmpegOverlay.baseMB + COST_TABLE.ffmpegOverlay.perMegapixelMB * (PIXELS_1080P / 1e6)) * MB));
    const uhd = estimateCost({ ...base, backend: "ffmpeg-overlay", width: 3840, height: 2160 });
    expect(uhd.memoryBytes).toBeGreaterThan(hd.memoryBytes);
  });

  it("ffmpeg-overlay without a hardware encoder (or to WebM) is software: half the cores", () => {
    expect(estimateCost({ ...base, backend: "ffmpeg-overlay", hwEncoderAvailable: false })).toMatchObject({ hwEncoder: false, softwareFallback: false, cpu: 8 });
    expect(estimateCost({ ...base, backend: "ffmpeg-overlay", format: "webm" })).toMatchObject({ hwEncoder: false, cpu: 8 });
  });

  it("chromium-render: the window plus a page per worker, scaled by resolution; cpu = workers; its mux copies, so no encoder", () => {
    const hd = estimateCost({ ...base, backend: "chromium-render" });
    expect(hd).toMatchObject({ cpu: 2, hwEncoder: false, softwareFallback: false, renderWorkers: 2 });
    expect(hd.memoryBytes).toBe((COST_TABLE.chromium.windowMB + 2 * COST_TABLE.chromium.pageMBAt1080p) * MB);
    const uhd = estimateCost({ ...base, backend: "chromium-render", width: 3840, height: 2160 });
    expect(uhd.memoryBytes).toBe((COST_TABLE.chromium.windowMB + 2 * COST_TABLE.chromium.pageMBAt1080p * 4) * MB);
  });

  it("softwareVariant turns a hardware estimate into its libx264 cost", () => {
    const hw = estimateCost({ ...base, backend: "ffmpeg-overlay" });
    expect(softwareVariant(hw, 16)).toEqual({ ...hw, hwEncoder: false, softwareFallback: false, cpu: 8 });
  });
});
