import { describe, it, expect } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import type { Composition, VideoOverlay } from "@/lib/engine/types";

/** Base-shaped full-frame video overlay (the modern spelling of a base video). */
const baseVideo: VideoOverlay = {
  id: "s",
  kind: "video",
  fileId: "f",
  videoUrl: "x",
  startTime: 0,
  duration: 5,
  z: 0,
  opacity: 1,
  fit: "cover",
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
  sourceWidth: 1920,
  sourceHeight: 1080,
};

describe("classifier tracked-overlay routing", () => {
  it("base video overlay + tracked overlay → fallback (chromium or canvas-source)", () => {
    const comp: Composition = {
      id: "c", name: "c", width: 1920, height: 1080, fps: 30,
      overlays: [baseVideo, {
        id: "ov", kind: "tracked", startTime: 0, duration: 5,
        rect: { x: 0, y: 0, width: 100, height: 100 }, z: 1, opacity: 1,
        trackId: "t1", content: { kind: "emoji", char: "😀" },
        fit: "tight", scale: 1, smoothing: "linear",
      }],
    };
    const shape = classifyExportShape(comp);
    expect(["chromium-render", "canvas-source"]).toContain(shape.tag);
  });
});
