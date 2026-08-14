// lib/storyboard/render/satori.ts
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { createDrawFunction } from "@/lib/ai/scene-validator";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import { loadDefaultFont, DEFAULT_FONT_NAME } from "./fonts";
import { h, type RenderFrame } from "./hyperscript";

/** Run a satori-mode unit body (returns a Satori element via injected `h`),
 *  lay it out to SVG with Satori, then rasterize to PNG with resvg. */
export async function renderSatoriUnit(
  source: string,
  frame: RenderFrame,
  extra: Record<string, unknown> = {},
): Promise<Buffer> {
  const fn = createDrawFunction(source, { ...DRAW_HELPERS, h });
  const element = fn({ width: frame.width, height: frame.height, ...extra });
  if (!element || typeof element !== "object") {
    throw new Error("satori render unit must return an element (use h(...))");
  }
  const svg = await satori(element as Parameters<typeof satori>[0], {
    width: frame.width,
    height: frame.height,
    fonts: [{ name: DEFAULT_FONT_NAME, data: loadDefaultFont(), weight: 400, style: "normal" }],
  });
  return Buffer.from(new Resvg(svg).render().asPng());
}
