import type { CaptionCueWord } from "@/lib/captions/types";
import type { BodyKind, FrameTiming, LayerPad } from "@/lib/sandbox/protocol";
import type { Transform3D } from "./types";

/** One frame's worth of "please draw this overlay" — everything the sandboxed
 *  runtime needs, computed host-side by `planLayer` exactly as the host used to
 *  compute it before calling the body (spec §4.4). */
export interface LayerRequest {
  overlayId: string;
  kind: BodyKind;
  frame: number;
  /** Logical size of the body's box in composition px, in whole pixels: the
   *  (keyframed) rect, or the tracked bbox. The body sees it as width/height. */
  size: { width: number; height: number };
  /** `canvas.width / composition.width` — the layer renders at size × this. */
  pixelRatio: number;
  fps: number;
  /** Element-local timing (`elementTiming`) plus the piece clock a body may read
   *  (`compositionTime`, `overlayStart`, `pieceDuration`). */
  time: FrameTiming;
  words?: CaptionCueWord[];
  /** Code only, while the rect's SIZE is keyframed: the sizes at the ends of
   *  the current keyframe segment, which the content fit interpolates between
   *  (`interpolateContentBox`). Absent: the fit is measured at `size`. */
  fitSegment?: { from: { width: number; height: number }; to: { width: number; height: number } };
  /** three only: the out-of-plane transform; the host applies the screen roll. */
  transform3d?: Transform3D;
  /** Tracked code only: how far the layer extends past the box on each side
   *  (up to one box size, clamped to the output canvas). The body still draws
   *  with its origin at the box's top-left; the host draws the bitmap at the
   *  box position minus (`left`, `top`). */
  pad?: LayerPad;
}

/** The box a layer was drawn for: the body's `size`, the `pad` around it, and
 *  the backing `pixelRatio` — exactly the fields of the `LayerRequest` it
 *  answers. */
export type LayerGeometry = Pick<LayerRequest, "size" | "pad" | "pixelRatio">;

export interface LayerBitmap extends LayerGeometry {
  /** The frame this bitmap was rendered for — may be older than the one asked
   *  for (preview hold-last-good); never older in export. */
  frame: number;
  bitmap: ImageBitmap;
}

/** What `renderFrame` reads body layers through. Synchronous by contract: the
 *  preview answers with the newest bitmap it has and posts a render for the
 *  frame it was asked for; the export settles every request BEFORE calling
 *  `renderFrame`, so `get` always hits.
 *
 *  `get` returns the geometry the bitmap was RENDERED for, not the current
 *  request's: a held bitmap may predate a resize (pixel ratio), a rect edit or
 *  a tracked box that changes size every frame, and the host maps its box onto
 *  the current one. The source knows it without the worker echoing it — the
 *  `layer` reply's `req` names the render request it answers. */
export interface LayerSource {
  get(overlayId: string, frame: number): LayerBitmap | null;
  request(req: LayerRequest): void;
}

/** The export's source (`lib/sandbox/export-layers.ts`): every request for a
 *  frame is SETTLED — answered by a bitmap, an error or the watchdog — before
 *  `renderFrame` runs, so `get` hits exactly that frame or the overlay failed
 *  on it (spec §4.6). */
export interface SettledLayerSource extends LayerSource {
  settle(requests: LayerRequest[], at: { frame: number; time: number }): Promise<void>;
  /** Why the overlay drew nothing on the frame just settled, if it failed. */
  failureFor(overlayId: string): { phase: string; message: string; line?: number; column?: number } | undefined;
}

function sameWords(a: LayerRequest["words"], b: LayerRequest["words"]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((w, i) => w.text === b[i].text && w.start === b[i].start && w.end === b[i].end);
}

function sameVec(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Field-by-field equality over everything a render depends on. Requests are
 *  rebuilt by `planLayer` on every draw, so identity never matches. */
export function sameLayerRequest(a: LayerRequest, b: LayerRequest): boolean {
  if (a.overlayId !== b.overlayId || a.kind !== b.kind || a.frame !== b.frame) return false;
  if (a.pixelRatio !== b.pixelRatio || a.fps !== b.fps) return false;
  if (a.size.width !== b.size.width || a.size.height !== b.size.height) return false;
  const sa = a.fitSegment;
  const sb = b.fitSegment;
  if (sa || sb) {
    if (!sa || !sb) return false;
    if (sa.from.width !== sb.from.width || sa.from.height !== sb.from.height || sa.to.width !== sb.to.width || sa.to.height !== sb.to.height) return false;
  }
  const ta = a.time;
  const tb = b.time;
  if (
    ta.frame !== tb.frame ||
    ta.time !== tb.time ||
    ta.totalFrames !== tb.totalFrames ||
    ta.duration !== tb.duration ||
    ta.progress !== tb.progress ||
    ta.compositionTime !== tb.compositionTime ||
    ta.overlayStart !== tb.overlayStart ||
    ta.pieceDuration !== tb.pieceDuration
  ) {
    return false;
  }
  const pa = a.pad;
  const pb = b.pad;
  if (pa || pb) {
    if (!pa || !pb) return false;
    if (pa.left !== pb.left || pa.top !== pb.top || pa.right !== pb.right || pa.bottom !== pb.bottom) return false;
  }
  const xa = a.transform3d;
  const xb = b.transform3d;
  if (xa || xb) {
    if (!xa || !xb) return false;
    if (!sameVec(xa.position, xb.position) || !sameVec(xa.rotation, xb.rotation)) return false;
  }
  return sameWords(a.words, b.words);
}
