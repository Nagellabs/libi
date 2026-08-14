/** Normalize author-facing 3D depth/bevel into WORLD units.
 *
 *  THE BUG THIS FIXES: the inspector/agent author `threeD.depth` (and `bevel`)
 *  on a pixel-ish "amount" scale — the inspector slider defaults to 20 and the
 *  agent uses values like 24–30. But the 3D-text builder lays glyphs out at a
 *  WORLD font size of ~1.0 unit tall. Fed raw, `depth:30` extrudes a 0.7-unit
 *  glyph 30 units deep — a long rod the camera sees end-on (a solid red bar);
 *  `bevel:3` is 4× the glyph height and rounds it into a blob; and the faux
 *  fallback builds ~12 ghost planes spanning 24 units (visible "repeated"
 *  copies). All three are the same ~30× unit mismatch.
 *
 *  THE FIX: interpret the author value as a percentage of the em — `depth/100 *
 *  worldFontSize` — so the default 20 → 0.2 (a tasteful 20%-of-glyph extrusion).
 *  Bevel is a small chamfer capped at 35% of depth so it can never engulf the
 *  glyph. Faux layer count scales with depth for a gap-free slab (no ghosting).
 *  Pure + unit-tested; the single chokepoint both 3D-text builders read from. */

export interface WorldThreeD {
  /** Extrusion depth in world units (≈ fraction of the em). */
  worldDepth: number;
  /** Bevel/chamfer in world units; ≤ 35% of worldDepth. */
  worldBevel: number;
  /** Stacked-plane count for the faux fallback (gap-free, no ghosting). */
  fauxLayers: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Map an author depth/bevel (pixel-ish 0–~50, default 20) to world units for a
 * glyph that is `worldFontSize` tall. `worldDepth = depth/100 * worldFontSize`,
 * clamped to ≤ 60% of the em so extreme inputs stay legible. Bevel is capped at
 * 35% of the resolved depth. Negative / non-finite inputs are treated as 0.
 */
export function normalizeThreeDForWorld(
  uiDepth: number,
  uiBevel: number,
  worldFontSize: number,
): WorldThreeD {
  const d = Number.isFinite(uiDepth) ? Math.max(0, uiDepth) : 0;
  const b = Number.isFinite(uiBevel) ? Math.max(0, uiBevel) : 0;
  const worldDepth = clamp((d / 100) * worldFontSize, 0, worldFontSize * 0.6);
  const worldBevel = clamp((b / 100) * worldFontSize, 0, worldDepth * 0.35);
  const fauxLayers = clamp(Math.round(d / 4) + 2, 3, 10);
  return { worldDepth, worldBevel, fauxLayers };
}

/**
 * Uniform scale so a `textW`×`textH` box fills `target` of a perspective
 * camera's visible frame at the focal plane (camera `dist` from the text,
 * vertical `fovDeg`, viewport `aspect` = w/h). Fits the BINDING dimension so
 * neither axis overflows — a long word in a narrow box scales down on width, a
 * short word in a wide box scales up to the height cap.
 *
 * WHY: the shared camera presets (three-helpers) are tuned for authored 3D
 * scenes; auto-laid-out text lands at ~13% of the frame and reads tiny in its
 * caption box. Scaling the text root by this factor makes 3D text fill its rect
 * like 2D text, independent of word length / font metrics. Pure + unit-tested.
 */
export function fitScaleForFrame(
  textW: number,
  textH: number,
  fovDeg: number,
  dist: number,
  aspect: number,
  target = 0.78,
): number {
  if (!(textW > 0) || !(textH > 0) || !(dist > 0)) return 1;
  const halfH = Math.tan((fovDeg * Math.PI) / 180 / 2) * dist;
  const halfW = halfH * Math.max(0.0001, aspect);
  const sH = (2 * halfH * target) / textH;
  const sW = (2 * halfW * target) / textW;
  return Math.min(sH, sW);
}
