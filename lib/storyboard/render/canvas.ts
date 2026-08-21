import { createCanvas } from "@napi-rs/canvas";
import { ensureBundledFontsRegistered } from "@/lib/fonts/register-server";
import rough from "roughjs";
import { createDrawFunction } from "@/lib/ai/scene-validator";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import { ROUGH_SEED, INK, GRAYS } from "./sketch-kit";
import type { RenderFrame } from "./hyperscript";

/** Run a canvas-mode unit body (draws to ctx) against a node canvas → PNG.
 *  ctx-only DRAW_HELPERS (drawRoundedRect, drawGradient, drawCircle, interpolate,
 *  spring, …) work here; the image/SVG helpers (drawSvg/loadImage/svgToImage) are
 *  browser-oriented and should not be used in a node schematic unit.
 *
 *  A seeded Rough.js instance is injected as `context.rough` so units can draw
 *  hand-drawn sketch illustrations directly onto the same ctx; `context.INK` and
 *  `context.GRAYS` are the shared sketch palette. The fixed seed keeps re-renders
 *  byte-stable. */
export async function renderCanvasUnit(
  source: string,
  frame: RenderFrame,
  extra: Record<string, unknown> = {},
): Promise<Buffer> {
  ensureBundledFontsRegistered();
  const canvas = createCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d");
  const rc = rough.canvas(canvas as unknown as HTMLCanvasElement, {
    options: { seed: ROUGH_SEED },
  });
  const fn = createDrawFunction(source, DRAW_HELPERS);
  fn({
    ctx,
    rough: rc,
    width: frame.width,
    height: frame.height,
    INK,
    GRAYS,
    ...extra,
  });
  return Buffer.from(await canvas.encode("png"));
}
