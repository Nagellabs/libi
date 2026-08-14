/**
 * Sidechain envelope follower — emits a per-frame compressor curve based
 * on the sidechain input's RMS envelope. The host wires this worklet's
 * "gain" output into a GainNode driving the music channel.
 *
 * Inputs: a single channel of sidechain audio (we mono-sum stereo).
 * Output: a single audio-rate channel whose value is the linear gain to
 * apply to the music (1.0 = no reduction, 0.5 = -6 dB, etc).
 *
 * Parameters:
 *   - thresholdLinear: above this RMS, compression engages
 *   - ratio: > 1
 *   - attackCoeff / releaseCoeff: per-sample smoothing coefficients
 *     (caller pre-computes from ms + sampleRate)
 *   - reductionMin: linear floor (e.g. 0.25 for -12 dB max reduction)
 */
class SidechainEnvelopeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "thresholdLinear", defaultValue: 0.0316, automationRate: "k-rate" }, // -30 dB
      { name: "ratio", defaultValue: 4, automationRate: "k-rate" },
      { name: "attackCoeff", defaultValue: 0.05, automationRate: "k-rate" },
      { name: "releaseCoeff", defaultValue: 0.001, automationRate: "k-rate" },
      { name: "reductionMin", defaultValue: 0.25, automationRate: "k-rate" }, // -12 dB
    ];
  }

  constructor() {
    super();
    this.envelope = 0;
    this.currentGain = 1;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const channel = input[0];
    const out = output[0];

    const threshold = params.thresholdLinear[0];
    const ratio = params.ratio[0];
    const attack = params.attackCoeff[0];
    const release = params.releaseCoeff[0];
    const reductionMin = params.reductionMin[0];

    for (let i = 0; i < channel.length; i++) {
      const sample = Math.abs(channel[i]);
      // Envelope follower with separate attack/release.
      const target = sample;
      const coeff = target > this.envelope ? attack : release;
      this.envelope = this.envelope + coeff * (target - this.envelope);

      // Linear-domain compressor: when envelope > threshold, scale by
      // (envelope/threshold)^(1 - 1/ratio) inverse, then clamp to floor.
      let gain = 1;
      if (this.envelope > threshold) {
        const overshoot = this.envelope / threshold;
        const reduction = Math.pow(overshoot, 1 - 1 / ratio);
        gain = 1 / reduction;
      }
      gain = Math.max(reductionMin, Math.min(1, gain));
      // Smooth the gain to avoid zipper noise.
      this.currentGain = this.currentGain + 0.01 * (gain - this.currentGain);
      out[i] = this.currentGain;
    }
    return true;
  }
}

registerProcessor("sidechain-envelope", SidechainEnvelopeProcessor);
