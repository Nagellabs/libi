import type { DuckSettings } from "@/lib/engine/types";

/** A single ducked-pair Web Audio graph. */
export interface DuckGraph {
  context: AudioContext;
  /** Music side — the GainNode whose `gain` AudioParam is driven by the
   *  envelope follower's output. */
  musicSource: MediaElementAudioSourceNode;
  musicGain: GainNode;
  /** Sidechain (dialogue / VO). */
  sidechainSource: MediaElementAudioSourceNode;
  /** The envelope follower. */
  worklet: AudioWorkletNode;
  dispose(): void;
}

let cachedContext: AudioContext | null = null;
let workletLoaded = false;
/**
 * `MediaElementAudioSource` can be created at most ONCE per HTMLMediaElement
 * across the lifetime of an AudioContext. A second `createMediaElementSource`
 * on the same element throws `InvalidStateError`. So if two duck graphs
 * share a sidechain (clip A and clip B both ducked by clip C), or the
 * graph is rebuilt (HMR remount, parameter change, disable→enable), we
 * MUST reuse the source node. This module-scope cache solves both.
 */
const sourceCache = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

async function getContext(): Promise<AudioContext> {
  if (!cachedContext) {
    cachedContext = new AudioContext();
  }
  if (!workletLoaded) {
    await cachedContext.audioWorklet.addModule("/worklets/sidechain-envelope.js");
    workletLoaded = true;
  }
  return cachedContext;
}

function getOrCreateSource(ctx: AudioContext, el: HTMLMediaElement): MediaElementAudioSourceNode {
  const existing = sourceCache.get(el);
  if (existing) return existing;
  const fresh = ctx.createMediaElementSource(el);
  sourceCache.set(el, fresh);
  return fresh;
}

/** Build a Web Audio graph that ducks `musicEl` using `sidechainEl` per
 *  the given parameters. The two `<audio>` elements continue to drive
 *  playback timing (currentTime, play, pause); we just route their
 *  output through the compressor.
 *
 *  AUTOPLAY POLICY NOTE: Chromium starts AudioContext in 'suspended' until
 *  a user gesture. The first `await ctx.resume()` may stay pending until
 *  the user clicks the play button. If the editor mounts ducked clips
 *  before the first play, the graph is built but produces no audio until
 *  the next click. The play button click counts as a gesture for the
 *  whole context — first audible playback may have a 50-200ms silence at
 *  the start of the track. Acceptable for MVP; can be addressed later
 *  with a "click anywhere to enable audio" gesture banner. For Electron,
 *  no autoplay flag tweak is needed — same behavior as web Chrome.
 */
export async function attachDuckGraph(
  musicEl: HTMLAudioElement,
  sidechainEl: HTMLAudioElement,
  duck: DuckSettings,
): Promise<DuckGraph> {
  const ctx = await getContext();
  if (ctx.state === "suspended") await ctx.resume();

  // Reuse cached source nodes — see `sourceCache` doc above. CRITICAL:
  // Calling `ctx.createMediaElementSource(el)` a second time on the same
  // element throws InvalidStateError, breaking sibling duck graphs.
  const musicSource = getOrCreateSource(ctx, musicEl);
  const sidechainSource = getOrCreateSource(ctx, sidechainEl);
  const musicGain = ctx.createGain();
  musicGain.gain.value = 1;

  const worklet = new AudioWorkletNode(ctx, "sidechain-envelope", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  // Feed the worklet's gain output into musicGain.gain — the AudioParam
  // accepts an audio-rate signal, which is exactly what we want: every
  // sample of the music gets multiplied by the current compressor gain.
  worklet.connect(musicGain.gain);

  // Sidechain → worklet input
  sidechainSource.connect(worklet);
  // Sidechain still needs to be audible — route it to destination.
  // (NOTE: connect() is idempotent at the (source, target) level — if
  // this is the second graph using this sidechain element, the previous
  // graph's connect-to-destination is still in effect; calling again is
  // a no-op rather than a duplicate edge.)
  sidechainSource.connect(ctx.destination);
  // Music → musicGain → destination
  musicSource.connect(musicGain).connect(ctx.destination);

  applyDuckParams(worklet, duck, ctx.sampleRate);

  return {
    context: ctx,
    musicSource,
    musicGain,
    sidechainSource,
    worklet,
    dispose: () => {
      // Disconnect THIS graph's nodes only. The cached source nodes
      // stay in place — disposing them would invalidate any sibling
      // graph using the same element.
      worklet.disconnect();
      musicGain.disconnect();
      // We can disconnect source-from-target for our specific edges but
      // not call source.disconnect() bare (that would tear down all of
      // its connections including a sibling's). Be precise:
      try { musicSource.disconnect(musicGain); } catch { /* no-op if already gone */ }
      // sidechainSource's connect to worklet is removed via worklet.disconnect()
      // (which severs upstream too). The connect-to-destination stays for
      // siblings that may still need the sidechain audible.
    },
  };
}

/** Push current parameters into the worklet's k-rate AudioParams. */
export function applyDuckParams(
  worklet: AudioWorkletNode,
  duck: DuckSettings,
  sampleRate: number,
): void {
  const thresholdLinear = Math.pow(10, duck.thresholdDb / 20);
  const reductionMin = Math.pow(10, duck.reductionDb / 20);
  // Convert ms time constants to one-pole coefficients.
  const attackCoeff = 1 - Math.exp(-1 / ((duck.attackMs / 1000) * sampleRate));
  const releaseCoeff = 1 - Math.exp(-1 / ((duck.releaseMs / 1000) * sampleRate));

  worklet.parameters.get("thresholdLinear")!.setValueAtTime(thresholdLinear, 0);
  worklet.parameters.get("ratio")!.setValueAtTime(duck.ratio, 0);
  worklet.parameters.get("attackCoeff")!.setValueAtTime(attackCoeff, 0);
  worklet.parameters.get("releaseCoeff")!.setValueAtTime(releaseCoeff, 0);
  worklet.parameters.get("reductionMin")!.setValueAtTime(reductionMin, 0);
}
