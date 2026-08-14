import { getStorage } from "@/lib/storage";
import { renderUnitToPng } from "./render";
import { slotUnitPath, slotSketchPath } from "./paths";
import type { StoryboardCard, SketchSlot, GenParamValue } from "./types";

/** Long edge (px) of a rendered schematic; the short edge derives from aspect. */
const SKETCH_LONG_EDGE = 1280;
/** Fallback frame (9:16) when the card has no resolvable aspect yet. */
const DEFAULT_FRAME = { width: 720, height: 1280 };

/** Parse an aspect expressed as "W:H" / "WxH" / "W/H" into a numeric ratio
 *  (width / height). Returns null when unparseable. */
export function parseAspectRatio(v: GenParamValue | undefined): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i);
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!(w > 0) || !(h > 0)) return null;
  return w / h;
}

/** Schematic render frame for a card — sized to the card's clip (or keyframe)
 *  `aspect_ratio` param with a fixed long edge, so a sketch is composed in the
 *  SAME frame the clip will generate in (a 16:9 clip gets a 16:9 sketch, not the
 *  legacy 9:16 default). Falls back to 9:16 when no aspect is set on the card yet. */
export function frameForCard(card: StoryboardCard): { width: number; height: number } {
  const raw = card.clipGen?.params?.aspect_ratio ?? card.keyframeGen?.params?.aspect_ratio;
  const ratio = parseAspectRatio(raw);
  if (ratio == null) return { ...DEFAULT_FRAME };
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return ratio >= 1
    ? { width: SKETCH_LONG_EDGE, height: even(SKETCH_LONG_EDGE / ratio) }
    : { width: even(SKETCH_LONG_EDGE * ratio), height: SKETCH_LONG_EDGE };
}

/** Render ONE sketch slot to `storyboard/cards/<id>/sketches/<slotId>.png`.
 *  Returns the relative output path, or null when the slot has no render unit
 *  file yet. Writes only the slot PNG (watcher-ignored). */
export async function renderCardSketch(
  pieceId: string,
  card: StoryboardCard,
  slot: SketchSlot,
): Promise<string | null> {
  if (!slot.render) return null;
  const storage = await getStorage();
  const unitRel = slotUnitPath(card.id, slot);
  if (!(await storage.exists(pieceId, unitRel))) return null;
  const source = (await storage.read(pieceId, unitRel)).toString("utf8");
  const png = await renderUnitToPng(slot.render.kind, source, frameForCard(card), {
    blocks: card.blocks ?? [],
    camera: card.camera,
  });
  const out = slotSketchPath(card.id, slot.id);
  await storage.save(pieceId, out, png, "image/png");
  return out;
}

/** Render every sketch slot of a card. Best-effort: a slot without a unit yet
 *  is skipped. */
export async function renderCardSketches(pieceId: string, card: StoryboardCard): Promise<void> {
  for (const slot of card.sketches) {
    await renderCardSketch(pieceId, card, slot);
  }
}
