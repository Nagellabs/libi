import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { drawTrackBox } from "@/scripts/track-eval/draw";

describe("drawTrackBox", () => {
  it("draws a red rectangle at the sample bbox", () => {
    const canvas = createCanvas(100, 100);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 100, 100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    drawTrackBox(ctx as any, { t: 0, x: 10, y: 10, w: 20, h: 20, confidence: 0.5, visible: true }, {
      segmentLabel: "yoloe-visual", segmentStatus: "ok",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const px = (ctx as any).getImageData(20, 10, 1, 1).data;
    expect(px[0]).toBeGreaterThan(150);
    expect(px[1]).toBeLessThan(100);
  });

  it("does not draw a box when sample is not visible", () => {
    const canvas = createCanvas(100, 100);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 100, 100);
    // The bbox (and the sampled pixel) sit BELOW the 24px caption bar
    // drawTrackBox always paints at the top. The bar holds white text in
    // "16px sans-serif", and which exact pixels a glyph covers is a
    // font-fallback decision the platform makes — on Linux CI a bright glyph
    // landed on the old (20,10) probe and failed this test even though no
    // box was drawn. Sampling at (20,40) still catches a regression (a
    // wrongly-drawn stroke at y=40 would cover it) without betting on fonts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    drawTrackBox(ctx as any, { t: 0, x: 10, y: 40, w: 20, h: 20, confidence: 0, visible: false }, {
      segmentLabel: "skip", segmentStatus: "skipped",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const px = (ctx as any).getImageData(20, 40, 1, 1).data;
    expect(px[0]).toBeLessThan(50);
  });
});
