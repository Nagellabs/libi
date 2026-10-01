/**
 * Pure chunk planning for the chromium-render parallel export path.
 *
 * The runner splits the composition's frame range into N contiguous chunks,
 * renders each in its own headless page concurrently, then ffmpeg-concats the
 * per-chunk files. No node imports here — this is pure arithmetic so it's
 * cheaply unit-testable.
 */

/**
 * Below this many frames the split isn't worth the per-page boot overhead —
 * render as a single chunk. 450 frames = 15 s @ 30fps.
 */
export const RENDER_CHUNK_MIN_FRAMES = 450;

export interface RenderChunk {
  startFrame: number;
  endFrameExclusive: number;
}

/**
 * Plan the chunk boundaries for a `totalFrames`-frame composition across up to
 * `workers` parallel pages.
 *
 * Semantics:
 *  - `n = max(1, min(workers, floor(totalFrames / RENDER_CHUNK_MIN_FRAMES)))`
 *  - `chunkSize = ceil(totalFrames / n)`
 *  - chunks are contiguous, ordered, and cover `[0, totalFrames)` exactly once
 *  - no empty chunks
 *  - `totalFrames <= 0` → `[]`
 */
export function planRenderChunks(
  totalFrames: number,
  workers: number,
): RenderChunk[] {
  if (totalFrames <= 0) return [];
  const n = Math.max(
    1,
    Math.min(workers, Math.floor(totalFrames / RENDER_CHUNK_MIN_FRAMES)),
  );
  const chunkSize = Math.ceil(totalFrames / n);
  const chunks: RenderChunk[] = [];
  for (let start = 0; start < totalFrames; start += chunkSize) {
    chunks.push({
      startFrame: start,
      endFrameExclusive: Math.min(start + chunkSize, totalFrames),
    });
  }
  return chunks;
}

/**
 * Resolve the number of parallel render pages, mode-aware.
 *
 * Empirically, chunking only pays off in SOFTWARE render mode — there each
 * headless page is its own renderer PROCESS, so N pages use N cores. In GPU
 * mode the pages time-slice a single GPU/encoder, so chunking measured ~1.04×
 * (GPU-bound); default to a single page there.
 *
 * Semantics:
 *  - explicit `env` integer wins in BOTH directions: `>= 2` forces chunking
 *    even in GPU mode; `<= 1` disables it; a non-numeric value is ignored
 *    (falls through to the mode default).
 *  - no usable env + `mode === "software"` → `min(4, max(1, cpuCount - 2))`
 *    (leave a couple cores for ffmpeg + the Next server).
 *  - no usable env + `mode === "gpu"` or `undefined` → `1` (single page).
 *  - `held`: pages other renders already run. The answer is
 *    `min(normal, cpuCount − 2 − held)`, at least 1 (spec 2026-09-29 §B1).
 *    An explicit env override is a developer's choice and ignores it.
 */
export function resolveChunkWorkers(
  env: string | undefined,
  mode: "gpu" | "software" | undefined,
  cpuCount: number,
  /** Workers other renders running right now already hold (lib/export/scheduler.ts#leaseRenderWorkers). */
  held = 0,
): number {
  if (env !== undefined && env !== "") {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n)) return n <= 1 ? 1 : n;
    // Non-numeric override → ignore it, fall through to the mode default.
  }
  const normal = mode === "software" ? Math.min(4, Math.max(1, cpuCount - 2)) : 1;
  // Several renders share the machine: never more than the cores the others leave (spec §B1).
  return Math.max(1, Math.min(normal, cpuCount - 2 - held));
}

/**
 * Aggregate per-chunk frame counts into a single "frames done" total for the
 * runner's `reportProgress` roll-up.
 */
export function sumChunkProgress(doneByChunk: number[]): number {
  let total = 0;
  for (const d of doneByChunk) total += d;
  return total;
}
