import type { DuckSettings } from "@/lib/engine/types";
import { duckReductionFloor } from "@/lib/audio/duck-params";

/**
 * THE duck law — one definition of what sidechain ducking means in libi.
 *
 * There are two places a duck has to be applied: the preview, in real time,
 * through `public/worklets/sidechain-envelope.js`; and the export, offline,
 * through ffmpeg. They must produce the same gain, and the only way to be sure
 * of that is for both to run the same arithmetic.
 *
 * They did not, and it cost two rounds of user-visible damage. The export used
 * ffmpeg's `sidechaincompress` — a genuinely different compressor, with an RMS
 * detector and a soft knee where this law uses a peak-ish envelope and a hard
 * clamp. On real material that gap measured **5.2 dB**: the preview ducked the
 * music 7.0 dB under speech, the export only 1.8 dB, so the voice sat buried in
 * every exported file while sounding correct in the editor. No amount of
 * parameter tuning closed it (`detection=peak`, `knee=1` and every `mix`
 * variant all landed within 1 dB of each other, and 5 dB from the target),
 * because the transfer curves are shaped differently. The export now renders
 * THIS curve to a gain track and multiplies it in, so parity is structural
 * rather than something a reviewer has to notice.
 *
 * `__tests__/unit/audio/duck-law-parity.test.ts` runs the worklet's own source
 * against this module sample-for-sample. If you change one, that test fails.
 */

/** Per-sample coefficients — the worklet's AudioParams, and this module's loop. */
export interface DuckCoefficients {
  /** Sidechain level above which ducking engages, linear. */
  thresholdLinear: number;
  ratio: number;
  /** One-pole smoothing coefficients derived from attack/release in ms. */
  attackCoeff: number;
  releaseCoeff: number;
  /** Hard floor on the gain — the deepest the duck may ever go. */
  reductionMin: number;
}

/** Smoothing applied to the computed gain, per sample, to avoid zipper noise. */
export const GAIN_SMOOTHING = 0.01;

export function duckCoefficients(duck: DuckSettings, sampleRate: number): DuckCoefficients {
  return {
    thresholdLinear: Math.pow(10, duck.thresholdDb / 20),
    ratio: duck.ratio,
    attackCoeff: 1 - Math.exp(-1 / ((duck.attackMs / 1000) * sampleRate)),
    releaseCoeff: 1 - Math.exp(-1 / ((duck.releaseMs / 1000) * sampleRate)),
    reductionMin: duckReductionFloor(duck.reductionDb),
  };
}

/**
 * The gain to apply to the ducked clip, one value per sidechain sample.
 *
 * `sidechain` is the sidechain signal already laid out on the TIMELINE — same
 * length, same origin, and same sample rate as the clip being ducked, with
 * silence wherever no sidechain is playing. Returns values in
 * `[reductionMin, 1]`; never above 1, so a duck can only ever attenuate.
 *
 * With several sidechain clips, `sidechain` is their SUM — one buffer, one pass
 * of this law. That is deliberate and both engines do it: the preview fans all
 * N sidechain gain nodes into the worklet's single input (Web Audio sums
 * fan-in), and the export accumulates the placed clips into one mono buffer
 * before calling this. Averaging would make the duck shallower as VO lines are
 * added; computing a curve per clip and multiplying them would double-duck
 * wherever two voices overlap, and could reach reductionMin².
 */
export function duckGainCurve(
  sidechain: Float32Array,
  duck: DuckSettings,
  sampleRate: number,
): Float32Array {
  const { thresholdLinear, ratio, attackCoeff, releaseCoeff, reductionMin } =
    duckCoefficients(duck, sampleRate);
  const out = new Float32Array(sidechain.length);
  const exponent = 1 - 1 / ratio;

  let envelope = 0;
  let currentGain = 1;
  for (let i = 0; i < sidechain.length; i++) {
    const target = Math.abs(sidechain[i]);
    const coeff = target > envelope ? attackCoeff : releaseCoeff;
    envelope += coeff * (target - envelope);

    let gain = 1;
    if (envelope > thresholdLinear) {
      gain = 1 / Math.pow(envelope / thresholdLinear, exponent);
    }
    gain = Math.max(reductionMin, Math.min(1, gain));
    currentGain += GAIN_SMOOTHING * (gain - currentGain);
    out[i] = currentGain;
  }
  return out;
}
