import { Resvg } from "@resvg/resvg-js";
import { createDrawFunction } from "@/lib/ai/scene-validator";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import type { RenderFrame } from "./hyperscript";

/** Run an svg-mode unit body (returns an SVG string) and rasterize to PNG. */
export function renderSvgUnit(
  source: string,
  frame: RenderFrame,
  extra: Record<string, unknown> = {},
): Buffer {
  const fn = createDrawFunction(source, DRAW_HELPERS);
  const out = fn({ width: frame.width, height: frame.height, ...extra });
  if (typeof out !== "string") {
    throw new Error("svg render unit must return an SVG string");
  }
  return Buffer.from(new Resvg(out).render().asPng());
}
