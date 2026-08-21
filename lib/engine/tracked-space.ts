/**
 * The bridge between a track's SOURCE-CLIP space and the composition.
 *
 * A `Track` describes a subject inside one source video file: its samples are
 * timed in **source-clip seconds** (`TrackSample.t`, 0 = first frame of the
 * file) and positioned in **source video pixels** (`TrackSample.x/y/w/h` — see
 * `lib/tracking/types.ts`). A `TrackedOverlay`, by contrast, lives on the
 * composition: it is windowed on the GLOBAL timeline and draws in composition
 * pixels.
 *
 * Nothing converted between the two. The renderer sampled the track at global
 * time and treated the sampled box as composition coordinates, which is only
 * correct for a video overlay that starts at 0, has no trim, and fills the
 * frame 1:1 — the case every tracked overlay happened to be in until a piece
 * put a tracked clip in a panel. Off that case the overlay drew NOTHING (the
 * global time falls outside the track's sample range, so `sampleTrack` returns
 * null and the draw silently no-ops), or, with the timebase alone fixed, drew
 * a box at source scale over a downscaled clip.
 *
 * Both conversions are derived from ONE thing: the video overlay the track's
 * file is mounted on. That video overlay defines where the source pixels land
 * (`rect` + `fit`) and when the source clock runs (`startTime` + `trim`).
 *
 * Everything here is pure and DOM-free so preview, canvas export, the chromium
 * render bundle, and hit-testing can all share it. When the owning video can't
 * be identified the mapping degrades to the identity — a piece mid-edit (the
 * video deleted, the track pointing at a file no overlay mounts) must keep
 * rendering exactly as it did before, never crash and never blank the preview.
 *
 * ## Why the divisor is the FILE's source size, never the decoded frame's
 *
 * The scale below is `fitted.w / video.sourceWidth`, where `sourceWidth` is
 * `files.mediaWidth` (hydrated by `buildComposition`). It is tempting to reach
 * for the decoded frame's own `videoWidth` instead, since that is what the
 * draw is actually painting. That would be WRONG, and not merely as a matter
 * of taste:
 *
 * - Preview may be playing the **proxy**, not the original. `pickVideoUrl`
 *   serves `file.proxyFilename` once `proxy_gen` finishes, so the decoded
 *   element can be 1080p (or less) under a 4K original — and it can change
 *   mid-session, when a proxy lands. Boxes divided by the decoded size would
 *   silently rescale the instant that happened.
 * - `TrackSample` coordinates are defined in `files.mediaWidth` space — the
 *   ORIGINAL's pixels. Tracks are computed against the original
 *   (`fileUrlFor` in `mcp/tools/tracking-tools.ts` serves
 *   `/api/files/by-id/:id/content`, the original bytes), and
 *   `lib/tracking/verify-render.ts` draws raw samples onto a source frame
 *   sized `frameW: file.mediaWidth` with no scaling at all.
 *
 * So `sourceWidth`/`sourceHeight` are not an acceptable approximation of the
 * decoded dimensions — they are the only correct divisor, because they are the
 * space the numerator's inputs are already in. Whatever the decoder happens to
 * hand back is irrelevant to this mapping.
 */

import type { Overlay, TrackedOverlay, VideoOverlay } from "./types";
import type { Track, TrackSample } from "@/lib/tracking/types";
import { sampleTrack } from "@/lib/tracking/sample";
import { coverRect, fitRect } from "./letterbox";

/**
 * The affine map from a track's source-video pixels to composition pixels,
 * plus the clock offset from global composition time to source-clip time.
 *
 *   compX = srcX * scaleX + offsetX
 *   compY = srcY * scaleY + offsetY
 *   clipTime = globalTime - timeOffset
 *
 * `video` is the overlay everything was derived from, or `null` for the
 * identity space (no owning video found).
 */
export interface TrackedSpace {
  video: VideoOverlay | null;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  /** Seconds to SUBTRACT from global time: `startTime - (trim?.start ?? 0)`. */
  timeOffset: number;
}

/** No owning video: sample at global time, treat source px as composition px.
 *  This is precisely the pre-fix behaviour, kept as the fallback.
 *
 *  FROZEN because it is exported AND returned by reference from
 *  `resolveTrackedSpace` — an unfrozen shared singleton is one careless
 *  `space.scaleX = …` away from corrupting every subsequent fallback render
 *  in the session, with no way to trace where it came from. */
export const IDENTITY_TRACKED_SPACE: TrackedSpace = Object.freeze({
  video: null,
  scaleX: 1,
  scaleY: 1,
  offsetX: 0,
  offsetY: 0,
  timeOffset: 0,
});

/**
 * Every failure mode here is a SILENT degrade to the identity — deliberately,
 * because a piece mid-edit must keep rendering. But for a windowed clip the
 * identity means the sample time lands outside the track's range and the
 * overlay draws NOTHING, which is the exact symptom this module exists to fix
 * and is indistinguishable, on screen, from "the subject was not detected".
 *
 * So say it once per (file, tracked overlay) — once, because this runs per
 * frame at 30fps and a repeated warning is a hang. `console.warn` matches the
 * neighbouring engine precedent (`renderFrame`'s draw-isolation warning,
 * `lib/export/render-overlay-tracks.ts`): this module is DOM-free browser code
 * that preview, canvas export and the chromium bundle all share, so it cannot
 * reach `serverLogger` — and `lib/engine/**` is outside the `no-console`
 * scope in `eslint.config.mjs` for exactly that reason.
 */
const _ownerMissingWarned = new Set<string>();
function warnOwnerMissing(fileId: string, overlayKey: string): void {
  const key = `${fileId}::${overlayKey}`;
  if (_ownerMissingWarned.has(key)) return;
  _ownerMissingWarned.add(key);
  console.warn(
    `[trackedSpace] no video overlay mounts file ${fileId}; the tracked overlay ` +
      `at ${overlayKey} falls back to the identity space (sampled at GLOBAL time, ` +
      `source pixels used as composition pixels). If the video is windowed or ` +
      `trimmed the overlay will draw nothing — that is a missing owner, not a ` +
      `lost subject.`,
  );
}

function overlap(
  a: { startTime: number; duration: number },
  b: { startTime: number; duration: number },
): number {
  const lo = Math.max(a.startTime, b.startTime);
  const hi = Math.min(a.startTime + a.duration, b.startTime + b.duration);
  return Math.max(0, hi - lo);
}

/**
 * The video overlay a track rides on, DERIVED — never declared on the tracked
 * overlay.
 *
 * A track already names its subject's file (`Track.fileId`), and a video
 * overlay already names the file it mounts, so the link is inferable and
 * cannot go stale: re-trimming or moving the video moves the tracked art with
 * it, and an author has no third field to get wrong. (The alternative — an
 * explicit `videoOverlayId` on `TrackedOverlay` — was rejected for exactly
 * that reason: it is a second copy of a fact the composition already holds.)
 *
 * Ambiguity IS possible — one file can be mounted by several video overlays
 * (the same clip used twice, or split into two windows). It is resolved
 * temporally: the candidate whose window overlaps the tracked overlay's window
 * most wins, then the one starting nearest it, then document order. That picks
 * the intended clip for the split/reused case and is deterministic in every
 * other. `hidden` candidates stay eligible — a hidden video still defines the
 * space its track was computed in.
 *
 * Returns null when no video overlay mounts the track's file.
 */
export function findTrackOwnerVideo(
  track: Pick<Track, "fileId">,
  overlay: Pick<TrackedOverlay, "startTime" | "duration">,
  overlays: readonly Overlay[] | undefined,
): VideoOverlay | null {
  if (!overlays || overlays.length === 0) return null;
  let best: VideoOverlay | null = null;
  let bestOverlap = -1;
  let bestDistance = Infinity;
  for (const o of overlays) {
    if (o.kind !== "video" || o.fileId !== track.fileId) continue;
    const ov = overlap(o, overlay);
    const dist = Math.abs(o.startTime - overlay.startTime);
    if (ov > bestOverlap || (ov === bestOverlap && dist < bestDistance)) {
      best = o;
      bestOverlap = ov;
      bestDistance = dist;
    }
  }
  return best;
}

/**
 * Build the source→composition space for one tracked overlay.
 *
 * The pixel map mirrors how the video overlay is actually DRAWN
 * (`drawOverlayContent2D`'s `video` case): `coverRect` / `fitRect` place the
 * source frame inside the overlay rect, so the same two helpers place the
 * track's boxes. Source dimensions come from the video overlay's runtime
 * `sourceWidth`/`sourceHeight` (hydrated off `files.mediaWidth/mediaHeight` by
 * `buildComposition` and `attachOverlaySourceDims`).
 *
 * When those dims are absent — a stub composition, an unprobed file — we
 * assume the source fills the rect exactly, which is the SAME assumption the
 * video draw falls back to (`sw = videoWidth || localRect.width`). For the
 * ordinary full-frame video that assumption is the identity, so the common
 * case is bit-for-bit unchanged; for a windowed clip it at least anchors the
 * art to the panel instead of the frame origin.
 */
export function resolveTrackedSpace(
  overlay: Pick<TrackedOverlay, "startTime" | "duration">,
  track: Pick<Track, "fileId"> | undefined,
  overlays: readonly Overlay[] | undefined,
): TrackedSpace {
  if (!track) return IDENTITY_TRACKED_SPACE;
  const video = findTrackOwnerVideo(track, overlay, overlays);
  if (!video) {
    // Only when a list was actually supplied. `overlays: undefined` is the
    // legacy call shape (hit-tests, the eval harness, every drawOverlay caller
    // that predates this module), not a composition missing its video — and
    // warning for it would fire on every frame of every such render.
    if (overlays && overlays.length > 0) {
      warnOwnerMissing(track.fileId, `${overlay.startTime}s+${overlay.duration}s`);
    }
    return IDENTITY_TRACKED_SPACE;
  }

  const rect = video.rect;
  const srcW = video.sourceWidth && video.sourceWidth > 0 ? video.sourceWidth : rect.width;
  const srcH = video.sourceHeight && video.sourceHeight > 0 ? video.sourceHeight : rect.height;
  const fitted =
    (video.fit ?? "cover") === "cover"
      ? coverRect(srcW, srcH, rect.width, rect.height)
      : fitRect(srcW, srcH, rect.width, rect.height);

  return {
    video,
    scaleX: srcW > 0 ? fitted.w / srcW : 1,
    scaleY: srcH > 0 ? fitted.h / srcH : 1,
    offsetX: rect.x + fitted.x,
    offsetY: rect.y + fitted.y,
    timeOffset: video.startTime - (video.trim?.start ?? 0),
  };
}

/**
 * Global composition time → the source clock the track's samples are on.
 * Identical to the formula `collectVideoSeekTargets` uses to seek that same
 * video, which is what keeps the sampled box and the decoded frame in step.
 */
export function trackedClipTime(space: TrackedSpace, globalTime: number): number {
  return globalTime - space.timeOffset;
}

/** A source-pixel box in composition pixels. */
export function trackBoxToComposition(
  space: TrackedSpace,
  box: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: box.x * space.scaleX + space.offsetX,
    y: box.y * space.scaleY + space.offsetY,
    w: box.w * space.scaleX,
    h: box.h * space.scaleY,
  };
}

/** The exact inverse of {@link trackBoxToComposition}: a composition-pixel box
 *  back in the track's source pixels. The re-anchor drag needs it — the user
 *  drops in composition pixels but a `ManualAnchor` bbox is defined in
 *  TrackSample space. */
export function compositionBoxToTrack(
  space: TrackedSpace,
  box: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const sx = space.scaleX !== 0 ? space.scaleX : 1;
  const sy = space.scaleY !== 0 ? space.scaleY : 1;
  return {
    x: (box.x - space.offsetX) / sx,
    y: (box.y - space.offsetY) / sy,
    w: box.w / sx,
    h: box.h / sy,
  };
}

/**
 * THE sampler for tracked overlays: sample the track on its own clock and
 * return the box in COMPOSITION coordinates, ready for `resolveTrackedRect`.
 *
 * Every placement consumer (renderer, hit-test, the preview outline/gizmo,
 * the reposition drag) must go through this — `resolveTrackedRect` takes
 * composition coordinates, and handing it a raw source-pixel sample is the
 * bug this module exists to close.
 *
 * Returns null when the track is missing or has no sample at that clip time.
 * `visible` / `confidence` / `t` pass through untouched, so callers keep their
 * own `!sample.visible` check.
 */
export function sampleTrackedOverlay(
  overlay: Pick<TrackedOverlay, "startTime" | "duration" | "smoothing">,
  track: Track | undefined,
  overlays: readonly Overlay[] | undefined,
  globalTime: number,
): TrackSample | null {
  if (!track) return null;
  const space = resolveTrackedSpace(overlay, track, overlays);
  const sample = sampleTrack(track, trackedClipTime(space, globalTime), overlay.smoothing);
  if (!sample) return null;
  const box = trackBoxToComposition(space, sample);
  return { ...sample, ...box };
}
