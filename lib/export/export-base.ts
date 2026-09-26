/**
 * Resolve a composition's BASE VIDEO for the server-side ffmpeg export
 * backends — the single full-frame video layer that becomes ffmpeg input `[0:v]`.
 *
 * Every video is an OVERLAY, so the base is the bottom full-frame,
 * untransformed video overlay. This module is the shared predicate + resolver
 * both the classifier and the backends read, so they can never disagree about
 * what the base is.
 *
 * Deliberately strict: any overlay the ffmpeg graph could not reproduce
 * pixel-for-pixel (partial opacity, contain-fit letterbox, rotation, keyframed
 * motion, a non-zero start) disqualifies the fast path and the caller falls back
 * to chromium-render. A false negative costs render time; a false positive ships
 * a wrong video.
 */
import type { AudioClip, Composition, Overlay, VideoOverlay } from "@/lib/engine/types";
import { overlayHasKeyframes, overlayHasNonIdentityTransform } from "@/lib/export/overlay-predicates";

export interface ExportBase {
  fileId: string;
  duration: number;
  trim?: { start: number; end: number };
  /** Overlay id of the base video overlay. */
  overlayId: string;
  /** SOURCE pixel dimensions of the base file, when known. Runtime-only: the
   *  hydrators (`buildComposition` client-side, the export routes server-side)
   *  copy them off `files.mediaWidth/mediaHeight`, which is nullable. `null`
   *  means UNKNOWN — never "matches". */
  sourceWidth: number | null;
  sourceHeight: number | null;
}

/** Lowest z among all overlays, or null when there are none. */
function minZ(overlays: Overlay[]): number | null {
  if (!overlays.length) return null;
  return overlays.reduce((m, o) => Math.min(m, o.z ?? 0), Number.POSITIVE_INFINITY);
}

/**
 * True when this overlay can serve as ffmpeg's base input: a full-canvas,
 * opaque, cover-fit, untransformed, unkeyframed video starting at t=0 and
 * sitting at the bottom of the stack.
 */
export function isBaseShapedVideoOverlay(o: Overlay, comp: Composition): boolean {
  if (o.kind !== "video") return false;
  if (o.startTime !== 0) return false;
  if (o.opacity != null && o.opacity !== 1) return false;
  if ((o.fit ?? "cover") !== "cover") return false;
  if (o.rect.x !== 0 || o.rect.y !== 0) return false;
  if (o.rect.width !== comp.width || o.rect.height !== comp.height) return false;
  if (overlayHasNonIdentityTransform(o)) return false;
  if (overlayHasKeyframes(o)) return false;
  // Any in/out/loop effect ref can't be reproduced by the static ffmpeg
  // overlay/drawtext graph — reject rather than guess whether it's benign.
  if (o.effects && (o.effects.in || o.effects.out || o.effects.loop)) return false;
  const lowest = minZ(comp.overlays ?? []);
  return lowest != null && (o.z ?? 0) === lowest;
}

/**
 * The composition's base video, or null when it has none (in which case the
 * caller must use chromium-render).
 */
export function resolveExportBase(comp: Composition): ExportBase | null {

  const overlays = comp.overlays ?? [];
  // Additional video overlays above the base are FINE — the ffmpeg-overlay
  // backend composites them as extra `-i` inputs. That is exactly the shape
  // background-removal produces (a full-frame plate + inset cutouts), and
  // rejecting it would send every such export through headless Chromium.
  // Only the BASE must be unambiguous.
  const bases = overlays.filter(
    (o): o is VideoOverlay => o.kind === "video" && isBaseShapedVideoOverlay(o, comp),
  );
  // `isBaseShapedVideoOverlay` requires the LOWEST z, so at most one overlay
  // can qualify — but assert it rather than assume: an ambiguous base is a
  // wrong video, and falling back is always safe.
  if (bases.length !== 1) return null;
  const base = bases[0];
  return {
    fileId: base.fileId,
    duration: base.duration,
    trim: base.trim,
    overlayId: base.id,
    sourceWidth: base.sourceWidth ?? null,
    sourceHeight: base.sourceHeight ?? null,
  };
}

/**
 * The base's OUTPUT time range, in source seconds.
 *
 * `trim` selects a range of the SOURCE file; `duration` is how long the layer
 * occupies the TIMELINE. The renderer draws the layer for `duration` seconds
 * starting at `trim.start` (see `overlay-renderer.ts`), so the exported cut is
 * the SHORTER of the two — a trim whose span exceeds `duration` (split a clip,
 * then drag its right edge in, which rewrites `duration` but not `trim`) would
 * otherwise emit a file longer than the preview showed.
 *
 * Both ffmpeg backends and the classifier's truncation guard read this, so they
 * cannot disagree about where the output ends.
 */
export function baseTimeRange(base: ExportBase): {
  start: number;
  end: number;
  duration: number;
} {
  const start = base.trim?.start ?? 0;
  const end = Math.min(base.trim?.end ?? Number.POSITIVE_INFINITY, start + base.duration);
  return { start, end, duration: end - start };
}

/** A stream that starts less than this after a cut starts with it. */
export const LEAD_EPS = 0.001;

/**
 * How an ffmpeg backend cuts the base at `start` without losing a stream that
 * starts late (its `videoLead` / `audioLead`, `lib/ffmpeg/probe.ts`).
 *
 * `-ss` before `-i` makes the demuxer seek on the VIDEO: every stream is
 * positioned at the video keyframe at or before `start`. When the video
 * starts after `start` there is no such keyframe, so the seek lands on the
 * video's first keyframe and the audio before it is dropped. That holds even
 * for `-ss 0`, and even with `-vn` (measured with ffmpeg 8.1 and 9.0.1: a
 * file whose video starts 0.4 s after its audio lost the audio's first
 * 0.32 s, the first keyframe's DTS, in MP4, and 0.406 s in MKV).
 *
 * So a cut inside the video's lead reads the base from its start (only `-to`)
 * and the graph cuts `start` off the audio itself. The video then starts
 * `videoLead` after the cut, and the export shows its first frame until then,
 * as the preview and the canvas export do (`MediaBunnyExportFrameSource`).
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md (Export lead fix)
 */
export interface BaseCut {
  /** `-ss` before the base's `-i`; null reads the base from its start. */
  inputSeek: number | null;
  /** Seconds the graph cuts from the base audio (inputSeek null). */
  graphTrim: number;
  /** Seconds after the cut the base video starts (0: at the cut). */
  videoLead: number;
}

export function baseCut(start: number, videoLead = 0): BaseCut {
  if (videoLead > start + LEAD_EPS) return { inputSeek: null, graphTrim: start, videoLead: videoLead - start };
  return { inputSeek: start, graphTrim: 0, videoLead: 0 };
}

/**
 * Whether `-c copy` keeps every kept stream where the source has it, on the
 * output's own timeline, for a cut at `start`. A copy can't add silence or
 * repeat a frame, so it can't keep a lead that the whole output would start
 * with: the output's timeline then begins at its first packet, and a reader
 * (ffmpeg, libi's preview) plays everything that much early.
 * - The video starts by the cut: the seek lands on a keyframe at or before
 *   it, the output starts at 0, and an audio lead stays a lead. Copy.
 * - The video starts after a cut past 0: the seek drops audio (`baseCut`).
 * - The video starts after a cut at 0: read from the start, which keeps the
 *   video's lead only if the kept audio starts at 0.
 */
export function streamCopyKeepsTimeline(
  start: number,
  leads: { videoLead?: number; audioLead?: number },
  keepsAudio: boolean,
): boolean {
  if ((leads.videoLead ?? 0) <= start + LEAD_EPS) return true;
  if (start > LEAD_EPS) return false;
  return keepsAudio && (leads.audioLead ?? 0) <= LEAD_EPS;
}

/**
 * True when `-c copy` would preserve the composition's framing.
 *
 * Stream-copy ships the source's bytes verbatim — it cannot scale, pad, or
 * crop — so the output carries the SOURCE's dimensions. That is only correct
 * when the source already matches the composition. A 16:9 clip dropped into a
 * 9:16 short is base-shaped by construction (`add_overlay` defaults every video
 * to a full-canvas `cover` rect), and stream-copying it silently ships a
 * landscape file for a portrait piece.
 *
 * UNKNOWN dimensions (`null` — the file row was never probed) count as a
 * MISMATCH: a false negative costs one re-encode, a false positive ships the
 * wrong aspect ratio.
 */
export function streamCopyPreservesFraming(base: ExportBase, comp: Composition): boolean {
  if (base.sourceWidth == null || base.sourceHeight == null) return false;
  return base.sourceWidth === comp.width && base.sourceHeight === comp.height;
}

/**
 * The inline AudioClip that represents the BASE layer's own audio track, if any.
 * Matched by `linkedOverlayId`.
 *
 * Muting a base video REMOVES its inline clip (`libi.audio_remove_clip`), so
 * "no clip" means "no base audio" — not "keep whatever the source had". Both
 * ffmpeg backends must drop the source's audio track in that case.
 */
export function findBaseInlineAudioClip(
  comp: Composition,
  base: ExportBase,
): AudioClip | undefined {
  return (comp.audioClips ?? []).find(
    (c) => c.kind === "inline" && c.linkedOverlayId === base.overlayId,
  );
}

/** True when the base's own audio must be carried into the export. */
export function keepsBaseAudio(comp: Composition, base: ExportBase): boolean {
  const clip = findBaseInlineAudioClip(comp, base);
  return clip !== undefined && clip.enabled;
}

/**
 * The audio as it sits on its file's timeline, from the file's start.
 *
 * The ffmpeg CLI rebases an input by the file's start, but a track that starts
 * later than the file (after a subtitle or the video, or a microphone that
 * started late) keeps that lead only as its first timestamp. `atrim` then
 * `asetpts=PTS-STARTPTS` threw it away: a clip trimmed inside the lead played
 * from the track's first sample, as early as the lead was long (400 ms on a
 * file whose audio starts 0.4 s in, 200 ms trimmed at 0.2 s). The preview
 * plays silence there. Padding the lead with silence first puts every trim
 * point where the preview has it. On a track that starts with its file it is
 * a no-op.
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md (Export lead fix)
 */
export const ON_FILE_TIMELINE = "aresample=async=1:first_pts=0";

/**
 * `ON_FILE_TIMELINE` for an input read through its probe's `audioRead` fix:
 * its timestamps first moved by `ptsShift` seconds (an Ogg or MPEG-TS read
 * for its audio alone, whose start ffmpeg moved to the audio's; a FLAC-in-MP4
 * cut read without its edit list). See `ProbedMedia.audioRead`.
 */
export function onFileTimeline(ptsShift = 0): string {
  if (!Number.isFinite(ptsShift) || Math.abs(ptsShift) < 1e-6) return ON_FILE_TIMELINE;
  const x = +Math.abs(ptsShift).toFixed(9);
  // A whole number of ticks (samples): `x/TB` alone is a float a hair under
  // the sample (0.397333333 s × 48 kHz = 19071.99998), which the padding
  // truncated: the audio came out one sample early (review round 4).
  return `asetpts=PTS${ptsShift > 0 ? "+" : "-"}round(${x}/TB),${ON_FILE_TIMELINE}`;
}

/**
 * Filters (with a trailing comma) that show a video's first frame from its
 * stream's time 0 until the frame's own time `lead`, or "" when there is no
 * lead. A stream that starts late otherwise has no frame there at all: the
 * `overlay` filter draws nothing over that span, and a base that starts late
 * starts the whole output late, so a reader of the file plays it early. The
 * preview and the canvas export show the first frame there
 * (`MediaBunnyExportFrameSource`), so the export repeats it.
 *
 * `tpad` inserts its frames before the stream's first frame and shifts the
 * stream by them, so the stream is first moved to 0. The padding is whole
 * frames at the stream's rate: the first real frame lands within half a frame
 * of `lead`.
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md (Export lead fix)
 */
export function leadFill(lead: number): string {
  if (!(lead > 0.001)) return "";
  return `setpts=PTS-STARTPTS,tpad=start_mode=clone:start_duration=${+lead.toFixed(9)},`;
}
