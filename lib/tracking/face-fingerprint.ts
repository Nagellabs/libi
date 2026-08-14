/**
 * Pure helpers for MediaPipe Face Landmarker fingerprinting.
 *
 * Dual-importable: bundled into the Playwright Chromium page by esbuild
 * (platform: "browser") and importable in Node for unit tests.
 *
 * Fingerprints capture stable geometric inter-landmark distances and
 * blendshape coefficients so we can disambiguate faces across frames
 * without descriptor embeddings or neural face recognition.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NormalizedLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface Blendshape {
  /** Score in [0, 1]. */
  score: number;
}

/**
 * Derived fingerprint for one face detection.
 *
 * - `geometry`:   ~20 stable inter-landmark distances, normalised by
 *                 inter-pupil distance, packed into a Float32Array.
 * - `blendshapes`: the 52-dim blendshape coefficient vector as-is.
 */
export interface FaceFingerprint {
  geometry: Float32Array;
  blendshapes: Float32Array;
}

// ─── Landmark indices (MediaPipe 478-point canonical map) ────────────────────
// See https://mediapipe.dev/solutions/face_landmarker (landmark map PDF)
// Stable inter-landmark distance pairs: eye corners, brow endpoints, jaw width,
// nose-to-chin, nose bridge, lip width, lip height.

const LEFT_EYE_INNER = 133;
const RIGHT_EYE_INNER = 362;
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const LEFT_EYE_TOP = 159;
const LEFT_EYE_BOTTOM = 145;
const RIGHT_EYE_TOP = 386;
const RIGHT_EYE_BOTTOM = 374;
const NOSE_BRIDGE = 6;
const NOSE_TIP = 4;
const NOSE_BOTTOM = 2;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;
const CHIN = 152;
const FOREHEAD = 10;
const LEFT_JAW = 356;
const RIGHT_JAW = 127;
const LEFT_LIP_CORNER = 61;
const RIGHT_LIP_CORNER = 291;
const UPPER_LIP_TOP = 0;
const LOWER_LIP_BOTTOM = 17;

/**
 * Convert normalized landmarks to pixel-space bounding box.
 *
 * Face Landmarker does not emit a boundingBox directly, so we compute it
 * from the extent of the 478 normalized landmarks scaled to intrinsic video
 * dimensions. Uses `videoWidth` / `videoHeight`, NOT display size.
 */
export function landmarksToBbox(
  landmarks: NormalizedLandmark[],
  videoW: number,
  videoH: number,
): Rect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const lm of landmarks) {
    if (lm.x < minX) minX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y > maxY) maxY = lm.y;
  }
  return {
    x: minX * videoW,
    y: minY * videoH,
    w: (maxX - minX) * videoW,
    h: (maxY - minY) * videoH,
  };
}

/**
 * Pixel distance between two landmarks (in the video's intrinsic pixel space).
 */
function pixelDist(
  a: NormalizedLandmark,
  b: NormalizedLandmark,
  videoW: number,
  videoH: number,
): number {
  const dx = (a.x - b.x) * videoW;
  const dy = (a.y - b.y) * videoH;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute a FaceFingerprint from a Face Landmarker detection.
 *
 * @param landmarks  The 478 normalized landmarks from the detection.
 * @param blendshapes  The 52 blendshape scores from the detection.
 * @param videoW  Intrinsic video width in pixels.
 * @param videoH  Intrinsic video height in pixels.
 */
export function computeFingerprint(
  landmarks: NormalizedLandmark[],
  blendshapes: Blendshape[],
  videoW: number,
  videoH: number,
): FaceFingerprint {
  // Inter-pupil distance as the normalisation baseline.
  // Use inner eye corners for robustness (they move less than outer corners).
  const leftInner = landmarks[LEFT_EYE_INNER];
  const rightInner = landmarks[RIGHT_EYE_INNER];
  const ipd = pixelDist(leftInner, rightInner, videoW, videoH) + 1e-6;

  // ~20 stable inter-landmark distances, normalised by IPD.
  const pairs: [number, number][] = [
    [LEFT_EYE_INNER, RIGHT_EYE_INNER],    // 0  inter-pupil (always 1 after norm)
    [LEFT_EYE_OUTER, RIGHT_EYE_OUTER],    // 1  outer eye width
    [LEFT_EYE_TOP, LEFT_EYE_BOTTOM],      // 2  left eye height
    [RIGHT_EYE_TOP, RIGHT_EYE_BOTTOM],    // 3  right eye height
    [NOSE_BRIDGE, NOSE_TIP],              // 4  nose length (bridge to tip)
    [NOSE_TIP, NOSE_BOTTOM],              // 5  nasal tip to base
    [LEFT_CHEEK, RIGHT_CHEEK],            // 6  cheekbone width
    [FOREHEAD, CHIN],                     // 7  face height
    [LEFT_JAW, RIGHT_JAW],               // 8  jaw width
    [LEFT_LIP_CORNER, RIGHT_LIP_CORNER], // 9  mouth width
    [UPPER_LIP_TOP, LOWER_LIP_BOTTOM],   // 10 mouth height
    [NOSE_BRIDGE, FOREHEAD],             // 11 nose-to-forehead
    [NOSE_BRIDGE, CHIN],                 // 12 nose-bridge to chin
    [LEFT_EYE_INNER, NOSE_TIP],          // 13 left eye to nose
    [RIGHT_EYE_INNER, NOSE_TIP],         // 14 right eye to nose
    [LEFT_EYE_OUTER, LEFT_CHEEK],        // 15 left eye to cheek
    [RIGHT_EYE_OUTER, RIGHT_CHEEK],      // 16 right eye to cheek
    [LEFT_JAW, CHIN],                    // 17 jaw taper left
    [RIGHT_JAW, CHIN],                   // 18 jaw taper right
    [NOSE_BRIDGE, UPPER_LIP_TOP],        // 19 nose to upper lip
  ];

  const geometry = new Float32Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) {
    const [ai, bi] = pairs[i];
    if (ai < landmarks.length && bi < landmarks.length) {
      geometry[i] = pixelDist(landmarks[ai], landmarks[bi], videoW, videoH) / ipd;
    }
  }

  // Blendshape vector (52 coefficients, already in [0, 1]).
  const bsArr = new Float32Array(blendshapes.length);
  for (let i = 0; i < blendshapes.length; i++) {
    bsArr[i] = blendshapes[i].score;
  }

  return { geometry, blendshapes: bsArr };
}

/**
 * Weighted cosine similarity of two fingerprints, in [0, 1].
 *
 * Geometry gets 70% weight, blendshapes 30%. Blendshape weight is lower
 * because expression change (blinking, talking) can shift scores significantly
 * across frames of the same person.
 */
export function fingerprintSimilarity(a: FaceFingerprint, b: FaceFingerprint): number {
  const geomSim = cosineSim(a.geometry, b.geometry);
  const bsSim = a.blendshapes.length > 0 && b.blendshapes.length > 0
    ? cosineSim(a.blendshapes, b.blendshapes)
    : 0.5; // neutral if absent
  return 0.7 * geomSim + 0.3 * bsSim;
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < 1e-9) return 0;
  return Math.max(0, Math.min(1, dot / denom));
}

/**
 * Intersection-over-Union of two pixel-space Rect objects.
 * Re-exported here so face-fingerprint.ts can be the single shared module
 * for all face-tracking geometry utilities bundled into track-entry.
 */
export function iouRect(a: Rect, b: Rect): number {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.w, b.x + b.w);
  const iy2 = Math.min(a.y + a.h, b.y + b.h);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}
