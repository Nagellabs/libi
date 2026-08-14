/**
 * Pure audio-peaks helpers for the timeline waveform. Decoding (Web Audio) lives
 * in the hook; this file only does the math so it's unit-testable without a
 * browser.
 */

/**
 * Downsample mono PCM samples to `buckets` normalized peak amplitudes (0..1).
 * Each bucket is the MAX absolute sample over its slice — the standard "peak"
 * waveform (loud sections render tall). Returns a `buckets`-length array; an
 * empty/zero input yields all-zeros.
 */
export function computePeaks(samples: Float32Array, buckets: number): number[] {
  const n = Math.max(1, Math.floor(buckets));
  const out = new Array<number>(n).fill(0);
  if (samples.length === 0) return out;
  const per = samples.length / n;
  for (let b = 0; b < n; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(samples.length, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    out[b] = peak > 1 ? 1 : peak;
  }
  return out;
}

/**
 * The slice of a peaks array that a clip shows on the timeline: the source
 * window `[trimStart, trimStart + duration)` mapped onto the full-source peaks.
 * `sourceDuration` is the decoded buffer's length in seconds. Clamped to the
 * array bounds. Returns the whole array when the window is unknown/degenerate.
 */
export function peaksWindow(
  peaks: number[],
  sourceDuration: number,
  trimStart: number,
  duration: number,
): number[] {
  if (!peaks.length || !(sourceDuration > 0) || !(duration > 0)) return peaks;
  const startFrac = Math.max(0, Math.min(1, trimStart / sourceDuration));
  const endFrac = Math.max(startFrac, Math.min(1, (trimStart + duration) / sourceDuration));
  const a = Math.floor(startFrac * peaks.length);
  const b = Math.max(a + 1, Math.ceil(endFrac * peaks.length));
  return peaks.slice(a, b);
}
