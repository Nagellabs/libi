import { promises as fs } from "fs";
import { join } from "path";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { duckGainCurve } from "@/lib/audio/duck-law";
import type { DuckSettings } from "@/lib/engine/types";

/**
 * Renders each ducked clip's gain curve to a WAV that the export graph
 * multiplies in, instead of asking ffmpeg's `sidechaincompress` to re-derive
 * the duck with a different compressor.
 *
 * See `lib/audio/duck-law.ts` for why: the two implementations diverged by
 * 5.2 dB on real material, so exported voice-overs sat buried under a bed that
 * sounded correctly ducked in the editor. A gain track is the only way to make
 * the export apply LITERALLY the preview's curve rather than an approximation
 * of it — and no amount of `sidechaincompress` parameter tuning came within
 * 4 dB of the target.
 *
 * Sample rate is pinned: the graph forces both the clip and the envelope to
 * `ENVELOPE_SAMPLE_RATE` before `amultiply`, which requires identical rates and
 * layouts on both inputs.
 */

/** Rate the envelope is generated at; the graph pins both sides to it. */
export const ENVELOPE_SAMPLE_RATE = 44100;

/** One sidechain clip, with everything needed to place it on the timeline. */
export interface PlacedSidechain {
  path: string;
  startTime: number;
  trimStart: number;
  duration: number;
  /**
   * The sidechain clip's own volume. The preview taps the sidechain AFTER its
   * gain node (`sc.gain.connect(worklet)` in web-audio-engine), so the
   * envelope has to see the same post-volume signal or the duck engages at a
   * different level than the editor showed.
   */
  volume: number;
}

export interface DuckEnvelopeInput {
  /** The clip being ducked — the key of the returned map. */
  clipId: string;
  duck: DuckSettings;
  /**
   * Every sidechain clip driving this duck, as placed on the timeline. They are
   * SUMMED into one mono buffer and the duck law runs ONCE over the sum — the
   * same thing Web Audio does for the preview when N sidechain gain nodes fan
   * into the worklet's one input. Per-clip curves multiplied together would
   * double-duck wherever two voices overlap.
   */
  sidechains: PlacedSidechain[];
}

/** Decode a whole audio file to mono float samples at `ENVELOPE_SAMPLE_RATE`. */
async function decodeMono(path: string, scratchDir: string, signal?: AbortSignal): Promise<Float32Array> {
  const raw = join(scratchDir, `sc-${Buffer.from(path).toString("base64url").slice(-24)}.f32`);
  await runFfmpeg(
    ["-y", "-i", path, "-vn", "-ac", "1", "-ar", String(ENVELOPE_SAMPLE_RATE), "-f", "f32le", raw],
    { op: "export_duck_envelope_decode", context: { path }, signal },
  );
  const buf = await fs.readFile(raw);
  await fs.rm(raw, { force: true });
  // Copy rather than view: the Buffer's byteOffset is not guaranteed aligned.
  const out = new Float32Array(Math.floor(buf.byteLength / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Minimal mono 32-bit-float WAV — self-describing, so ffmpeg needs no input flags. */
function encodeWavF32Mono(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28); // byte rate
  buf.writeUInt16LE(4, 32); // block align
  buf.writeUInt16LE(32, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeFloatLE(samples[i], 44 + i * 4);
  return buf;
}

/**
 * Lay a sidechain clip onto a timeline-length buffer at its start time,
 * honouring `trimStart`, `duration` and `volume`. Everything outside the clip
 * stays silent, so the duck releases there exactly as it does in the preview.
 *
 * Pass `into` to ACCUMULATE several sidechains onto one buffer — samples are
 * added, not overwritten, which is how N sidechains become the single summed
 * signal `duckGainCurve` reads. Without it a fresh zeroed buffer is returned.
 */
export function placeOnTimeline(
  decoded: Float32Array,
  sidechain: PlacedSidechain,
  timelineSamples: number,
  sampleRate: number,
  into?: Float32Array,
): Float32Array {
  const timeline = into ?? new Float32Array(timelineSamples);
  const from = Math.max(0, Math.round(sidechain.trimStart * sampleRate));
  const count = Math.max(0, Math.round(sidechain.duration * sampleRate));
  const at = Math.max(0, Math.round(sidechain.startTime * sampleRate));
  const n = Math.min(count, decoded.length - from, timelineSamples - at);
  for (let i = 0; i < n; i++) timeline[at + i] += decoded[from + i] * sidechain.volume;
  return timeline;
}

/**
 * Render one envelope WAV per ducked clip. Returns `clipId -> wav path`.
 * A clip whose sidechains all fail to decode is simply omitted — the caller
 * then mixes it undicked rather than failing the whole export.
 */
export async function renderDuckEnvelopes(opts: {
  inputs: DuckEnvelopeInput[];
  timelineSeconds: number;
  outDir: string;
  signal?: AbortSignal;
}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (opts.inputs.length === 0) return out;

  const timelineSamples = Math.max(1, Math.round(opts.timelineSeconds * ENVELOPE_SAMPLE_RATE));
  // One decode per distinct sidechain file, not per ducked clip — several clips
  // commonly duck against the same voice-over.
  const decoded = new Map<string, Float32Array>();

  for (const input of opts.inputs) {
    if (input.sidechains.length === 0) continue; // nothing drives the duck
    // Sum every sidechain into ONE buffer, then run the law once over the sum.
    // Not an average (the duck would go shallower with each VO line added) and
    // not a curve per clip multiplied together (that double-ducks on overlap).
    const timeline = new Float32Array(timelineSamples);
    for (const sidechain of input.sidechains) {
      let samples = decoded.get(sidechain.path);
      if (!samples) {
        samples = await decodeMono(sidechain.path, opts.outDir, opts.signal);
        decoded.set(sidechain.path, samples);
      }
      placeOnTimeline(samples, sidechain, timelineSamples, ENVELOPE_SAMPLE_RATE, timeline);
    }
    const curve = duckGainCurve(timeline, input.duck, ENVELOPE_SAMPLE_RATE);
    const path = join(opts.outDir, `duck-env-${input.clipId}.wav`);
    await fs.writeFile(path, encodeWavF32Mono(curve, ENVELOPE_SAMPLE_RATE));
    out.set(input.clipId, path);
  }
  return out;
}
