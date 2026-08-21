/** Frame renderer for the Libi composition engine */

import type { Composition, DrawContext } from './types';
import type { VideoFrameSource } from './video-frame-source';
import type { Track } from '@/lib/tracking/types';
import type { ThreeOverlayInstance } from './three-overlay';
import type { OverlayQuadInstance } from './overlay-quad';
import { drawOverlay } from './overlay-renderer';
import { overlaysActiveAt } from './overlays';
import type { ContentBox } from '@/lib/overlays/code-content-fit';
import { clamp01 } from './overlay-timing';
import { composeEffects } from '@/lib/effects/compose';
import { resolveEffect } from '@/lib/effects/registry';

/** Per-frame draw isolation: a single overlay whose draw fn throws (a broken
 *  code-overlay body, a 3D-text/three instance that errors) must NOT abort the
 *  whole frame — otherwise `renderFrame`
 *  unwinds after `clearRect` and the entire preview goes blank (silently, since
 *  the preview loop swallows the throw). We isolate each draw and skip only the
 *  offending element, warning ONCE per (element, message) so the console isn't
 *  spammed at 30fps. */
const _renderDrawWarned = new Set<string>();
function warnOnceDraw(key: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const dedup = `${key}::${msg}`;
  if (_renderDrawWarned.has(dedup)) return;
  _renderDrawWarned.add(dedup);
  // eslint-disable-next-line no-console
  console.warn(`[renderFrame] skipped ${key}: ${msg}`);
}

/** Fill the whole frame with the composition's solid background (default
 *  black). Drawn under every overlay. */
export function fillBackground(
  ctx: CanvasRenderingContext2D,
  comp: Composition,
): void {
  ctx.fillStyle = comp.backgroundColor ?? "#000000";
  ctx.fillRect(0, 0, comp.width, comp.height);
}


/**
 * Total frames the composition spans — the end of the latest overlay or audio
 * clip. This is the value the timeline ruler, the playhead end, and the export
 * loop must use so a late-starting caption or outro music tail is never
 * truncated.
 */
export function getCompositionFrames(composition: Composition): number {
  const endOf = (item: { startTime?: number; duration?: number }) =>
    Math.round(((item.startTime ?? 0) + (item.duration ?? 0)) * composition.fps);
  let max = 0;
  for (const o of composition.overlays ?? []) max = Math.max(max, endOf(o));
  for (const c of composition.audioClips ?? []) max = Math.max(max, endOf(c));
  return max;
}

/**
 * Collects the (sourceId, source-time) pairs that `renderFrame` will read
 * from `videoFrameSources` for a given global frame — one per active video /
 * tracked-video overlay.
 *
 * This exists so an ASYNC caller (the export pipeline) can await each video
 * source's decode at the exact time before invoking the SYNCHRONOUS
 * `renderFrame`. `renderFrame` reads `getFrame()` synchronously, which returns
 * the source's last-decoded frame; without a prior awaited decode the exported
 * frame is stale (frozen). The live preview self-heals across its rAF loop
 * (and its hold-last-frame fallback), but a one-shot export must
 * seek-and-wait per frame.
 *
 * The time formulas here MUST stay in lockstep with the seek calls in
 * `drawOverlay` (video + tracked-video overlays) so the awaited decode matches
 * the frame that gets drawn.
 */
export function collectVideoSeekTargets(
  composition: Composition,
  globalFrame: number,
): Array<{ id: string; time: number }> {
  const targets: Array<{ id: string; time: number }> = [];
  // Overlays are timed on the GLOBAL timeline (mirrors renderFrame's overlay
  // pass).
  const globalTime = globalFrame / composition.fps;

  if (composition.overlays && composition.overlays.length) {
    // drawOverlay receives the GLOBAL drawContext.time, so mirror that.
    const active = overlaysActiveAt(composition.overlays, globalTime);
    for (const o of active) {
      if (o.kind === "video") {
        targets.push({
          id: o.id,
          time: globalTime - o.startTime + (o.trim?.start ?? 0),
        });
      } else if (o.kind === "tracked" && o.content.kind === "video") {
        targets.push({ id: o.id, time: globalTime });
      }
    }
  }
  return targets;
}

/**
 * Renders a single frame of a composition onto the given canvas.
 *
 * Paints the composition background, then composites every active overlay on
 * top in ascending z. The videoFrameSources map provides decoded frame data for
 * video overlays — keyed by overlay ID.
 */
export function renderFrame(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  composition: Composition,
  globalFrame: number,
  assets: Record<
    string,
    HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
  > = {},
  videoFrameSources?: Record<string, VideoFrameSource>,
  imageElements?: Record<string, HTMLImageElement>,
  compiledDrawFns?: Record<string, (ctx: DrawContext) => void>,
  tracks?: Record<string, Track>,
  threeScenes?: Record<string, ThreeOverlayInstance>,
  spatialQuads?: Record<string, OverlayQuadInstance>,
  codeContentBoxes?: Record<string, ContentBox | null>,
): void {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  if (!ctx) {
    throw new Error('Failed to get 2D rendering context from canvas');
  }

  // The canvas backing store IS the render resolution — the caller sizes it:
  //   • preview: display px × devicePixelRatio (capped) → crisp overlays on-screen
  //   • export:  the target export resolution (e.g. 3840×2160) → true 4K overlays
  // We no longer clamp the canvas to the composition's LOGICAL size. Instead we
  // scale the coordinate space so every draw call keeps using composition
  // (logical) pixels while rasterizing at the backing resolution. Vector/text/
  // code/3D overlays redraw at that density → sharp; video is just scaled to
  // fill (no new detail, no loss). A zero-sized canvas (caller never sized it)
  // falls back to the logical size, i.e. renderScale 1 = legacy behavior.
  if (!canvas.width || !canvas.height) {
    canvas.width = composition.width;
    canvas.height = composition.height;
  }
  const renderScaleX = canvas.width / composition.width;
  const renderScaleY = canvas.height / composition.height;
  // Uniform for all real callers (preview + export preserve the composition
  // aspect); the per-axis values only diverge for a degenerate/mismatched
  // backing (e.g. a test canvas), where distortion is acceptable.
  const renderScale = renderScaleX;
  ctx.setTransform(renderScaleX, 0, 0, renderScaleY, 0, 0);

  // Overlays live on the GLOBAL composition timeline — their startTime and
  // duration are absolute — so they are evaluated and drawn at global time.
  // `drawOverlay` remaps to each overlay's own window internally (video localT,
  // tracked sampleTrack, code-overlay clock), so feed it global time here.
  const globalTime = globalFrame / composition.fps;
  const compTotalFrames = getCompositionFrames(composition);

  // The live-overlay pass: draws every active overlay, sorted by z.
  const drawLiveOverlays = (baseCtx: DrawContext) => {
    // Re-assert the base scale transform before drawing overlays, so a draw body
    // that mutated the transform WITHOUT balancing it can never mis-scale or
    // mis-place the ones after it (they must always be crisp + correct).
    baseCtx.ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    if (composition.overlays && composition.overlays.length) {
      const active = overlaysActiveAt(composition.overlays, globalTime);
      for (const overlay of active) {
        // Isolate each overlay: a broken code/3D-text/three overlay must not
        // blank the background + sibling overlays. drawOverlay save()/restore()s
        // internally, but a throw mid-draw could leave the ctx stack unbalanced,
        // so we snapshot depth and rebalance on failure.
        const savedAlpha = baseCtx.ctx.globalAlpha;
        try {
          drawOverlay(overlay, {
            ...baseCtx,
            // Global-timeline coordinates for overlay timing.
            frame: globalFrame,
            time: globalTime,
            totalFrames: compTotalFrames,
            videoFrameSources,
            imageElements,
            compiledDrawFns,
            codeContentBoxes,
            tracks,
            // The full overlay list — a tracked overlay resolves the video
            // overlay its track rides on from it, which is what puts the art
            // on the subject's own clock and in the video's own pixel space
            // (lib/engine/tracked-space.ts). Not `active`: the owning video
            // may be windowed differently from the tracked art.
            overlays: composition.overlays,
            threeScenes,
            spatialQuads,
            // The canvas being drawn on serves as the source for effect overlays
            // (blur/pixelate). Each effect reads the already-composited pixels
            // before this overlay draws — order of operations is safe since the
            // effect clips to its own bbox.
            sourceCanvas: canvas as HTMLCanvasElement | OffscreenCanvas,
          });
        } catch (err) {
          baseCtx.ctx.globalAlpha = savedAlpha;
          warnOnceDraw(`overlay:${overlay.id}`, err);
        }
      }
    }
  };

  // No base layer to draw: paint the composition background, then run the
  // overlay pass on top. Full-frame backgrounds are ordinary `code` overlays at
  // the floor z — the canvas-scene layer that used to sit under everything was
  // retired because it had no startTime, rect, z or opacity, which made it the
  // one layer the editor could not move.
  ctx.clearRect(0, 0, composition.width, composition.height);
  fillBackground(ctx, composition);
  const drawContext: DrawContext = {
    ctx,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    totalFrames: compTotalFrames,
    frame: globalFrame,
    time: globalTime,
    duration: 0,
    progress: 0,
    assets,
    renderScale,
  };
  drawLiveOverlays(drawContext);
}
