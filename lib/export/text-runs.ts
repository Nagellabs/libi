/**
 * How the ffmpeg export groups text overlays for their blurred-shadow layers.
 * Pure and dependency-free, so the classifier (which also runs in the client
 * bundle) and the ffmpeg backend share ONE definition.
 *
 * A RUN is a maximal sequence of consecutive (in z) text overlays no two of
 * which are on screen at once — a caption track. Within a run the draw order
 * between members is invisible, so the backend draws it as plates → shadow
 * layers → fills, and a blurred shadow costs one layer per distinct shadow
 * per run rather than one per cue. Texts that overlap in time start a new run,
 * so their z-order holds exactly.
 */

interface Timed {
  kind: string;
  startTime: number;
  duration: number;
}

/** Overlaps shorter than this (s) don't count. It exists for millisecond
 *  ROUNDING: cue times rounded to the ms overlap their neighbour by 0.001 s,
 *  which split a caption track into a run — and a blur layer — per pair of
 *  cues (13 layers for a 36-cue track; its 4K export stalled for 15 minutes).
 *  It is kept well under one frame (16.7 ms at 60 fps): texts merged into one
 *  run are drawn plates → shadows → fills, so two texts that TRULY overlap
 *  for a frame or more must stay in separate runs, or the higher one's plate
 *  lands under the lower one's shadow and fill on those frames. */
export const OVERLAP_EPSILON_S = 0.01;

/** True when two timed layers are on screen together for more than an
 *  instant. Touching windows (one ends as the next starts) don't count — a
 *  caption track. */
export function overlapsInTime(a: Omit<Timed, "kind">, b: Omit<Timed, "kind">): boolean {
  return (
    a.startTime < b.startTime + b.duration - OVERLAP_EPSILON_S &&
    b.startTime < a.startTime + a.duration - OVERLAP_EPSILON_S
  );
}

/** The index past the end of the text run starting at `i` (overlays[i] must
 *  be text). */
export function textRunEnd<T extends Timed>(overlays: T[], i: number): number {
  let j = i + 1;
  while (j < overlays.length) {
    const next = overlays[j];
    if (next.kind !== "text") break;
    let clash = false;
    for (let k = i; k < j; k++) {
      if (overlapsInTime(overlays[k], next)) {
        clash = true;
        break;
      }
    }
    if (clash) break;
    j++;
  }
  return j;
}

/** Past this many blurred-shadow layers the export goes to the chromium
 *  renderer. Each layer is a split + blur + composite per frame, and texts
 *  interleaved in time (two simultaneous tracks) get a layer per cue. The
 *  cost is NOT linear in ffmpeg 9.0.1: measured at 4K, 1 s of video took
 *  0.48 s at 4 layers, 0.87 s at 8, 1.5 s at 10, 4.1 s at 12 — and 18 layers
 *  stalled after the first frame for over 15 minutes. 4 keeps it linear with
 *  a wide margin. */
export const MAX_SHADOW_LAYERS = 4;

/** A shadow the ffmpeg path blurs (canvas shadowBlur > 1). */
function blurredShadowKey(o: { shadow?: { color: string; blur: number }; opacity?: number }): string | null {
  const s = o.shadow;
  if (!s || !(s.blur > 1)) return null;
  return `${s.blur}|${s.color}|${o.opacity ?? 1}`;
}

/** How many blurred-shadow layers the ffmpeg path would build for these
 *  overlays, given in z order (the base excluded). */
export function shadowLayerCount(overlays: (Timed & { shadow?: { color: string; blur: number }; opacity?: number })[]): number {
  let count = 0;
  let i = 0;
  while (i < overlays.length) {
    if (overlays[i].kind !== "text") {
      i++;
      continue;
    }
    const j = textRunEnd(overlays, i);
    const keys = new Set<string>();
    for (let k = i; k < j; k++) {
      const key = blurredShadowKey(overlays[k]);
      if (key) keys.add(key);
    }
    count += keys.size;
    i = j;
  }
  return count;
}
