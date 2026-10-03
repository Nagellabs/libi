/**
 * Sidechain envelope follower — emits a per-frame compressor curve based
 * on the sidechain input's RMS envelope. The host wires this worklet's
 * "gain" output into a GainNode driving the music channel.
 *
 * Inputs: sidechain audio, mono-summed across ALL of its channels (the mean, as
 * the export's `-ac 1` decode does — so a voice panned hard to one side or
 * recorded on the right channel ducks exactly as it does in the file). An input
 * with no channels (nothing playing) is silence: the output stays a valid
 * gain, converging to 1.0.
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
    const output = outputs[0];
    // Nothing to write to: nothing downstream can hear this block.
    if (!output || !output[0]) return true;
    const out = output[0];
    // A sidechain that is not playing — before the narration starts, after it
    // ends, a clip whose file never loaded — reaches us as an input with ZERO
    // channels (`inputs[0]` is `[]`), not as a channel of zeros. That is
    // SILENCE, and silence means "no reduction". It must not be an early
    // return: the host's duck GainNode has an intrinsic gain of 0 and this
    // output is its sole driver, so a block left unwritten is a block of music
    // multiplied by 0. (That is how a ducked music clip went mute for the rest
    // of a piece once its narration ended.) Every output sample is written
    // below on every call; a missing input just reads as 0.
    const input = inputs[0];
    const channels = input && input.length > 0 ? input : null;
    const n = channels ? channels.length : 0;

    const threshold = params.thresholdLinear[0];
    const ratio = params.ratio[0];
    const attack = params.attackCoeff[0];
    const release = params.releaseCoeff[0];
    const reductionMin = params.reductionMin[0];

    for (let i = 0; i < out.length; i++) {
      // The mean of every channel, then the magnitude: reading only channel 0
      // left a right-channel or hard-panned voice unheard, and the export (which
      // decodes the sidechain `-ac 1`) did duck for it.
      let mono = 0;
      if (n === 1) mono = channels[0][i];
      else if (n > 1) {
        for (let c = 0; c < n; c++) mono += channels[c][i];
        mono /= n;
      }
      const sample = Math.abs(mono);
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
