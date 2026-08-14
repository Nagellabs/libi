import { describe, it, expect } from "vitest";
import { computeVerifyDims, VERIFY_BITRATE_BPS } from "@/lib/render/frame-capture";

describe("computeVerifyDims", () => {
  it("downscales 1080p to the height cap, even dims, preserves aspect", () => {
    const d = computeVerifyDims(1920, 1080, 720);
    expect(d.height).toBe(720);
    expect(d.width).toBe(1280);
    expect(d.width % 2).toBe(0);
    expect(d.height % 2).toBe(0);
  });

  it("never upscales a small source", () => {
    expect(computeVerifyDims(640, 480, 720)).toEqual({ width: 640, height: 480 });
  });

  it("handles portrait", () => {
    const d = computeVerifyDims(1080, 1920, 720);
    expect(d.height).toBe(1280);
    expect(d.width).toBe(720);
  });
});

describe("verify render bitrate", () => {
  it("uses a low vision-check bitrate (2 Mbps), not the export default", () => {
    // The verify MP4 exists only for the agent's frame extraction; 2 Mbps at
    // ≤720 short-side is fully legible and keeps the postback small + fast.
    expect(VERIFY_BITRATE_BPS).toBe(2_000_000);
  });
});
