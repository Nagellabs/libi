import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { renderVerifyFrames } from "@/lib/tracking/verify-render";
import { normalizeTrack } from "@/lib/tracking/segments";
import type { Track } from "@/lib/tracking/types";

async function solidPng(): Promise<Buffer> {
  const c = createCanvas(64, 64);
  const x = c.getContext("2d");
  x.fillStyle = "#888";
  x.fillRect(0, 0, 64, 64);
  return c.encode("png");
}

const track: Track = normalizeTrack({
  id: "trk", fileId: "f", method: "yoloe+botsort", framerate: 1, durationSec: 4,
  samples: [
    { t: 0, x: 8, y: 8, w: 16, h: 16, confidence: 1, visible: true },
    { t: 1, x: 9, y: 9, w: 16, h: 16, confidence: 1, visible: true },
    { t: 2, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false },
  ],
});

describe("renderVerifyFrames", () => {
  it("returns a png + tracking context per time and marks anchor frames", async () => {
    const out = await renderVerifyFrames(
      {
        track,
        srcPath: "/does/not/matter.mp4",
        frameW: 64, frameH: 64,
        times: [0, 2],
        content: { kind: "emoji", char: "😀" },
        fit: "tight", scale: 1, smoothing: "linear",
        manualAnchorTimes: [0], agentAnchorTimes: [],
      },
      { extractFrame: async () => solidPng() },
    );
    expect(out.frames).toHaveLength(2);
    const f0 = out.frames[0];
    expect(f0.time).toBe(0);
    expect(typeof f0.pngBase64).toBe("string");
    expect(f0.pngBase64!.length).toBeGreaterThan(100);
    expect(f0.visible).toBe(true);
    expect(f0.isAnchorFrame).toBe(true);
    expect(f0.sampledRect).not.toBeNull();
    const f2 = out.frames[1];
    expect(f2.visible).toBe(false);
    expect(f2.sampledRect).toBeNull();
    expect(f2.isAnchorFrame).toBe(false);
  });

  it("sampledRect honors the follow offset (parity with resolveTrackedRect)", async () => {
    const { frames } = await renderVerifyFrames(
      {
        track,
        srcPath: "/dev/null",
        frameW: 64, frameH: 64,
        times: [0],
        content: { kind: "emoji", char: "⬇" },
        fit: "tight", scale: 1, smoothing: "linear",
        offset: { x: 0, y: -1 },
        manualAnchorTimes: [], agentAnchorTimes: [],
      },
      { extractFrame: async () => solidPng() },
    );
    const f = frames[0];
    expect(f.sampledRect).not.toBeNull();
    // trackBbox is the raw sample; the rect must sit one box-height above it.
    expect(f.sampledRect!.y).toBeCloseTo(f.trackBbox!.y - f.sampledRect!.h, 3);
    expect(f.sampledRect!.h).toBeCloseTo(f.trackBbox!.h, 3);
  });

  it("records an error for a failed extract without aborting the rest", async () => {
    let n = 0;
    const out = await renderVerifyFrames(
      {
        track, srcPath: "/x.mp4", frameW: 64, frameH: 64, times: [0, 1],
        content: { kind: "emoji", char: "😀" }, fit: "tight", scale: 1,
        smoothing: "linear", manualAnchorTimes: [], agentAnchorTimes: [],
      },
      {
        extractFrame: async () => {
          n += 1;
          if (n === 1) throw new Error("boom");
          return solidPng();
        },
      },
    );
    expect(out.frames[0].error).toMatch(/boom/);
    expect(out.frames[0].pngBase64).toBeUndefined();
    expect(out.frames[1].pngBase64).toBeTruthy();
  });
});
