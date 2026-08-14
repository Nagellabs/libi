// lib/effects/thumbnail.ts
// Pure helpers driving the picker's live thumbnails. A thumbnail loops a single
// effect's animate(progress) over an 800ms active window + 400ms hold, mapping
// the resulting TransformDelta onto a sample DOM element via CSS (the preview
// canvas remains the source of truth; the thumbnail is a faithful CSS proxy).
import type { EffectMeta, TransformDelta } from "./types";

const ACTIVE_MS = 800;
const PAUSE_MS = 400;
const PERIOD_MS = ACTIVE_MS + PAUSE_MS;

/** Resolve each param to its default (number→0, enum→first option) for preview. */
export function resolveThumbnailParams(meta: EffectMeta): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of meta.params) {
    if (p.default !== undefined) {
      out[p.key] = p.default;
    } else if (p.type === "enum") {
      out[p.key] = p.options?.[0] ?? "";
    } else {
      out[p.key] = 0;
    }
  }
  return out;
}

export interface ThumbnailStyle {
  transform: string;
  opacity: number;
  filter: string;
  clipPath: string;
}

/** Map a TransformDelta to CSS properties for the sample element. */
export function deltaToThumbnailStyle(d: TransformDelta): ThumbnailStyle {
  const parts: string[] = [];
  if (d.dx !== undefined || d.dy !== undefined) {
    parts.push(`translate(${d.dx ?? 0}px, ${d.dy ?? 0}px)`);
  }
  if (d.scaleX !== undefined || d.scaleY !== undefined) {
    parts.push(`scale(${d.scaleX ?? 1}, ${d.scaleY ?? 1})`);
  } else if (d.scale !== undefined) {
    parts.push(`scale(${d.scale})`);
  }
  if (d.rotateDeg !== undefined) parts.push(`rotate(${d.rotateDeg}deg)`);

  let clipPath = "none";
  if (d.clipReveal) {
    const hidden = Math.max(0, Math.min(1, 1 - d.clipReveal.fraction));
    const pct = `${(hidden * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
    // inset(top right bottom left) — hide from the OPPOSITE edge of `edge`.
    const map: Record<string, string> = {
      left: `inset(0 ${pct} 0 0)`,
      right: `inset(0 0 0 ${pct})`,
      top: `inset(0 0 ${pct} 0)`,
      bottom: `inset(${pct} 0 0 0)`,
    };
    clipPath = map[d.clipReveal.edge] ?? "none";
  }

  return {
    transform: parts.length ? parts.join(" ") : "none",
    opacity: d.opacity ?? 1,
    filter: d.blurPx !== undefined ? `blur(${d.blurPx}px)` : "none",
    clipPath,
  };
}

/** Progress 0→1 over the active window, held at 1 during the pause, wrapping each period. */
export function thumbnailProgress(elapsedMs: number): number {
  const t = ((elapsedMs % PERIOD_MS) + PERIOD_MS) % PERIOD_MS;
  if (t >= ACTIVE_MS) return 1;
  return t / ACTIVE_MS;
}

export const THUMBNAIL_TIMING = { ACTIVE_MS, PAUSE_MS, PERIOD_MS } as const;
