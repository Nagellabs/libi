/**
 * A canvas shadow is NOT transformed by the context's matrix (HTML spec:
 * shadowBlur / shadowOffsetX / shadowOffsetY are in output-bitmap pixels). The
 * renderer draws in composition space through a `renderScale` transform — the
 * editor preview at display px × devicePixelRatio, a 4K export at 2× a 1080
 * piece — so an unscaled `CaptionShadow` came out a different size relative to
 * the text in every one of them: half-size in a 4K chromium export. The
 * renderer multiplies the shadow by the context's current scale so the shadow
 * is composition-space, like every other caption field (and like the ffmpeg
 * export, which scales it with the frame).
 */
import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { drawOverlay } from "@/lib/engine/overlay-renderer";
import type { TextOverlay } from "@/lib/engine/types";

const caption: TextOverlay = {
  id: "t",
  kind: "text",
  startTime: 0,
  duration: 2,
  z: 1,
  opacity: 1,
  rect: { x: 20, y: 20, width: 60, height: 40 },
  content: "",
  font: "40px Inter",
  color: "#0000ff",
  align: "left",
};

/** Draw a single filled square glyph-stand-in via the text path, then find the
 *  red shadow's extent below the blue fill. A full-block "█" glyph is font-
 *  dependent, so the test measures the SHADOW'S offset from the fill instead. */
function shadowOffsetPx(renderScale: number): number {
  const size = 200 * renderScale;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
  drawOverlay(
    { ...caption, content: "I", shadow: { color: "#ff0000", blur: 0, dx: 0, dy: 20 } },
    { ctx, time: 1, fps: 30, width: 200, height: 200, renderScale } as never,
  );
  const d = ctx.getImageData(0, 0, size, size).data;
  let blueBottom = -1;
  let redBottom = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (d[i + 2] > 200 && d[i] < 50) blueBottom = y;
      if (d[i] > 200 && d[i + 2] < 50) redBottom = y;
    }
  }
  return redBottom - blueBottom;
}

describe("caption shadow is composition-space", () => {
  it("a 2× backing draws the shadow offset 2× (it was 1×)", () => {
    const at1 = shadowOffsetPx(1);
    const at2 = shadowOffsetPx(2);
    expect(at1).toBeGreaterThanOrEqual(19);
    expect(at1).toBeLessThanOrEqual(21);
    expect(at2).toBeGreaterThanOrEqual(2 * at1 - 2);
    expect(at2).toBeLessThanOrEqual(2 * at1 + 2);
  });
});
