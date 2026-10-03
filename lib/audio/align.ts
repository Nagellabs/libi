/**
 * Where does a short excerpt sit inside a longer recording? `libi.audio_analyze` align: the agent
 * had a TikTok clip and the full song and wanted the continuation point, and built a numpy venv to
 * cross-correlate them. Pure: decoded mono samples in, an offset and a confidence out.
 *
 * Why spectral features and not the waveform or a loudness envelope: the excerpt is rarely a
 * bit-exact copy (a different codec, a gain, a voice or a bed under it), which defeats a raw
 * waveform correlation, and a bare loudness envelope matches every steady passage. So the match is
 * made on the SHAPE OF THE SPECTRUM over time: log energy in 24 bands, per-frame level removed
 * (survives a gain) and per-band average removed (survives an EQ or a codec), unit-length per
 * frame. The score at an offset is the mean cosine between the excerpt's frames and the recording's
 * frames there. Three stages keep it cheap on a 20-minute song: a coarse search at 40 ms frames, a
 * 10 ms refinement of the best offset (parabolic between frames), then a waveform correlation over
 * +/- 8 ms for sample-level alignment when the waveforms really do match.
 *
 * Confidence is how much the best offset STANDS OUT: (peak - runnerUp) / peak, scaled down when the
 * peak itself is weak. A song that repeats its chorus has near-equal peaks, so the confidence is
 * low and the repeats come back as `alternatives` for the caller to choose from.
 */

export const ALIGN_RATE = 8000;
const FRAME = 512;
const COARSE_HOP = 320; // 40 ms
const FINE_HOP = 80; // 10 ms
const BANDS = 24;
const LOW_HZ = 100;
const HIGH_HZ = 3800;
/** Excerpt seconds the search reads at most: the first part identifies it, and the cost grows with it. */
export const ALIGN_MAX_REFERENCE_SEC = 30;
/** Two candidates closer than this are one (a chorus repeat is seconds away, not tenths). */
const MIN_SEPARATION_SEC = 1;

export interface AlignOptions {
  /** Search only the recording from here (seconds into it). */
  windowFrom?: number;
  /** … until here. */
  windowTo?: number;
}

export interface AlignCandidate {
  /** Where the excerpt's first sample sits in the recording, seconds. */
  offsetSec: number;
  /** Mean cosine similarity, -1..1 (about 0.9 for the same material, near 0.1 for unrelated). */
  score: number;
}

export interface AlignResult extends AlignCandidate {
  /** 0..1: how much the best offset stands out from the next best one. Below ~0.35, do not trust it. */
  confidence: number;
  /** The next-best distinct offsets worth considering (a repeated section), best first; may be empty. */
  alternatives: AlignCandidate[];
}

// ── Features ───────────────────────────────────────────────────────────────

/** In-place radix-2 FFT of `re`/`im` (length a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const HANN = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));

/** FFT bin range [lo, hi) of each band: log-spaced between LOW_HZ and HIGH_HZ. */
const BAND_BINS: Array<[number, number]> = (() => {
  const binHz = ALIGN_RATE / FRAME;
  const edges = Array.from({ length: BANDS + 1 }, (_, i) => LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, i / BANDS));
  return Array.from({ length: BANDS }, (_, b) => {
    const lo = Math.max(1, Math.round(edges[b] / binHz));
    return [lo, Math.max(lo + 1, Math.round(edges[b + 1] / binHz))] as [number, number];
  });
})();

/**
 * Normalised spectral-shape frames of `x` from sample `from` to `to`, one every `hop` samples:
 * `frames * BANDS` floats, each frame unit length (a silent frame is all zeros and so scores 0 with
 * everything). See the file comment for what is removed and why.
 */
function features(x: Float32Array, from: number, to: number, hop: number): { data: Float32Array; frames: number } {
  const frames = Math.max(0, Math.floor((to - from - FRAME) / hop) + 1);
  const data = new Float32Array(frames * BANDS);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const live = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    const at = from + f * hop;
    let energy = 0;
    for (let i = 0; i < FRAME; i++) { const v = x[at + i]; re[i] = v * HANN[i]; im[i] = 0; energy += v * v; }
    if (energy < 1e-9) continue; // digital silence stays a zero frame
    fft(re, im);
    let mean = 0;
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = BAND_BINS[b][0]; k < BAND_BINS[b][1]; k++) e += re[k] * re[k] + im[k] * im[k];
      const l = Math.log(e + 1e-7);
      data[f * BANDS + b] = l;
      mean += l;
    }
    mean /= BANDS;
    for (let b = 0; b < BANDS; b++) data[f * BANDS + b] -= mean; // the frame's level
    live[f] = 1;
  }
  // The signal's own per-band average (its spectral tilt, a codec's roll-off).
  const bandMean = new Float64Array(BANDS);
  let liveCount = 0;
  for (let f = 0; f < frames; f++) {
    if (!live[f]) continue;
    liveCount++;
    for (let b = 0; b < BANDS; b++) bandMean[b] += data[f * BANDS + b];
  }
  for (let b = 0; b < BANDS; b++) bandMean[b] /= Math.max(1, liveCount);
  for (let f = 0; f < frames; f++) {
    if (!live[f]) continue;
    let norm = 0;
    for (let b = 0; b < BANDS; b++) { const v = (data[f * BANDS + b] -= bandMean[b]); norm += v * v; }
    norm = Math.sqrt(norm);
    for (let b = 0; b < BANDS; b++) data[f * BANDS + b] = norm > 1e-9 ? data[f * BANDS + b] / norm : 0;
  }
  return { data, frames };
}

/** Mean cosine between the excerpt's frames and the recording's frames starting at `lag` frames. */
function scoreLags(ref: { data: Float32Array; frames: number }, tgt: { data: Float32Array; frames: number }, lags: number): Float64Array {
  const out = new Float64Array(lags);
  const n = ref.frames * BANDS;
  for (let lag = 0; lag < lags; lag++) {
    const base = lag * BANDS;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += ref.data[i] * tgt.data[base + i];
    out[lag] = sum / ref.frames;
  }
  return out;
}

/** Local maxima of `s`, best first, at least `minSep` indices apart. */
function peaks(s: Float64Array, minSep: number, count: number): Array<{ at: number; v: number }> {
  const order = Array.from(s.keys()).sort((a, b) => s[b] - s[a]);
  const out: Array<{ at: number; v: number }> = [];
  for (const i of order) {
    if (out.every((p) => Math.abs(p.at - i) >= minSep)) out.push({ at: i, v: s[i] });
    if (out.length >= count) break;
  }
  return out;
}

/** The vertex of the parabola through three samples, as an offset in samples from the middle one (-0.5..0.5). */
function parabolic(l: number, m: number, r: number): number {
  const d = l - 2 * m + r;
  return d === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d));
}

/** Waveform alignment: the shift in -`reach`..`reach` samples that best correlates `ref` with `x` around `at`. Null when nothing matches. */
function waveformShift(ref: Float32Array, x: Float32Array, at: number, reach: number): number | null {
  const len = Math.min(ref.length, 8 * ALIGN_RATE);
  let refEnergy = 0;
  for (let i = 0; i < len; i++) refEnergy += ref[i] * ref[i];
  if (refEnergy < 1e-9 || at - reach < 0 || at + len + reach > x.length) return null;
  let best = -2;
  let bestShift = 0;
  for (let s = -reach; s <= reach; s++) {
    let dot = 0;
    let e = 0;
    for (let i = 0; i < len; i++) { const v = x[at + s + i]; dot += ref[i] * v; e += v * v; }
    const ncc = e > 0 ? dot / Math.sqrt(refEnergy * e) : 0;
    if (ncc > best) { best = ncc; bestShift = s; }
  }
  return best >= 0.2 ? bestShift : null;
}

/**
 * Align `reference` inside `target` (both mono float at `rate`, which must be ALIGN_RATE). Null when
 * the reference is longer than the part of the target searched, or too short to read.
 */
export function alignOffset(reference: Float32Array, target: Float32Array, rate: number, opts: AlignOptions = {}): AlignResult | null {
  if (rate !== ALIGN_RATE) throw new Error(`alignOffset works at ${ALIGN_RATE} Hz, got ${rate}`);
  const ref = reference.length > ALIGN_MAX_REFERENCE_SEC * rate ? reference.subarray(0, ALIGN_MAX_REFERENCE_SEC * rate) : reference;
  const winFrom = Math.max(0, Math.round((opts.windowFrom ?? 0) * rate));
  const winTo = Math.min(target.length, Math.round((opts.windowTo ?? Infinity) * rate));
  if (ref.length < FRAME * 4 || winTo - winFrom < ref.length) return null;

  // Stage 1: coarse, over the whole searched part.
  const refC = features(ref, 0, ref.length, COARSE_HOP);
  const tgtC = features(target, winFrom, winTo, COARSE_HOP);
  const lags = tgtC.frames - refC.frames + 1;
  if (refC.frames < 4 || lags < 1) return null;
  const coarse = scoreLags(refC, tgtC, lags);
  const minSep = Math.max(1, Math.round((MIN_SEPARATION_SEC * rate) / COARSE_HOP));
  const found = peaks(coarse, minSep, 4);
  const best = found[0];
  const second = found[1]?.v ?? 0;

  // Stage 2: refine the best at 10 ms.
  const centre = winFrom + best.at * COARSE_HOP;
  const pad = Math.round(0.2 * rate);
  const fineFrom = Math.max(0, centre - pad);
  const fineTo = Math.min(target.length, centre + ref.length + pad);
  const refF = features(ref, 0, ref.length, FINE_HOP);
  const tgtF = features(target, fineFrom, fineTo, FINE_HOP);
  let offsetSamples = centre;
  let score = best.v;
  const fineLags = tgtF.frames - refF.frames + 1;
  if (fineLags >= 1) {
    const fine = scoreLags(refF, tgtF, fineLags);
    // Only within +/- 0.1 s of the coarse answer: the coarse stage chose the neighbourhood.
    const mid = Math.round((centre - fineFrom) / FINE_HOP);
    const reach = Math.round(0.1 * rate / FINE_HOP);
    let bi = Math.min(fineLags - 1, Math.max(0, mid));
    for (let i = Math.max(0, mid - reach); i <= Math.min(fineLags - 1, mid + reach); i++) if (fine[i] > fine[bi]) bi = i;
    const frac = bi > 0 && bi < fineLags - 1 ? parabolic(fine[bi - 1], fine[bi], fine[bi + 1]) : 0;
    offsetSamples = fineFrom + (bi + frac) * FINE_HOP;
    score = Math.max(score, fine[bi]);
  }

  // Stage 3: the waveform, when it really is the same recording.
  const shift = waveformShift(ref, target, Math.round(offsetSamples), Math.round(0.008 * rate));
  if (shift !== null) offsetSamples = Math.round(offsetSamples) + shift;

  const margin = best.v > 0 ? Math.max(0, (best.v - second) / best.v) : 0;
  const confidence = Math.max(0, Math.min(1, margin * Math.min(1, Math.max(0, best.v) / 0.5)));
  return {
    offsetSec: offsetSamples / rate,
    score,
    confidence,
    alternatives: found.slice(1).filter((p) => p.v >= 0.7 * best.v).map((p) => ({ offsetSec: (winFrom + p.at * COARSE_HOP) / rate, score: p.v })),
  };
}
