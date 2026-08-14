/** Frame renderer for the Libi composition engine */

import type { Composition, DrawContext, Scene } from './types';
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

/** Per-frame draw isolation: a single scene or overlay whose draw fn throws
 *  (a broken canvas-scene body, a 3D-text/three instance that errors, a bad
 *  code overlay) must NOT abort the whole frame — otherwise `renderFrame`
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

/** Information about which scene a global frame falls in. `scene` is `null`
 *  when the composition has no scenes (the empty-scenes / overlay-only path). */
export interface SceneFrameInfo {
  scene: Scene | null;
  localFrame: number;
  sceneIndex: number;
}

/** Fill the whole frame with the composition's solid background (default
 *  black). Drawn under overlays on the empty-scenes path. */
export function fillBackground(
  ctx: CanvasRenderingContext2D,
  comp: Composition,
): void {
  ctx.fillStyle = comp.backgroundColor ?? "#000000";
  ctx.fillRect(0, 0, comp.width, comp.height);
}


/**
 * Returns the total number of frames across all scenes in a composition.
 */
export function getTotalFrames(composition: Composition): number {
  return composition.scenes.reduce(
    (total, scene) => total + Math.round(scene.duration * composition.fps),
    0,
  );
}

/**
 * Total frames the composition spans = the LATER of (a) the sum of scene
 * durations and (b) the end of the latest overlay or audio clip. Overlays and
 * audio clips may extend past the last scene; this is the value the timeline
 * ruler, the playhead end, and the export loop must use so a late-starting
 * caption / outro music tail is never truncated. (`getTotalFrames` stays
 * scene-only because scene→frame mapping in `getSceneAtFrame` depends on it.)
 */
export function getCompositionFrames(composition: Composition): number {
  const sceneFrames = getTotalFrames(composition);
  const endOf = (item: { startTime?: number; duration?: number }) =>
    Math.round(((item.startTime ?? 0) + (item.duration ?? 0)) * composition.fps);
  let max = sceneFrames;
  for (const o of composition.overlays ?? []) max = Math.max(max, endOf(o));
  for (const c of composition.audioClips ?? []) max = Math.max(max, endOf(c));
  return max;
}

/**
 * Determines which scene a given global frame falls in and calculates the
 * local frame number within that scene.
 */
export function getSceneAtFrame(
  composition: Composition,
  globalFrame: number,
): SceneFrameInfo {
  // Empty composition (video-less piece): no base scene to map to. Callers
  // either guard scenes.length first (scene-details, layers-inspector) or
  // handle the null sentinel (renderFrame, collectVideoSeekTargets).
  if (composition.scenes.length === 0) {
    return { scene: null, localFrame: 0, sceneIndex: -1 };
  }

  let accumulated = 0;

  for (let i = 0; i < composition.scenes.length; i++) {
    const scene = composition.scenes[i];
    const sceneFrames = Math.round(scene.duration * composition.fps);

    if (globalFrame < accumulated + sceneFrames) {
      return {
        scene,
        localFrame: globalFrame - accumulated,
        sceneIndex: i,
      };
    }

    accumulated += sceneFrames;
  }

  // Clamp to the last frame of the last scene
  const lastIndex = composition.scenes.length - 1;
  const lastScene = composition.scenes[lastIndex];
  const lastSceneFrames = Math.round(lastScene.duration * composition.fps);

  return {
    scene: lastScene,
    localFrame: lastSceneFrames - 1,
    sceneIndex: lastIndex,
  };
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
 * `renderFrame` (video scene) and `drawOverlay` (video + tracked-video
 * overlays) so the awaited decode matches the frame that gets drawn.
 */
export function collectVideoSeekTargets(
  composition: Composition,
  globalFrame: number,
): Array<{ id: string; time: number }> {
  const targets: Array<{ id: string; time: number }> = [];
  // Overlays are timed on the GLOBAL timeline (mirrors renderFrame's overlay
  // pass). Scenes are canvas-only and decode no video.
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
 * Draws the active canvas scene (its draw function), then composites every
 * active overlay on top in ascending z. The videoFrameSources map provides
 * decoded frame data for video overlays — keyed by overlay ID.
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

  // Overlays live on the GLOBAL composition timeline — their startTime/duration
  // are absolute, not scene-local — so they MUST be evaluated and drawn at
  // global time, not the active scene's local time. (The base scene below still
  // uses scene-local time for its own draw fn / video trim.) Without this, a
  // caption scoped to e.g. 0.4–5.8s re-appears at the start of EVERY scene
  // (each scene's local clock passes back through that window) and a 70s-mark
  // overlay never shows at all. drawOverlay reads ctx.time as absolute (video
  // localT, tracked sampleTrack, code-overlay clock), so feed it global time.
  const globalTime = globalFrame / composition.fps;
  const compTotalFrames = getTotalFrames(composition);

  // The live-overlay pass: draws overlays on top of the base scene, sorted by z.
  const drawLiveOverlays = (baseCtx: DrawContext) => {
    // Re-assert the base scale transform before drawing overlays. The base scene
    // draw is bracketed by save()/restore(), but this is belt-and-suspenders so a
    // canvas-scene body that mutated the transform WITHOUT balancing it can never
    // mis-scale or mis-place the overlays (they must always be crisp + correct).
    baseCtx.ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    if (composition.overlays && composition.overlays.length) {
      const active = overlaysActiveAt(composition.overlays, globalTime);
      for (const overlay of active) {
        // Isolate each overlay: a broken code/3D-text/three overlay must not
        // blank the base scene + sibling overlays. drawOverlay save()/restore()s
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

  const { scene, localFrame } = getSceneAtFrame(composition, globalFrame);

  // Empty-scenes path (video-less piece): no base scene to draw. Paint the
  // solid background, then run the overlay pass on top and return — skip all
  // scene-effects / scene-draw logic, which has no scene to operate on.
  if (scene === null) {
    ctx.clearRect(0, 0, composition.width, composition.height);
    fillBackground(ctx, composition);
    const emptyDrawContext: DrawContext = {
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
    drawLiveOverlays(emptyDrawContext);
    return;
  }

  const sceneFrames = Math.round(scene.duration * composition.fps);

  const sceneLocalTime = localFrame / composition.fps;
  const drawContext: DrawContext = {
    ctx,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    totalFrames: sceneFrames,
    frame: localFrame,
    time: sceneLocalTime,
    duration: scene.duration,
    progress: scene.duration > 0 ? clamp01(sceneLocalTime / scene.duration) : 0,
    assets,
    renderScale,
  };

  // Clear the canvas before drawing
  ctx.clearRect(0, 0, composition.width, composition.height);

  // Scene-level effects: compose the in/out/loop transform delta for this scene.
  const sceneStartTime = globalTime - drawContext.time;
  const sceneFx = composeEffects(
    {
      effects: (scene as { effects?: import("@/lib/effects/types").LayerEffects }).effects,
      globalTime,
      startTime: sceneStartTime,
      duration: scene.duration,
    },
    resolveEffect,
  );
  ctx.save();
  if (sceneFx.opacity !== undefined) ctx.globalAlpha = sceneFx.opacity;
  if (sceneFx.blurPx) ctx.filter = `blur(${sceneFx.blurPx}px)`;
  if (sceneFx.dx || sceneFx.dy || sceneFx.scale || sceneFx.rotateDeg) {
    const fcx = composition.width / 2;
    const fcy = composition.height / 2;
    ctx.translate((sceneFx.dx ?? 0), (sceneFx.dy ?? 0));
    ctx.translate(fcx, fcy);
    if (sceneFx.rotateDeg) ctx.rotate((sceneFx.rotateDeg * Math.PI) / 180);
    if (sceneFx.scale && sceneFx.scale !== 1) ctx.scale(sceneFx.scale, sceneFx.scale);
    ctx.translate(-fcx, -fcy);
  }

  // Scene-level clipReveal: edge-anchored wipe over the whole frame, in absolute
  // frame coordinates. Scoped to the scene-effects save()/restore() above.
  if (sceneFx.clipReveal) {
    const { edge, fraction } = sceneFx.clipReveal;
    const f = Math.max(0, Math.min(1, fraction));
    const W = composition.width, H = composition.height;
    ctx.beginPath();
    if (edge === "left")        ctx.rect(0, 0, W * f, H);
    else if (edge === "right")  ctx.rect(W * (1 - f), 0, W * f, H);
    else if (edge === "top")    ctx.rect(0, 0, W, H * f);
    else                         ctx.rect(0, H * (1 - f), W, H * f); // bottom
    ctx.clip();
  }

  // Canvas scene: call the draw fn, isolated so a broken body (e.g. a
  // reference error in agent-authored code) doesn't abort the whole frame —
  // overlays still render on top of whatever the scene managed to paint.
  try {
    scene.draw(drawContext);
  } catch (err) {
    warnOnceDraw(`scene:${scene.id}`, err);
  }

  ctx.restore(); // scene effects — IMMEDIATELY before drawLiveOverlays

  // Draw overlays on top of the base scene, sorted by z (ascending).
  drawLiveOverlays(drawContext);
}
