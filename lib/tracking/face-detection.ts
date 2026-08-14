/**
 * Two-stage face detection: BlazeFace finds the face on the full frame,
 * then FaceLandmarker runs on a tight crop to recover the 478-landmark
 * mesh + 52 blendshapes used by the fingerprint identity gate.
 *
 * Why two stages: FaceLandmarker's internal face detector is BlazeFace
 * short-range, hard-wired for selfie-mode framing. On non-selfie footage
 * (music videos, wide shots) it returns zero faces even when the face is
 * clearly visible. Cropping the input around any reasonable bbox hint
 * — an anchor from the agent, or the prev-frame bbox — fixes it because
 * the face then fills the cropped input. See MediaPipe issues #4869 and
 * #5584.
 *
 * Browser-only. Imports `@mediapipe/tasks-vision`. Bundled into the
 * browser via the same esbuild pipeline that ships `track-entry.ts`.
 */
import {
  FilesetResolver,
  FaceLandmarker,
  FaceDetector,
} from "@mediapipe/tasks-vision";
import {
  computeFingerprint,
  landmarksToBbox,
  type FaceFingerprint,
  type NormalizedLandmark,
  type Blendshape,
} from "@/lib/tracking/face-fingerprint";
import {
  padBbox,
  clampBboxToFrame,
  translateBboxFromCrop,
  type Bbox,
} from "@/lib/tracking/face-detection-helpers";

export interface Detectors {
  landmarker: FaceLandmarker;
  detector: FaceDetector;
  /** Reused offscreen canvas for crops — avoids per-frame allocation. */
  cropCanvas: HTMLCanvasElement;
  cropCtx: CanvasRenderingContext2D;
}

export interface SetupOpts {
  /** Same baseUrl the runner injects via `__libiTrackConfig.modelBaseUrl`. */
  modelBaseUrl: string;
  numFaces?: number;
  /** Confidence floor; 0.3 is a good default for both detectors. */
  minConfidence?: number;
}

export async function setupDetectors(opts: SetupOpts): Promise<Detectors> {
  const conf = opts.minConfidence ?? 0.3;
  const fileset = await FilesetResolver.forVisionTasks(
    `${opts.modelBaseUrl}/mediapipe-vision/wasm`,
  );
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: `${opts.modelBaseUrl}/mediapipe-vision/models/face_landmarker.task`,
    },
    runningMode: "IMAGE",
    numFaces: opts.numFaces ?? 5,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: conf,
    minFacePresenceConfidence: conf,
    minTrackingConfidence: conf,
  });
  const detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: `${opts.modelBaseUrl}/mediapipe-vision/models/blaze_face_short_range.tflite`,
    },
    runningMode: "IMAGE",
    minDetectionConfidence: conf,
  });
  const cropCanvas = document.createElement("canvas");
  const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });
  if (!cropCtx) throw new Error("face-detection: 2d context unavailable");
  return { landmarker, detector, cropCanvas, cropCtx };
}

export function closeDetectors(d: Detectors): void {
  try { d.landmarker.close(); } catch { /* ignore */ }
  try { d.detector.close(); } catch { /* ignore */ }
}

/** Padding around a hint bbox when cropping. 50% on each side. */
const CROP_PAD = 0.5;
/** Padding around a BlazeFace detection when cropping. 30% — BlazeFace boxes are tighter. */
const BLAZE_PAD = 0.3;

export interface FaceResult {
  /** Bbox in **original video frame** coordinates. */
  bbox: Bbox;
  fingerprint: FaceFingerprint;
  landmarks: NormalizedLandmark[];
  blendshapes: Blendshape[];
  /** "hint" if a hint bbox was used; "blazeface" if BlazeFace seeded the crop. */
  source: "hint" | "blazeface";
}

/**
 * Detect a face at the current frame of `source`.
 *
 * `hintBbox` is the agent's anchor bbox (anchor loop) or the previous
 * frame's detected bbox (per-frame loop). When provided, we crop around
 * it directly. When absent or when the hint-crop yields nothing, we fall
 * back to BlazeFace on the full frame to seed a crop.
 *
 * Returns `null` when no face can be found in either path.
 */
export function detectFaceOnFrame(
  d: Detectors,
  source: CanvasImageSource,
  frameW: number,
  frameH: number,
  hintBbox: Bbox | null,
): FaceResult | null {
  // Path A: crop around the hint, if any.
  if (hintBbox) {
    const r = detectInCrop(d, source, frameW, frameH, hintBbox, CROP_PAD);
    if (r) return { ...r, source: "hint" };
  }

  // Path B: BlazeFace seeds the crop. Picks the highest-confidence
  // detection; downstream identity gate (in track-entry) sorts out which
  // is the correct subject.
  //
  // We capture the source frame into the offscreen cropCanvas first
  // instead of handing the raw <video> to BlazeFace. After a seek,
  // Chromium fires `seeked` once position updates but the new frame is
  // not yet ready for WebGL texImage2D reads — MediaPipe ends up sampling
  // a stale frame and returns zero detections. The 2D canvas drawImage
  // path forces the current frame to materialize synchronously.
  d.cropCanvas.width = frameW;
  d.cropCanvas.height = frameH;
  d.cropCtx.drawImage(source, 0, 0, frameW, frameH);
  const dets = d.detector.detect(d.cropCanvas).detections ?? [];
  if (dets.length === 0) return null;

  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < dets.length; i++) {
    const s = dets[i].categories?.[0]?.score ?? 0;
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }
  const best = dets[bestIdx].boundingBox;
  if (!best) return null;
  const seedBbox: Bbox = {
    x: best.originX, y: best.originY, w: best.width, h: best.height,
  };
  const r = detectInCrop(d, source, frameW, frameH, seedBbox, BLAZE_PAD);
  return r ? { ...r, source: "blazeface" } : null;
}

interface CroppedResult {
  bbox: Bbox;
  fingerprint: FaceFingerprint;
  landmarks: NormalizedLandmark[];
  blendshapes: Blendshape[];
}

/**
 * Crop `source` to `hint + padding` (clamped to frame), run FaceLandmarker
 * on the crop, translate the detected landmarks back to original-frame
 * coordinates, and return the fingerprint. Picks the detection with the
 * largest IoU vs the hint — important when multiple faces sit inside the
 * crop region.
 */
function detectInCrop(
  d: Detectors,
  source: CanvasImageSource,
  frameW: number,
  frameH: number,
  hint: Bbox,
  padding: number,
): CroppedResult | null {
  const padded = padBbox(hint, padding);
  const cropRect = clampBboxToFrame(padded, frameW, frameH);
  if (cropRect.w <= 0 || cropRect.h <= 0) return null;

  d.cropCanvas.width = cropRect.w;
  d.cropCanvas.height = cropRect.h;
  d.cropCtx.drawImage(
    source,
    cropRect.x, cropRect.y, cropRect.w, cropRect.h,
    0, 0, cropRect.w, cropRect.h,
  );

  const r = d.landmarker.detect(d.cropCanvas);
  const allLandmarks = r.faceLandmarks ?? [];
  if (allLandmarks.length === 0) return null;

  // Pick the detection whose bbox (translated to original coords) has the
  // best IoU with the hint. For single-face crops there's almost always
  // only one detection — this matters for crops that accidentally include
  // bystanders.
  let bestIdx = 0;
  let bestIou = -1;
  for (let i = 0; i < allLandmarks.length; i++) {
    const lms = allLandmarks[i] as NormalizedLandmark[];
    const inCrop = landmarksToBbox(lms, cropRect.w, cropRect.h);
    const inOrig = translateBboxFromCrop(inCrop, cropRect);
    const score = iouRect(hint, inOrig);
    if (score > bestIou) { bestIou = score; bestIdx = i; }
  }

  const landmarks = allLandmarks[bestIdx] as NormalizedLandmark[];
  const inCrop = landmarksToBbox(landmarks, cropRect.w, cropRect.h);
  const bbox = translateBboxFromCrop(inCrop, cropRect);

  const blendshapes = (r.faceBlendshapes?.[bestIdx] ?? { categories: [] })
    .categories as Blendshape[];
  // Landmarks are normalized to the crop canvas, so pass crop dims; the
  // IPD-normalized inter-landmark ratios computeFingerprint emits are
  // scale-invariant, so the resulting fingerprint matches one computed
  // against the full frame.
  const fingerprint = computeFingerprint(
    landmarks,
    blendshapes,
    cropRect.w,
    cropRect.h,
  );
  return { bbox, fingerprint, landmarks, blendshapes };
}

/** Local copy — keeps face-detection.ts self-contained for the test bundle. */
function iouRect(a: Bbox, b: Bbox): number {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.w, b.x + b.w);
  const iy2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}
