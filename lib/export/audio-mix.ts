import type { AudioClip } from "@/lib/engine/types";
import { audioFadeSeconds } from "@/lib/effects/audio-envelope";

/**
 * Shared, pure builder for the audio half of an ffmpeg `filter_complex` graph.
 * Used by BOTH export audio paths so they mix identically:
 *
 *  - the single-video `ffmpeg-overlay` backend (base scene audio via `[0:a]`
 *    time-sliced by `-ss/-to`, plus standalone clips), and
 *  - the multi-scene `chromium-render` audio mux (no base audio — the rendered
 *    file is video-only — so EVERY clip, inline scene-audio included, is a
 *    delayed/trimmed input).
 *
 * Per-clip chain (matching the preview's audio policy in
 * `lib/audio/web-audio-engine.ts` + `lib/audio/active-clips.ts`):
 *   - `atrim={trimStart}:{trimStart+duration}` + `asetpts=PTS-STARTPTS` —
 *     take the window of the SOURCE the clip actually plays (honours
 *     `clip.trimStart`; the preview seeks into the source the same way).
 *   - `volume={0..1}` — per-clip level.
 *   - `adelay={ms}|{ms}` — place the clip at `startTime` on the timeline
 *     (stereo-safe syntax).
 *   - optional `sidechaincompress` — sidechain ducking driven by another clip
 *     (`clip.duck`), dB→linear threshold + attack/release in SECONDS.
 *
 * Output label: `[aout]`. Returns `{ chain: null }` when nothing is in play.
 */
export interface AudioMixOptions {
  /** Base audio from input `[0:a]` (single-video path). null = no base track. */
  baseAudio?: { volume: number } | null;
  /** Clips to mix; each must have an entry in `inputIndex`. */
  clips: AudioClip[];
  /** `clip.id` → ffmpeg input index. */
  inputIndex: Map<string, number>;
  /**
   * `amix` duration policy:
   *  - `"first"` ties the mix length to the first input — correct when the
   *    first input is the full-length base scene audio (ffmpeg-overlay).
   *  - `"longest"` covers the latest-ending clip — correct for the multi-scene
   *    mux where there's no base and each clip is `adelay`ed onto the timeline.
   */
  mixDuration?: "first" | "longest";
}

export function buildAudioMixGraph(opts: AudioMixOptions): { chain: string | null } {
  const { clips, inputIndex } = opts;
  const baseAudio = opts.baseAudio ?? null;
  const mixDuration = opts.mixDuration ?? "first";

  const amixInputs: string[] = [];
  const chainSegments: string[] = [];

  if (baseAudio) {
    // The base input is already time-sliced by -ss/-to, so no atrim/adelay.
    chainSegments.push(`[0:a]volume=${baseAudio.volume}[a_base]`);
    amixInputs.push("a_base");
  }

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const idx = inputIndex.get(c.id);
    if (idx === undefined) continue;
    const label = `a_c${i}`;
    const trimStart = Math.max(0, c.trimStart ?? 0);
    const delayMs = Math.max(0, Math.round(c.startTime * 1000));
    const segments: string[] = [
      `[${idx}:a]atrim=${trimStart}:${trimStart + c.duration}`,
      `asetpts=PTS-STARTPTS`,
      `volume=${c.volume}`,
    ];
    // Audio-fade envelope: append afade filters after volume, before adelay.
    // Gated — clips with no audio-fade effects emit no afade filter.
    const fade = audioFadeSeconds(c);
    if (fade.inSec > 0) {
      segments.push(`afade=t=in:st=0:d=${fade.inSec.toFixed(3)}`);
    }
    if (fade.outSec > 0) {
      const outStart = Math.max(0, c.duration - fade.outSec);
      segments.push(`afade=t=out:st=${outStart.toFixed(3)}:d=${fade.outSec.toFixed(3)}`);
    }
    if (delayMs > 0) {
      // adelay needs a value per channel; `delays|delays` covers mono + stereo.
      segments.push(`adelay=${delayMs}|${delayMs}`);
    }

    if (c.duck && inputIndex.has(c.duck.sidechainClipId)) {
      // Ducked: pre-stage label, then sidechaincompress against the sidechain
      // input. The sidechain clip ALSO plays normally in its own iteration.
      chainSegments.push(`${segments.join(",")}[${label}_pre]`);
      const sidechainIdx = inputIndex.get(c.duck.sidechainClipId)!;
      const threshLinear = Math.pow(10, c.duck.thresholdDb / 20).toFixed(6);
      // ffmpeg sidechaincompress takes attack/release in SECONDS, not ms.
      const attackS = (c.duck.attackMs / 1000).toFixed(3);
      const releaseS = (c.duck.releaseMs / 1000).toFixed(3);
      const makeup = Math.max(0, -c.duck.reductionDb);
      chainSegments.push(
        `[${label}_pre][${sidechainIdx}:a]sidechaincompress=` +
          `threshold=${threshLinear}:` +
          `ratio=${c.duck.ratio}:` +
          `attack=${attackS}:` +
          `release=${releaseS}:` +
          `makeup=${makeup}` +
          `[${label}]`,
      );
    } else {
      chainSegments.push(`${segments.join(",")}[${label}]`);
    }

    amixInputs.push(label);
  }

  if (amixInputs.length === 0) {
    return { chain: null };
  }

  // ALWAYS terminate the graph with aresample=async=1 before [aout]. A clip with
  // a non-zero trimStart (atrim=start:end) fed through adelay into amix can emit
  // a packet with a corrupt, near-INT64_MAX DTS that poisons the downstream AAC
  // encoder's monotonic-DTS check — ffmpeg then aborts the whole export with
  // "non monotonically increasing dts to muxer" / exit -22 mid-stream. Resampling
  // the final output re-derives clean, monotonic timestamps from aresample's own
  // sample clock while preserving the stream's start offset. It's a no-op on
  // already-clean streams, so applying it unconditionally is safe. The
  // intermediate label `[apre]` avoids colliding with `[aout]` / clip labels.
  const RESAMPLE = "aresample=async=1";

  if (amixInputs.length === 1) {
    // Sole producer (amix of 1 is a no-op): relabel its output to [apre], then
    // pass it through the resample stage to [aout].
    const solo = chainSegments[0];
    const last = solo.lastIndexOf("[");
    return { chain: `${solo.slice(0, last)}[apre];[apre]${RESAMPLE}[aout]` };
  }

  const inputsJoined = amixInputs.map((l) => `[${l}]`).join("");
  // normalize=0 preserves per-clip volume (ffmpeg's default 1/N dips the mix).
  chainSegments.push(
    `${inputsJoined}amix=inputs=${amixInputs.length}:duration=${mixDuration}:dropout_transition=0:normalize=0[apre]`,
  );
  chainSegments.push(`[apre]${RESAMPLE}[aout]`);
  return { chain: chainSegments.join(";") };
}
