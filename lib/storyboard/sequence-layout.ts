/**
 * Sequential (film-strip) layout for storyboard-owned video overlays.
 *
 * Base scenes got this for free: position was implicit in `sceneOrder`, so
 * changing one card's take re-flowed everything after it automatically.
 * Overlays carry an absolute `startTime`, so the storyboard has to compute the
 * packing itself. This is that computation — pure, so it is unit-testable
 * without a manifest, storage, or a DB.
 *
 * NOTE: this is deliberately storyboard-only. Overlays elsewhere stay
 * free-positioned (gaps are allowed and meaningful); only a storyboard is a
 * genuine sequence.
 */
export interface SequenceItem {
  overlayId: string;
  duration: number;
}

export interface SequencePlacement {
  overlayId: string;
  startTime: number;
}

/** Pack items back-to-back from t=0, in the order given. */
export function layoutSequentialOverlays(items: SequenceItem[]): SequencePlacement[] {
  const out: SequencePlacement[] = [];
  let acc = 0;
  for (const item of items) {
    out.push({ overlayId: item.overlayId, startTime: acc });
    // A NaN/negative duration would otherwise propagate into every later
    // offset and silently destroy the whole sequence.
    const d = Number.isFinite(item.duration) && item.duration > 0 ? item.duration : 0;
    acc += d;
  }
  return out;
}
