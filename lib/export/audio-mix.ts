import type { AudioClip } from "@/lib/engine/types";
import { audioFadeSeconds } from "@/lib/effects/audio-envelope";
import { ENVELOPE_SAMPLE_RATE } from "@/lib/export/duck-envelopes";
import { ON_FILE_TIMELINE, onFileTimeline } from "@/lib/export/export-base";

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
 *   - `aresample=async=1:first_pts=0` (`ON_FILE_TIMELINE`) — the track as it
 *     sits on its file's timeline: silence from the file's start up to a track
 *     that starts late. See below.
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
  /**
   * Base audio from input `[0:a]` (single-video path). null = no base track.
   * The input is already cut by `-ss`/`-to`, except by `trimStart` seconds when
   * the backend had to read it from its start (`baseCut`).
   */
  baseAudio?: { volume: number; trimStart?: number } | null;
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
  /**
   * ffmpeg input index → that input's audio channel count (ffprobe; absent =
   * unknown). When given, the mix is made STEREO whenever any input may be
   * stereo: a mono input is upmixed with a unity pan and every other input is
   * pinned to stereo, before amix. Without it the graph leaves layout to
   * ffmpeg, which is what the callers that don't probe still get.
   *
   * Why: amix negotiates ONE format for all of its inputs and takes the first
   * input's layout, so a mono narration listed first made a whole mix of
   * stereo clips mono. And ffmpeg's implicit mono→stereo conversion is -3 dB
   * per side, while the preview (Web Audio "speakers" up-mix) copies a mono
   * source to both sides at unity — hence the explicit pan, never an
   * auto-inserted aresample.
   * docs-local/qa/2026-09-25-dreams-audio-report.md (Fix round 1)
   */
  inputChannels?: Map<number, number | undefined>;
  /**
   * ffmpeg input index → the ffprobe index of the audio stream to read (the
   * primary stream the preview plays). An input without an entry reads
   * `[n:a]`, the first audio stream (Review M6).
   */
  inputAudioStream?: Map<number, number>;
  /**
   * ffmpeg input index → seconds to move a clip input's audio timestamps by
   * before it is padded onto its file's timeline (`ProbedMedia.audioRead`:
   * the start ffmpeg corrects on an Ogg or MPEG-TS read for its audio alone,
   * a FLAC-in-MP4 cut read without its edit list). The input's own options
   * (`audioRead.inputArgs`) are the caller's to add.
   */
  inputPtsShift?: Map<number, number>;
}

/** Unity mono → stereo: both sides carry the mono signal at full level, as the
 *  preview plays it. */
const UNITY_UPMIX = "pan=stereo|c0=c0|c1=c0";
/** Stereo stays stereo (a no-op); more channels downmix the standard way. */
const PIN_STEREO = "aformat=channel_layouts=stereo";
/** For an input whose channel count is UNKNOWN (its probe failed): right for
 *  mono AND stereo. Mono (FC) lands on both sides at unity, and stereo
 *  (FL/FR) passes through untouched, whereas `aformat` would upmix mono at
 *  -3 dB (Review M4). Rendered with real ffmpeg in
 *  export-audio-stereo-mix.test.ts. */
const MONO_OR_STEREO_TO_STEREO = "pan=stereo|FL=FL+FC|FR=FR+FC";
/**
 * After amix: a lookahead limiter at FULL SCALE (limit=1). It caps a mix only
 * where summing clips pushes it past 0 dBFS, which is where the preview would
 * hard-clip at the output.
 * - Anything at or under full scale passes bit-transparently, a lone loud
 *   source included. Measured with real ffmpeg: max sample difference 0, same
 *   length, a 0.99-peak lone source is untouched. So the export stays
 *   level-matched to the preview.
 * - An earlier -1 dBFS (0.891) limit also cut a lone 0.95-peak music bed
 *   whenever the piece had narration anywhere (Re-review R2). That changed a
 *   source the user never overloaded.
 * - level=0: no auto-gain. latency=1: the 5 ms lookahead is compensated, so
 *   the audio stays in sync and keeps its tail.
 * - `latency` needs ffmpeg 5.1 or later. libi requires 6.1 (drawtext
 *   `y_align`, mcp/registry/bundled.ts), and CI's apt ffmpeg is 6.1.
 * - It reserves no headroom for the lossy encoder's inter-sample overshoot,
 *   just as a lone source's own export doesn't.
 * - A single input (clip volume ≤ 1) can't pass full scale, so it gets none.
 */
const PEAK_GUARD = "alimiter=limit=1:attack=5:release=50:level=0:latency=1";

export function buildAudioMixGraph(opts: AudioMixOptions): { chain: string | null } {
  const { clips, inputIndex } = opts;
  const envelopeIndex = opts.envelopeIndex ?? new Map<string, number>();
  const baseAudio = opts.baseAudio ?? null;
  const mixDuration = opts.mixDuration ?? "first";
  const inputChannels = opts.inputChannels;
  const audioIn = (idx: number): string => {
    const stream = opts.inputAudioStream?.get(idx);
    return stream !== undefined ? `[${idx}:${stream}]` : `[${idx}:a]`;
  };

  // Stereo whenever any input in play may be stereo — a ducked clip's
  // multiply stage is stereo too. An all-mono mix is left as it was.
  const inPlay: number[] = [];
  if (baseAudio) inPlay.push(0);
  for (const c of clips) {
    const idx = inputIndex.get(c.id);
    if (idx !== undefined) inPlay.push(idx);
  }
  const hasDuck = clips.some((c) => c.duck && inputIndex.has(c.id) && envelopeIndex.has(c.id));
  const stereoMix =
    inputChannels !== undefined &&
    (hasDuck || inPlay.some((idx) => inputChannels.get(idx) !== 1));
  /** The filter that brings input `idx` to stereo, or null when the mix isn't stereo. */
  const toStereo = (idx: number): string | null => {
    if (!stereoMix) return null;
    const channels = inputChannels?.get(idx);
    if (channels === undefined) return MONO_OR_STEREO_TO_STEREO;
    return channels === 1 ? UNITY_UPMIX : PIN_STEREO;
  };

  const amixInputs: string[] = [];
  const chainSegments: string[] = [];

  if (baseAudio) {
    // The base input is time-sliced by -ss/-to, so no adelay; `trimStart` is
    // what the input seek didn't cut. The lead of a track that starts after
    // the cut is padded with silence (ON_FILE_TIMELINE), as for a clip.
    const up = toStereo(0);
    const cut = baseAudio.trimStart && baseAudio.trimStart > 0
      ? `atrim=start=${baseAudio.trimStart},asetpts=PTS-round(${baseAudio.trimStart}/TB),`
      : "";
    chainSegments.push(`${audioIn(0)}${cut}${ON_FILE_TIMELINE},volume=${baseAudio.volume}${up ? `,${up}` : ""}[a_base]`);
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
      `${audioIn(idx)}${onFileTimeline(opts.inputPtsShift?.get(idx))}`,
      `atrim=${trimStart}:${trimStart + c.duration}`,
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
    const up = toStereo(idx);
    if (up) segments.push(up);

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
  // normalize=0 preserves per-clip volume (ffmpeg's default 1/N dips the mix),
  // so the export sums the clips at the level the preview plays them at, and a
  // sum can pass full scale. PEAK_GUARD caps only that, instead of letting the
  // AAC/Opus encode clip it (Review M3).
  chainSegments.push(
    `${inputsJoined}amix=inputs=${amixInputs.length}:duration=${mixDuration}:dropout_transition=0:normalize=0,${PEAK_GUARD}[apre]`,
  );
  chainSegments.push(`[apre]${RESAMPLE}[aout]`);
  return { chain: chainSegments.join(";") };
}
