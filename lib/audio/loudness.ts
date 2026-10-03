/**
 * Loudness of a rendered mix, as `libi.audio_analyze` reports it: ITU-R BS.1770-4 K-weighted LUFS
 * (integrated with the absolute and relative gates, and the loudest 3 s "short-term" window), RMS
 * and sample peak. Pure: it takes decoded samples and knows nothing about files or ffmpeg.
 *
 * The mix is analysed as 48 kHz INTERLEAVED STEREO float (what `lib/export/audio-measure.ts`
 * decodes), because the BS.1770 filter coefficients are the standard's own at that rate. A
 * channel's weight is 1 (left, right); there is no surround.
 *
 * Why K-weighted LUFS and not just RMS: RMS is blind to frequency, so a bass-heavy bed and a
 * voice at the same RMS sit at different perceived levels, and "is the music too loud under the
 * narration" is a perceived-level question. RMS and peak are reported next to it because they are
 * what a clipping check and a `volumedetect`-style comparison read.
 */

export const LOUDNESS_RATE = 48000;
/** What a level at or below silence reports (dBFS), so it is a number a result can carry. */
export const SILENCE_DB = -90;
/** A peak at or under this is silence for the `silent` flag. */
const SILENT_PEAK_DB = -80;

/** BS.1770 stage 1 (the head's high shelf) at 48 kHz. */
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] } as const;
/** BS.1770 stage 2 (the revised low-frequency high-pass) at 48 kHz. */
const HIGHPASS = { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] } as const;

const BLOCK_SEGMENTS = 4; // 400 ms momentary block …
const SHORT_TERM_SEGMENTS = 30; // … and 3 s short-term window, both stepping by one 100 ms segment
const SEGMENT_FRAMES = LOUDNESS_RATE / 10;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

export interface LoudnessResult {
  /** Seconds analysed (the pre-roll is not counted). */
  durationSec: number;
  /** Integrated, gated. Null when the range is shorter than one 400 ms block or never rises above -70 LUFS. */
  lufs: number | null;
  /** The loudest 3 s window, ungated. Null for a range shorter than 3 s. */
  shortTermMaxLufs: number | null;
  /** RMS of both channels together, dBFS (a full-scale sine reads -3.01). SILENCE_DB at silence. */
  rmsDb: number;
  /** Largest absolute sample of either channel, dBFS (can exceed 0: the mix is float before the encoder). */
  peakDb: number;
  silent: boolean;
}

const toDb = (linear: number): number => (linear > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(linear)) : SILENCE_DB);
const lufsOf = (energy: number): number => -0.691 + 10 * Math.log10(energy);

/** Run one biquad (transposed direct form II) in place over a channel of `n` frames, interleaved stride 2. */
function biquad(x: Float64Array, c: { b: readonly number[]; a: readonly number[] }): void {
  const [b0, b1, b2] = c.b;
  const [, a1, a2] = c.a;
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    x[i] = y;
  }
}

/**
 * Analyse interleaved stereo float samples at LOUDNESS_RATE. `preRollSamples` (interleaved sample
 * count, 2 per frame) leading samples feed the K-weighting filters but are left out of every number:
 * a range cut out of the middle of a mix starts its filters warm.
 */
export function analyzeLoudness(samples: Float32Array, opts: { preRollSamples?: number } = {}): LoudnessResult {
  const frames = Math.floor(samples.length / 2);
  const pre = Math.min(frames, Math.max(0, Math.floor((opts.preRollSamples ?? 0) / 2)));
  const n = frames - pre;
  const durationSec = n / LOUDNESS_RATE;

  // RMS and peak straight off the samples (the pre-roll excluded).
  let sumSq = 0;
  let peak = 0;
  for (let i = pre * 2; i < frames * 2; i++) {
    const v = samples[i];
    sumSq += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rmsDb = n > 0 ? toDb(Math.sqrt(sumSq / (n * 2))) : SILENCE_DB;
  const peakDb = toDb(peak);
  const base = { durationSec, rmsDb, peakDb, silent: peakDb <= SILENT_PEAK_DB };
  if (n < BLOCK_SEGMENTS * SEGMENT_FRAMES) return { ...base, lufs: null, shortTermMaxLufs: null };

  // K-weighted energy per 100 ms segment, both channels summed.
  const segments = Math.floor(n / SEGMENT_FRAMES);
  const segEnergy = new Float64Array(segments);
  for (let ch = 0; ch < 2; ch++) {
    const x = new Float64Array(frames);
    for (let i = 0; i < frames; i++) x[i] = samples[2 * i + ch];
    biquad(x, SHELF);
    biquad(x, HIGHPASS);
    for (let s = 0; s < segments; s++) {
      let e = 0;
      const from = pre + s * SEGMENT_FRAMES;
      for (let i = from; i < from + SEGMENT_FRAMES; i++) e += x[i] * x[i];
      segEnergy[s] += e;
    }
  }

  // Sliding sums over the segment energies: the momentary block and the short-term window.
  const windowEnergy = (len: number): Float64Array => {
    const count = segments - len + 1;
    if (count <= 0) return new Float64Array(0);
    const out = new Float64Array(count);
    let run = 0;
    for (let i = 0; i < len; i++) run += segEnergy[i];
    out[0] = run;
    for (let i = 1; i < count; i++) {
      run += segEnergy[i + len - 1] - segEnergy[i - 1];
      out[i] = run;
    }
    return out;
  };

  const blocks = windowEnergy(BLOCK_SEGMENTS).map((e) => e / (BLOCK_SEGMENTS * SEGMENT_FRAMES));
  const aboveAbsolute = Array.from(blocks).filter((e) => e > 0 && lufsOf(e) > ABSOLUTE_GATE_LUFS);
  let lufs: number | null = null;
  if (aboveAbsolute.length > 0) {
    const mean = aboveAbsolute.reduce((a, b) => a + b, 0) / aboveAbsolute.length;
    const relativeGate = lufsOf(mean) + RELATIVE_GATE_LU;
    const kept = aboveAbsolute.filter((e) => lufsOf(e) > relativeGate);
    if (kept.length > 0) lufs = lufsOf(kept.reduce((a, b) => a + b, 0) / kept.length);
  }

  let shortTermMaxLufs: number | null = null;
  if (segments >= SHORT_TERM_SEGMENTS) {
    const max = windowEnergy(SHORT_TERM_SEGMENTS).reduce((m, e) => Math.max(m, e), 0) / (SHORT_TERM_SEGMENTS * SEGMENT_FRAMES);
    shortTermMaxLufs = max > 0 ? lufsOf(max) : null;
  }
  return { ...base, lufs, shortTermMaxLufs };
}
