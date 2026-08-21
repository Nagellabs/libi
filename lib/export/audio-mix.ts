import type { AudioClip } from "@/lib/engine/types";
import { audioFadeSeconds } from "@/lib/effects/audio-envelope";
import { ENVELOPE_SAMPLE_RATE } from "@/lib/export/duck-envelopes";

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
 *   - optional `amultiply` against a pre-rendered duck envelope — sidechain
 *     ducking (`clip.duck`) applied as the preview's own gain curve rather than
 *     re-derived by an ffmpeg compressor. See `lib/export/duck-envelopes.ts`.
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
   * `clip.id` → ffmpeg input index of that clip's pre-rendered duck envelope
   * (`lib/export/duck-envelopes.ts`). A ducked clip with no entry here is mixed
   * UNDUCKED rather than failing the export — a missing envelope is a degraded
   * mix, not a broken file.
   */
  envelopeIndex?: Map<string, number>;
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
  const envelopeIndex = opts.envelopeIndex ?? new Map<string, number>();
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

    const envelopeIdx = envelopeIndex.get(c.id);
    if (c.duck && envelopeIdx !== undefined) {
      // Ducked: multiply the clip by a PRE-RENDERED gain curve (see
      // lib/export/duck-envelopes.ts). The curve comes from `duckGainCurve` —
      // the same arithmetic the preview worklet runs — so the export applies
      // the preview's duck literally rather than approximating it with a
      // different compressor.
      //
      // This replaced `sidechaincompress`, which is a genuinely different
      // compressor (RMS detector, soft knee) and ducked 5.2 dB less than the
      // preview on real material, leaving voice-overs buried in every export.
      // No parameter combination closed that gap — see duck-law.ts.
      //
      // Both sides are pinned to ENVELOPE_SAMPLE_RATE and stereo because
      // `amultiply` requires identical rate and layout. The envelope uses `pan`
      // rather than an implicit upmix: ffmpeg's mono->stereo conversion applies
      // 0.7071x (-3 dB), which would quietly attenuate every ducked clip.
      chainSegments.push(`${segments.join(",")}[${label}_pre]`);
      chainSegments.push(
        `[${label}_pre]aformat=sample_fmts=fltp:sample_rates=${ENVELOPE_SAMPLE_RATE}:` +
          `channel_layouts=stereo[${label}_fmt]`,
      );
      chainSegments.push(
        `[${envelopeIdx}:a]pan=stereo|c0=c0|c1=c0,` +
          `aformat=sample_fmts=fltp:sample_rates=${ENVELOPE_SAMPLE_RATE}[${label}_env]`,
      );
      chainSegments.push(`[${label}_fmt][${label}_env]amultiply[${label}]`);
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
    //
    // Relabel the LAST segment, and keep every earlier one. A ducked clip emits
    // four segments (pre-stage, format, envelope, amultiply); taking only the
    // first dropped the duck entirely whenever a composition had exactly one
    // clip in the mix.
    const segments = [...chainSegments];
    const soloIndex = segments.length - 1;
    const solo = segments[soloIndex];
    const cut = solo.lastIndexOf("[");
    segments[soloIndex] = `${solo.slice(0, cut)}[apre]`;
    segments.push(`[apre]${RESAMPLE}[aout]`);
    return { chain: segments.join(";") };
  }

  const inputsJoined = amixInputs.map((l) => `[${l}]`).join("");
  // normalize=0 preserves per-clip volume (ffmpeg's default 1/N dips the mix).
  chainSegments.push(
    `${inputsJoined}amix=inputs=${amixInputs.length}:duration=${mixDuration}:dropout_transition=0:normalize=0[apre]`,
  );
  chainSegments.push(`[apre]${RESAMPLE}[aout]`);
  return { chain: chainSegments.join(";") };
}
