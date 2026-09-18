import type { GenParamValue, StoryboardCard } from "./types";

/** Client-safe aspect helpers shared by the server-side sketch renderer
 *  (`render-card.ts`) and the card's media tiles (`media-tile.tsx`), so a
 *  sketch is composed AND displayed in the same frame. Keep this module free
 *  of server imports (storage, fs). */

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

/** The card's generation aspect (width / height): the clip's `aspect_ratio`
 *  param first, then the keyframe's; null when neither is set. */
export function cardAspect(card: Pick<StoryboardCard, "clipGen" | "keyframeGen">): number | null {
  return parseAspectRatio(card.clipGen?.params?.aspect_ratio ?? card.keyframeGen?.params?.aspect_ratio);
}

/** Portrait tiles were always 9:16 boxes of a given `width`. To keep every
 *  tile the same visual size whatever its aspect, the LONG edge is fixed at
 *  `width * 16 / 9` (114 px for the standard 64 px tile): a portrait tile keeps
 *  its width, a landscape tile widens to the long edge, a square tile is
 *  long-edge on both sides. Heights are integers so rows align. */
export function tileSize(width: number, aspect: number): { width: number; height: number } {
  const longEdge = Math.round((width * 16) / 9);
  const w = aspect >= 1 ? longEdge : Math.round(longEdge * aspect);
  return { width: w, height: Math.round(w / aspect) };
}
