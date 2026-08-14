/**
 * Pure frame-range arithmetic for the chunked export pipeline.
 *
 * `exportVideo` can render a sub-range of the composition (one chunk of a
 * chunked parallel render). Each chunk file starts at t=0 — the encoder
 * timestamp is chunk-LOCAL — and reports chunk-local progress. Extracting the
 * per-frame math here keeps it unit-testable without pulling in the
 * mediabunny/WebCodecs-bound `export.ts`.
 */

export interface FrameRange {
  /** First composition frame this chunk renders (inclusive). */
  startFrame: number;
  /** One past the last composition frame this chunk renders (exclusive). */
  endFrameExclusive: number;
}

/**
 * Per-frame encode metadata for a chunk render.
 *
 * @param frame   absolute composition frame index (startFrame..endFrameExclusive-1)
 * @param range   the chunk's frame range
 * @param fps     composition frame rate
 * @returns `timestamp` — the chunk-local encoder timestamp in seconds (chunk
 *          starts at 0); `progress` — chunk-local completion fraction (0..1]
 *          after this frame is encoded.
 */
export function chunkFrameMeta(
  frame: number,
  range: FrameRange,
  fps: number,
): { timestamp: number; progress: number } {
  const chunkFrames = range.endFrameExclusive - range.startFrame;
  const local = frame - range.startFrame;
  const timestamp = local / fps;
  const progress = chunkFrames > 0 ? (local + 1) / chunkFrames : 1;
  return { timestamp, progress };
}
