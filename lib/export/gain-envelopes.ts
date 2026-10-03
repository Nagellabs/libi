import { promises as fs } from "fs";
import { join } from "path";
import {
  gainGrid,
  gridAt,
  shapeGainAt,
  clipGainAt,
  hasGainShape,
  crossfadePlan,
  type CrossfadePlan,
  type GainClip,
} from "@/lib/audio/clip-gain";
import type { AudioClip } from "@/lib/engine/types";
import { ENVELOPE_SAMPLE_RATE, encodeWavF32Mono } from "@/lib/export/duck-envelopes";

/**
 * Renders a clip's SHAPE (its volume envelope and crossfades) to a WAV that the
 * export graph multiplies in, the way it multiplies a duck's gain curve
 * (`duck-envelopes.ts`): a gain TRACK applies exactly the curve the preview
 * evaluates, where an ffmpeg `volume=…:eval=frame` expression is only right to
 * a frame and has to restate the easing in its own language.
 *
 * The shape comes from `shapeGainAt` (`lib/audio/clip-gain.ts`), the same law
 * the preview samples. The static gain (`volume` × `gainDb`) and the in/out
 * fades stay plain `volume=` / `afade` filters, so a clip with only those is
 * exported exactly as it was before there were envelopes.
 *
 * The track is in the CLIP's own time (sample 0 = the clip's first sample, after
 * `atrim`), because the graph multiplies it in before `adelay`. It runs past the
 * clip's end by a second, holding the last value, so a source that decodes a few
 * samples long is never left unmultiplied.
 */

/** Extra seconds past the clip the track holds its last value. */
const TAIL_S = 1;

export interface GainEnvelopeInput {
  clipId: string;
  /** What the shape is read from: the clip as the manifest has it (not the mix's re-timed copy). */
  clip: GainClip;
  /** Composition time the track's first sample is at. */
  startSec: number;
  /** Seconds of the clip the track covers. */
  durationSec: number;
  plan: CrossfadePlan;
}

/** Whether a clip needs an envelope track at all (an envelope or a crossfade). */
export function needsGainEnvelope(clip: GainClip, plan: CrossfadePlan): boolean {
  return hasGainShape(clip, plan);
}

/** The track's samples: the 1 kHz shape grid, linearly interpolated to the envelope rate. */
export function renderShapeSamples(input: GainEnvelopeInput): Float32Array {
  const grid = gainGrid((t) => shapeGainAt(input.clip, input.plan, t), input.startSec, input.durationSec + TAIL_S);
  const n = Math.max(1, Math.ceil((input.durationSec + TAIL_S) * ENVELOPE_SAMPLE_RATE));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = gridAt(grid, i / ENVELOPE_SAMPLE_RATE);
  return out;
}

/** One envelope WAV per input. Returns `clipId -> wav path`. */
export async function renderGainEnvelopes(opts: {
  inputs: GainEnvelopeInput[];
  outDir: string;
}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const input of opts.inputs) {
    const path = join(opts.outDir, `gain-env-${input.clipId}.wav`);
    await fs.writeFile(path, encodeWavF32Mono(renderShapeSamples(input), ENVELOPE_SAMPLE_RATE));
    out.set(input.clipId, path);
  }
  return out;
}

/** The crossfades among the manifest's enabled clips: one plan for the whole mix. */
export function planCrossfades(manifestClips: readonly AudioClip[]): CrossfadePlan {
  return crossfadePlan(manifestClips);
}

/**
 * A sidechain clip's level over composition time for the duck's summed signal,
 * read from the manifest's clip (the mix may hold a re-timed copy). `undefined`
 * for a clip whose level is its plain `volume` (the constant path is exact).
 */
export function sidechainGainAt(
  sc: AudioClip,
  manifestById: ReadonlyMap<string, AudioClip>,
  plan: CrossfadePlan,
): ((t: number) => number) | undefined {
  const orig = manifestById.get(sc.id) ?? sc;
  const plain = !orig.gainDb && !hasGainShape(orig, plan) && !orig.effects;
  return plain ? undefined : (t) => clipGainAt(orig, plan, t);
}

/**
 * Render the shape track of every clip in the mix that has one. `mixClips` are
 * the clips as the mix takes them (a base's audio can arrive re-timed);
 * `manifestClips` are the manifest's, which the shape is read from and the
 * crossfades are planned over. Returns `clipId -> wav path`.
 */
export async function renderClipShapeEnvelopes(opts: {
  mixClips: readonly AudioClip[];
  manifestClips: readonly AudioClip[];
  plan: CrossfadePlan;
  outDir: string;
}): Promise<Map<string, string>> {
  const byId = new Map(opts.manifestClips.map((c) => [c.id, c]));
  const inputs: GainEnvelopeInput[] = [];
  for (const c of opts.mixClips) {
    const orig = byId.get(c.id) ?? c;
    if (!needsGainEnvelope(orig, opts.plan)) continue;
    inputs.push({ clipId: c.id, clip: orig, startSec: c.startTime, durationSec: c.duration, plan: opts.plan });
  }
  return renderGainEnvelopes({ inputs, outDir: opts.outDir });
}
