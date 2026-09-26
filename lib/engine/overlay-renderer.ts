import type { DrawContext, Overlay, OverlayRect, TextOverlay, TrackedOverlay, Transform3D } from "./types";
import type { VideoFrameSource } from "./video-frame-source";
import type { ThreeOverlayInstance } from "./three-overlay";
import type { OverlayQuadInstance } from "@/lib/engine/overlay-quad";
import { unionRect } from "@/lib/engine/three-content-bounds";
import { projectSpatialQuadBboxUnclamped } from "@/lib/engine/overlay-quad-projection";
import { fitRect, coverRect } from "./letterbox";
import { drawWithBalancedState } from "./canvas-state";
import { sampleTrackedOverlay } from "@/lib/engine/tracked-space";
import type { Track, TrackFit } from "@/lib/tracking/types";
import { MAX_LAYER_SIDE, clampRenderGeometry } from "@/lib/sandbox/protocol";
import { elementTiming } from "./overlay-timing";
import { valueAt } from "@/lib/engine/animatable";
import { resolveOverlayTransform, resolveFlip, planarCanvas2DOps, classifyTransform, splitScreenRoll } from "@/lib/engine/overlay-transform";
import { textUsesThreeInstance } from "@/lib/overlays/three-d-mode";
import { composeEffects } from "@/lib/effects/compose";
import { resolveEffect } from "@/lib/effects/registry";
import { cssFamilyForFontFile, withFamily } from "@/lib/fonts/family";
import {
  composeFont,
  wrapText,
  typewriterCharCount,
  fadeWordsAlpha,
  slideUpOffset,
  popScale,
} from "@/lib/overlays/caption-style";
import {
  activeWordIndexByProgress,
  activeWordIndexByTime,
  currentWordLabel,
  fadeWordsAlphaByTime,
  revealFraction,
} from "./text-anim/caption-reveal";
import { currentWord, typewriterRevealedText } from "./text-anim/caption-logic";
import { captionPlateRect, layoutTextOverlay } from "@/lib/captions/layout";
import { anchorPointOf } from "@/lib/captions/anchor";
import type { LayerRequest, LayerSource } from "./layer-source";
import type { LayerPad } from "@/lib/sandbox/protocol";

// `expansionSig` is the pure signature over a 3D transform + rect (rounded to
// avoid float churn). It outlived the content-bounds expansion cache it once
// keyed — 3D text + `three` overlays now use the window model (render into the
// rect, draw at the rect, no expansion) — but the helper is retained as the
// canonical "did the 3D framing inputs change?" signature.
export function expansionSig(t: Transform3D, rect: OverlayRect, scale: number): string {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return [
    r(t.rotation.x), r(t.rotation.y), r(t.rotation.z),
    r(t.position.x), r(t.position.y), r(t.position.z),
    Math.round(rect.width), Math.round(rect.height),
    r(scale),
  ].join(",");
}

/** A box for transform-anchoring — works for both `overlay.rect` and a
 *  resolved tracked bbox (note: tracked boxes use w/h; callers pass
 *  width/height here). */
export interface TransformBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayTransform {
  flipH?: boolean;
  flipV?: boolean;
  transform3d?: Transform3D;
}

/**
 * Apply a center-anchored planar transform to `ctx`: translate to the box
 * center, rotate by the in-plane roll (`transform3d.rotation.z`), scale for
 * flips, translate back. MUTATES `ctx` — callers must have already called
 * `ctx.save()` and must `ctx.restore()` afterwards. No-ops entirely when the
 * transform is identity (no roll and no flip) so unmodified overlays pay nothing.
 */
export function applyOverlayTransform(
  ctx: CanvasRenderingContext2D,
  box: TransformBox,
  t: OverlayTransform,
  opts?: { skipRoll?: boolean },
): void {
  let resolved = resolveOverlayTransform(t as never);
  // Self-rolling kinds (`three`, 3D-mode text) apply the in-plane roll
  // themselves, AFTER their GL composite, about the rect center — rolling here
  // too would double the rotation (box at θ, content at 2θ). They still need
  // this wrapper for flip.
  if (opts?.skipRoll && resolved.rotation.z !== 0) {
    resolved = { position: resolved.position, rotation: { ...resolved.rotation, z: 0 } };
  }
  const flip = resolveFlip(t as never);
  for (const op of planarCanvas2DOps(resolved, box, flip)) {
    if (op.kind === "translate") ctx.translate(op.x, op.y);
    else if (op.kind === "rotate") ctx.rotate(op.rad);
    else ctx.scale(op.x, op.y);
  }
}

export interface LayerPlan {
  request: LayerRequest;
  /** three only: in-plane screen roll the host applies about the rect's center. */
  rollRad: number;
}

export interface LayerPlanContext {
  time: number;
  fps: number;
  width: number;
  height: number;
  renderScale: number;
  tracks?: Record<string, Track>;
  overlays?: readonly Overlay[];
  /** A tracked overlay's already-resolved bbox (the tracked case computes it
   *  first); when absent it is sampled here from `tracks`/`overlays`. */
  trackedBbox?: { x: number; y: number; w: number; h: number };
}

/** Layers are whole composition pixels: a fractional size (every tracked bbox,
 *  any keyframed rect mid-tween) would otherwise re-allocate the layer and
 *  re-probe its fit on every frame. The position stays sub-pixel. */
/**
 * The two ends of the rect keyframe segment `progress` falls in, as layer
 * sizes — only when that segment changes the size. Mirrors `valueAt`'s own
 * segment choice (sorted by `t`, half-open `[t_i, t_i+1)`); outside the track,
 * on a shared-`t` step, or on a position-only segment the size is constant
 * and the fit is measured at it exactly.
 */
function rectSizeSegment(
  overlay: Overlay,
  progress: number,
): { from: { width: number; height: number }; to: { width: number; height: number } } | undefined {
  const kfs = overlay.keyframes?.rect?.keyframes;
  if (!kfs || kfs.length < 2) return undefined;
  const sorted = [...kfs].sort((x, y) => x.t - y.t);
  if (progress <= sorted[0]!.t || progress >= sorted[sorted.length - 1]!.t) return undefined;
  for (let j = 0; j < sorted.length - 1; j++) {
    const left = sorted[j]!;
    const right = sorted[j + 1]!;
    if (left.t <= progress && progress < right.t) {
      if (right.t - left.t <= 0) return undefined;
      const cap = (v: number) => Math.min(v, MAX_LAYER_SIDE);
      const from = layerSize(cap(left.value.width), cap(left.value.height));
      const to = layerSize(cap(right.value.width), cap(right.value.height));
      if (from.width === to.width && from.height === to.height) return undefined;
      return { from, to };
    }
  }
  return undefined;
}

function layerSize(width: number, height: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/**
 * The room a tracked `code` layer gets around its box: one box size on every
 * side, cut back to the output canvas. The old in-process path drew tracked
 * bodies on the main canvas with no clip, so a name tag above a face, a glow
 * or a label beside a product landed; a layer the size of the box alone would
 * cut all of that off. Whole pixels, floored, so the layer never reaches past
 * the canvas.
 */
function trackedPad(
  box: { x: number; y: number },
  size: { width: number; height: number },
  canvas: { width: number; height: number },
): LayerPad {
  const clamp = (v: number, max: number) => Math.floor(Math.min(max, Math.max(0, v)));
  return {
    left: clamp(box.x, size.width),
    top: clamp(box.y, size.height),
    right: clamp(canvas.width - (box.x + size.width), size.width),
    bottom: clamp(canvas.height - (box.y + size.height), size.height),
  };
}

/**
 * Everything the runtime needs to draw one body layer for this frame — the
 * same timing, rect and transform maths the host used to apply around the body
 * call (spec §4.4). Pure; shared by `drawOverlay` (preview, per case) and
 * `collectLayerRequests` (export, before the frame), so the two can't drift.
 */
export function planLayer(overlay: Overlay, c: LayerPlanContext): LayerPlan | null {
  const plan = planLayerUncapped(overlay, c);
  // Within the wire's caps (protocol.ts): the bitmap is placed by the
  // geometry of the request it answers, so it must be the one it was rendered at.
  return plan && { ...plan, request: { ...plan.request, ...clampRenderGeometry(plan.request) } };
}

function planLayerUncapped(overlay: Overlay, c: LayerPlanContext): LayerPlan | null {
  const timing = elementTiming(c.time, c.fps, overlay.startTime, overlay.duration);
  const words = overlay.caption?.words;
  const common = { overlayId: overlay.id, frame: timing.frame, pixelRatio: c.renderScale, fps: c.fps, time: timing, ...(words ? { words } : {}) };
  if (overlay.kind === "code") {
    const rect = valueAt(overlay.keyframes?.rect ?? overlay.rect, timing);
    const size = layerSize(rect.width, rect.height);
    // Inside a keyframe segment that changes the SIZE, the fit is measured at
    // the segment's two ends and interpolated (lib/overlays/code-content-fit.ts
    // #interpolateContentBox), so a tween does not re-run the content-fit probe
    // on every frame; anywhere else it is measured at the exact size.
    const fitSegment = rectSizeSegment(overlay, timing.progress);
    return { request: { ...common, kind: "code", size, ...(fitSegment ? { fitSegment } : {}) }, rollRad: 0 };
  }
  if (overlay.kind === "three") {
    const rect = valueAt(overlay.keyframes?.rect ?? overlay.rect, timing);
    const resolved3d = valueAt(overlay.keyframes?.transform3d ?? resolveOverlayTransform(overlay), timing);
    const { spatial, rollRad } = splitScreenRoll(resolved3d);
    return { request: { ...common, kind: "three", size: layerSize(rect.width, rect.height), transform3d: spatial }, rollRad };
  }
  if (overlay.kind === "tracked" && overlay.content.kind === "code") {
    let bbox = c.trackedBbox;
    if (!bbox) {
      const track = c.tracks?.[overlay.trackId];
      if (!track) return null;
      const sample = sampleTrackedOverlay(overlay, track, c.overlays, c.time);
      if (!sample || !sample.visible) return null;
      bbox = resolveTrackedRect(sample, overlay, { width: c.width, height: c.height });
    }
    const size = layerSize(bbox.w, bbox.h);
    const pad = trackedPad(bbox, size, { width: c.width, height: c.height });
    return { request: { ...common, kind: "tracked", size, pad }, rollRad: 0 };
  }
  return null;
}

function planContextOf(drawCtx: DrawOverlayContext, trackedBbox?: LayerPlanContext["trackedBbox"]): LayerPlanContext {
  return {
    time: drawCtx.time,
    fps: drawCtx.fps,
    width: drawCtx.width,
    height: drawCtx.height,
    renderScale: drawCtx.renderScale ?? 1,
    tracks: drawCtx.tracks,
    overlays: drawCtx.overlays,
    ...(trackedBbox ? { trackedBbox } : {}),
  };
}

/** Ask for the layer and draw whatever the source has (preview: the newest
 *  bitmap, possibly a frame old; export: exactly this frame). `at` is where
 *  the caller placed the body's box — the rect, the tracked bbox, or the
 *  spatial scratch's origin — with the current request's `size`.
 *
 *  The bitmap is placed by the geometry it was RENDERED for (review N1): its
 *  own box is scaled onto the current box on each axis and its pad scales with
 *  it, so a held bitmap from before a resize or a tracked box change lands on
 *  the current box rather than being zoomed, cropped or shifted. When that
 *  geometry is the current one the scale is exactly 1 and the draw is 1:1. */
function drawBodyLayer(
  ctx: CanvasRenderingContext2D,
  drawCtx: DrawOverlayContext,
  overlay: Overlay,
  at: OverlayRect,
  trackedBbox?: LayerPlanContext["trackedBbox"],
): void {
  const layers = drawCtx.layers;
  if (!layers) return;
  const plan = planLayer(overlay, planContextOf(drawCtx, trackedBbox));
  if (!plan) return;
  layers.request(plan.request);
  const layer = layers.get(overlay.id, plan.request.frame);
  if (!layer) return;
  const { size, pad, pixelRatio } = layer;
  const current = plan.request.size;
  const sx = current.width / size.width;
  const sy = current.height / size.height;
  // The layer in the logical px it was rendered at: its box plus its pad.
  const w = size.width + (pad ? pad.left + pad.right : 0);
  const h = size.height + (pad ? pad.top + pad.bottom : 0);
  const x = at.x - (pad?.left ?? 0) * sx;
  const y = at.y - (pad?.top ?? 0) * sy;
  // The runtime's canvas is ceil(w × pixelRatio) device px; naming the source
  // rect keeps the draw 1:1 instead of squeezing that rounding into w × h.
  const draw = () => ctx.drawImage(layer.bitmap, 0, 0, w * pixelRatio, h * pixelRatio, x, y, w * sx, h * sy);
  if (plan.rollRad) {
    const cx = at.x + at.width / 2;
    const cy = at.y + at.height / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(plan.rollRad);
    ctx.translate(-cx, -cy);
    draw();
    ctx.restore();
  } else {
    draw();
  }
}

export interface DrawOverlayContext extends DrawContext {
  /** For video overlays. Keyed by overlay.id. */
  videoFrameSources?: Record<string, VideoFrameSource>;
  /** For image overlays. Keyed by overlay.id. */
  imageElements?: Record<string, HTMLImageElement>;
  /** For code / three / tracked-code overlays — the sandboxed body layers
   *  (spec §4.4). Absent ⇒ those overlays draw nothing (transient loading). */
  layers?: LayerSource;
  /** For 3D-TEXT overlays only (host-built, not a body) — prebuilt instance keyed by overlay.id. */
  threeScenes?: Record<string, ThreeOverlayInstance>;
  /** For spatial (out-of-plane) 2D overlays — prebuilt textured-quad instance keyed by overlay.id. */
  spatialQuads?: Record<string, OverlayQuadInstance>;
  /** For tracked overlays. Keyed by overlay.trackId (NOT overlay.id). */
  tracks?: Record<string, Track>;
  /** The composition's FULL overlay list (not just the active ones). A tracked
   *  overlay needs it to find the video overlay its track was computed on —
   *  that video is what converts global time to the track's source-clip clock
   *  and source pixels to composition pixels (see lib/engine/tracked-space.ts).
   *  Absent ⇒ the identity space, i.e. the pre-fix behaviour. */
  overlays?: readonly Overlay[];
  /** The composed base scene canvas — needed by effect overlays (blur/pixelate). */
  sourceCanvas?: HTMLCanvasElement | OffscreenCanvas;
}

let _scratch: { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D } | null = null;
/** A single reused offscreen canvas for rasterizing spatial overlays' 2D content. */
function getScratchCanvas(w: number, h: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D } {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  if (!_scratch) {
    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(cw, ch) : document.createElement("canvas");
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    _scratch = { canvas, ctx };
  }
  if (_scratch.canvas.width !== cw) _scratch.canvas.width = cw;
  if (_scratch.canvas.height !== ch) _scratch.canvas.height = ch;
  return _scratch;
}

/**
 * Renders a single overlay onto the canvas. Overlays are drawn AFTER the
 * base scene. Image, video and tracked overlays need asset maps
 * (imageElements/videoFrameSources/tracks) populated by the editor's hooks;
 * code, three and tracked-code bodies come as bitmaps from `layers`. If a
 * required asset or layer is missing, the overlay silently no-ops so a
 * transient loading state never throws.
 */
export function drawOverlay(overlay: Overlay, drawCtx: DrawOverlayContext): void {
  const { ctx } = drawCtx;
  // Composition→backing scale (see DrawContext.renderScale). Secondary buffers
  // (three/GL) and device-pixel source sampling (effect overlays) must honor it
  // so they rasterize at the same density as the base transform, not at the
  // logical 1080p size (which would upscale-blur them on a 4K export / HiDPI
  // preview). 1 = legacy (backing == composition).
  const renderScale = drawCtx.renderScale ?? 1;
  // Keyframe-forward-compat seam: read the animatable overlay properties
  // (opacity / rect / transform3d) through `valueAt(prop, timing)` rather than
  // directly. `timing` is the element-local window (same shape the code-overlay
  // path uses). `valueAt` returns plain constants unchanged today, so this is
  // behavior-neutral; the future keyframe spec changes only the data model +
  // `valueAt`, not the renderer.
  const timing = elementTiming(drawCtx.time, drawCtx.fps, overlay.startTime, overlay.duration);
  const rect = valueAt(overlay.keyframes?.rect ?? overlay.rect, timing);
  const opacity = valueAt(overlay.keyframes?.opacity ?? overlay.opacity, timing);

  ctx.save();
  // Effects: compose the in/out/loop transform delta for this overlay.
  const fxDelta = composeEffects(
    { effects: overlay.effects, globalTime: drawCtx.time, startTime: overlay.startTime, duration: overlay.duration },
    resolveEffect,
  );
  ctx.globalAlpha = opacity * (fxDelta.opacity ?? 1);
  if (fxDelta.blurPx) ctx.filter = `blur(${fxDelta.blurPx}px)`;
  // Effect translate/scale/rotate around the rect center
  const ecx = rect.x + rect.width / 2;
  const ecy = rect.y + rect.height / 2;
  if (fxDelta.dx || fxDelta.dy) ctx.translate(fxDelta.dx ?? 0, fxDelta.dy ?? 0);
  if (fxDelta.scale || fxDelta.scaleX || fxDelta.scaleY || fxDelta.rotateDeg) {
    ctx.translate(ecx, ecy);
    if (fxDelta.rotateDeg) ctx.rotate((fxDelta.rotateDeg * Math.PI) / 180);
    const sx = (fxDelta.scale ?? 1) * (fxDelta.scaleX ?? 1);
    const sy = (fxDelta.scale ?? 1) * (fxDelta.scaleY ?? 1);
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
    ctx.translate(-ecx, -ecy);
  }

  // Spatial (out-of-plane) transform on a 2D kind → render via the textured quad.
  // Three / 3D-text are excluded: they own the shared three renderer and apply
  // their transform in their own case below.
  const is2DKind =
    overlay.kind === "image" || overlay.kind === "video" || overlay.kind === "code"
    || (overlay.kind === "text" && !textUsesThreeInstance(overlay));
  if (is2DKind) {
    const resolved = valueAt(overlay.keyframes?.transform3d ?? resolveOverlayTransform(overlay), timing);
    if (classifyTransform(resolved) === "spatial") {
      const quad = drawCtx.spatialQuads?.[overlay.id];
      if (quad) {
        // For TEXT, the quad must be sized to the MEASURED point-text box (the
        // authored rect can be smaller than the text, which would CLIP the
        // tilted text). Other kinds keep the authored rect. The scratch canvas
        // renders the content at the box ORIGIN (0,0); the quad is then placed
        // at the box position so the tilt is centered correctly.
        let qrect = rect;
        if (overlay.kind === "text") {
          const scratchForMeasure = getScratchCanvas(1, 1);
          const t = overlay as TextOverlay;
          scratchForMeasure.ctx.font = textOverlayFontString(t);
          qrect = effectiveTextRect(
            t,
            (s) => scratchForMeasure.ctx.measureText(s).width,
            drawCtx.width,
          );
        }
        const flip = resolveFlip(overlay);
        // In-plane Spin (rotation.z) is a 2D screen-roll applied AFTER the
        // perspective projection — never folded into the quad's 3D euler (which
        // would make the projected footprint swing as you spin). Project + render
        // the tilt only; roll the composited result about the rect center.
        const { spatial, rollRad } = splitScreenRoll(resolved);
        const bbox = projectSpatialQuadBboxUnclamped(qrect, spatial, flip);
        const expanded = unionRect(qrect, bbox);
        const offX = qrect.x - expanded.x;
        const offY = qrect.y - expanded.y;
        const scratch = getScratchCanvas(qrect.width, qrect.height);
        scratch.ctx.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
        // The scratch canvas is shared by every spatial overlay, every frame.
        // The content draw clips/translates it (the code case never restores —
        // on the main canvas drawOverlay's own save covers that), and a body
        // can throw mid-draw: save first and let drawWithBalancedState pop it
        // plus anything the draw left open, or the next clear and draw run
        // clipped and offset.
        drawWithBalancedState(scratch.ctx, () => {
          scratch.ctx.save();
          drawOverlayContent2D(overlay, { ...drawCtx, ctx: scratch.ctx }, { x: 0, y: 0, width: qrect.width, height: qrect.height });
        });
        const gl = quad.render(scratch.canvas, spatial, flip, qrect.width, qrect.height, expanded.width, expanded.height, offX, offY);
        if (rollRad) {
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          ctx.translate(cx, cy);
          ctx.rotate(rollRad);
          ctx.translate(-cx, -cy);
        }
        ctx.drawImage(gl as CanvasImageSource, expanded.x, expanded.y, expanded.width, expanded.height);
      }
      ctx.restore();
      return;
    }
  }

  // Center-anchored manual transform (rotation/flip) wraps every non-tracked kind.
  // Tracked overlays apply it around the RESOLVED bbox center (see below),
  // so they're excluded here to avoid double-application. `three` and 3D-mode
  // text own their roll (post-GL-composite about the rect center in their case
  // branches) — skip it here or a pure roll renders at 2θ while the gizmo box
  // shows θ (the "box doesn't rotate in sync with the text" bug).
  if (overlay.kind !== "tracked") {
    const selfRolls =
      overlay.kind === "three" || (overlay.kind === "text" && textUsesThreeInstance(overlay));
    applyOverlayTransform(ctx, rect, overlay, { skipRoll: selfRolls });
  }


  // Effect clipReveal: edge-anchored wipe. The transform above leaves the canvas
  // in ABSOLUTE rect coordinates (translate-to-center then back), so clip in
  // rect.x/rect.y space. Scoped to this overlay's outer save()/restore().
  if (fxDelta.clipReveal) {
    const { edge, fraction } = fxDelta.clipReveal;
    const f = Math.max(0, Math.min(1, fraction));
    const w = rect.width, h = rect.height;
    const x0 = rect.x, y0 = rect.y;
    ctx.beginPath();
    if (edge === "left")        ctx.rect(x0, y0, w * f, h);
    else if (edge === "right")  ctx.rect(x0 + w * (1 - f), y0, w * f, h);
    else if (edge === "top")    ctx.rect(x0, y0, w, h * f);
    else                         ctx.rect(x0, y0 + h * (1 - f), w, h * f); // bottom
    ctx.clip();
  }

  switch (overlay.kind) {
    case "text": {
      // A 3D-text overlay (overlay.threeD) renders through a prebuilt three
      // instance keyed by overlay.id, the same way `case "three"` does. Falls
      // back to the flat Canvas2D path when no instance is ready (still building,
      // faux/premium build failed, or the overlay isn't 3D).
      //
      // REVEAL SUPPORT (per-letter animation) on the 3D path now covers EVERY
      // mode: the instance gets element-local `progress` EVERY frame (below),
      // and build-text-three.ts#update animates typewriter / word-current /
      // karaoke / flythrough by toggling per-glyph visibility/scale AND
      // fade-words / slide-up / pop via a per-word transform stagger
      // (glyphRevealState in lib/engine/text-3d/word-reveal.ts). No reveal mode
      // is static in 3D anymore. The flat 2D + planar/spatial-tilt path
      // (drawTextOverlay, re-rendered per frame) remains the fallback when no
      // three instance is ready. See text-reveal-paths.test.ts +
      // text-3d-word-reveal.test.ts.
      const inst = textUsesThreeInstance(overlay) ? drawCtx.threeScenes?.[overlay.id] : undefined;
      if (inst) {
        const t = elementTiming(drawCtx.time, drawCtx.fps, overlay.startTime, overlay.duration);
        const resolved3d = valueAt(overlay.keyframes?.transform3d ?? resolveOverlayTransform(overlay), timing);
        // In-plane Spin (rotation.z) is a 2D screen-roll about the rect center —
        // NOT a three.js `scene.rotation.z` (which rolls counter-clockwise, the
        // opposite of every other overlay's Canvas2D `ctx.rotate`). Feed the
        // builder the out-of-plane part only; roll the composite afterwards so 3D
        // text spins the SAME direction as plain text / three / image.
        const { spatial: transform3d, rollRad } = splitScreenRoll(resolved3d);
        inst.update?.({
          frame: t.frame,
          time: t.time,
          totalFrames: t.totalFrames,
          duration: t.duration,
          progress: t.progress,
          transform3d,
          words: overlay.caption?.words,
        });
        // Window model (matches `case "three"`): apply the 3D transform, render
        // the scene INTO the rect-sized viewport, and composite at the rect.
        // Content that tilts/extrudes past the rect is clipped by the GL render
        // — predictable, stays inside the gizmo box, and follows drags 1:1. The
        // old content-bounds expansion drew the text at an offset OUTSIDE the box
        // (and lagged on drag) — the same first-paint-misframe the `three` case
        // abandoned. Depth (position.z) still moves the text toward/away.
        inst.applyTransform(transform3d);
        // Render the GL buffer at the BACKING resolution (rect × renderScale) so
        // 3D text is crisp when the canvas is a 4K export / HiDPI preview; the
        // drawImage dest stays in composition coords (the base ctx scale places
        // it), so buffer→dest maps 1:1.
        const glCanvas = inst.render(rect.width * renderScale, rect.height * renderScale);
        if (rollRad) {
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(rollRad);
          ctx.translate(-cx, -cy);
          ctx.drawImage(glCanvas as CanvasImageSource, rect.x, rect.y, rect.width, rect.height);
          ctx.restore();
        } else {
          ctx.drawImage(glCanvas as CanvasImageSource, rect.x, rect.y, rect.width, rect.height);
        }
      } else {
        drawOverlayContent2D(overlay, drawCtx, rect);
      }
      break;
    }
    case "image": {
      drawOverlayContent2D(overlay, drawCtx, rect);
      break;
    }
    case "video": {
      drawOverlayContent2D(overlay, drawCtx, rect);
      break;
    }
    case "code": {
      drawOverlayContent2D(overlay, drawCtx, rect);
      break;
    }
    case "three": {
      // Bodies render in the sandbox (spec §4.4); the host composites the
      // bitmap inside exactly the ctx state above and rolls it about the rect
      // center (in-plane Spin stays a 2D screen roll — see splitScreenRoll).
      drawBodyLayer(ctx, drawCtx, overlay, rect);
      break;
    }
    case "tracked": {
      const track = drawCtx.tracks?.[overlay.trackId];
      if (!track) break;
      // Track samples are timed on the SOURCE CLIP's clock and positioned in
      // SOURCE VIDEO pixels — neither is the composition's. `drawCtx.time` is
      // global composition time, so both have to be converted through the
      // video overlay the track rides on (lib/engine/tracked-space.ts). That
      // still lets several overlays in different windows share ONE track: each
      // resolves the same clip clock and each follows the subject at its own
      // time. With no owning video the conversion is the identity.
      const sample = sampleTrackedOverlay(overlay, track, drawCtx.overlays, drawCtx.time);
      if (!sample || !sample.visible) break;

      const bbox = resolveTrackedRect(sample, overlay, {
        width: drawCtx.width,
        height: drawCtx.height,
      });
      ctx.save();
      // Transform composes about the RESOLVED tracked box center, not overlay.rect.
      applyOverlayTransform(
        ctx,
        { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h },
        overlay,
      );
      const cx = bbox.x + bbox.w / 2;
      const cy = bbox.y + bbox.h / 2;

      switch (overlay.content.kind) {
        case "emoji": {
          const size = Math.max(bbox.w, bbox.h);
          ctx.font = `${size}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(overlay.content.char, cx, cy);
          break;
        }
        case "text": {
          drawTrackedText(ctx, overlay.content, bbox);
          break;
        }
        case "image": {
          const img = drawCtx.imageElements?.[overlay.id];
          if (img) ctx.drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h);
          break;
        }
        case "video": {
          const src = drawCtx.videoFrameSources?.[overlay.id];
          // A failed source has nothing to paint (the owning video overlay
          // shows the placeholder).
          if (src && !src.failure?.()) {
            src.seek(drawCtx.time);
            // Hold-last-frame parity (see drawOverlayContent2D / renderer.ts).
            const liveReady = src.isReadyAt ? src.isReadyAt(drawCtx.time) : true;
            const liveFrame = src.getFrame(drawCtx.time);
            const heldFrame = !liveReady ? src.lastGoodFrame?.() ?? null : null;
            const frame = heldFrame ?? liveFrame;
            if (frame) ctx.drawImage(frame as CanvasImageSource, bbox.x, bbox.y, bbox.w, bbox.h);
          }
          break;
        }
        case "code": {
          drawBodyLayer(ctx, drawCtx, overlay, { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h }, bbox);
          break;
        }
        case "effect": {
          const source = drawCtx.sourceCanvas;
          if (source) applyEffectAtRect(ctx, source, bbox, overlay.content.op, renderScale);
          break;
        }
      }
      ctx.restore();
      break;
    }
  }

  ctx.restore();
}

// ─── Shared 2D content helper ─────────────────────────────────────────────────

/**
 * Draw a 2D overlay's CONTENT (no transform wrapper) into `ctx` at `localRect`.
 * Shared by the normal planar path (localRect = overlay.rect, drawn into the
 * main canvas) and the spatial quad path (localRect = {0,0,w,h} of an offscreen
 * texture canvas). Three / 3D-text overlays are NOT handled here — they own the
 * shared three renderer. Missing assets no-op (transient loading).
 */
export function drawOverlayContent2D(
  overlay: Overlay,
  drawCtx: DrawOverlayContext,
  localRect: { x: number; y: number; width: number; height: number },
): void {
  const { ctx } = drawCtx;
  switch (overlay.kind) {
    case "text":
      // 2D text only — 3D text is rendered by the caller via the three instance.
      drawTextOverlay(ctx, { ...overlay, rect: localRect }, drawCtx);
      break;
    case "image": {
      if (overlay.unfilledSlot !== undefined) {
        drawUnfilledSlotPlaceholder(ctx, localRect, overlay.unfilledSlot);
        break;
      }
      if (overlay.missing) {
        drawMissingOverlayPlaceholder(ctx, localRect, overlay.displayName);
        break;
      }
      const img = drawCtx.imageElements?.[overlay.id];
      if (img) {
        const fitted = fitRect(
          img.naturalWidth,
          img.naturalHeight,
          localRect.width,
          localRect.height,
        );
        ctx.drawImage(
          img,
          localRect.x + fitted.x,
          localRect.y + fitted.y,
          fitted.w,
          fitted.h,
        );
      }
      break;
    }
    case "video": {
      if (overlay.unfilledSlot !== undefined) {
        drawUnfilledSlotPlaceholder(ctx, localRect, overlay.unfilledSlot);
        break;
      }
      if (overlay.missing) {
        drawMissingOverlayPlaceholder(ctx, localRect, overlay.displayName);
        break;
      }
      const src = drawCtx.videoFrameSources?.[overlay.id];
      // A source that gave up (lib/engine/media-load-failure.ts) says so on the
      // overlay's own rect instead of holding a frozen/black frame.
      if (src?.failure?.()) {
        drawUnplayableVideoPlaceholder(ctx, localRect, overlay.displayName ?? overlay.sourceName);
        break;
      }
      if (src) {
        const localT =
          drawCtx.time - overlay.startTime + (overlay.trim?.start ?? 0);
        src.seek(localT);
        // Hold-last-frame parity with the base video scene (renderer.ts): when
        // the source isn't decode-ready at localT (warm source not caught up, a
        // post-seek flush mid-refill), paint its cached last-good frame instead
        // of whatever stale/blank frame getFrame would otherwise return. Falls
        // through to the live frame whenever a fresh one IS ready.
        const liveReady = src.isReadyAt ? src.isReadyAt(localT) : true;
        const liveFrame = src.getFrame(localT);
        const heldFrame = !liveReady ? src.lastGoodFrame?.() ?? null : null;
        const frame = heldFrame ?? liveFrame;
        const srcEl = frame as HTMLVideoElement | HTMLCanvasElement;
        const sw =
          (srcEl as HTMLVideoElement).videoWidth ||
          srcEl.width ||
          localRect.width;
        const sh =
          (srcEl as HTMLVideoElement).videoHeight ||
          srcEl.height ||
          localRect.height;
        // Default to "cover" — a video added full-frame should fill the frame
        // like a base scene (cropping overflow), not letterbox. "contain"
        // preserves the whole source frame with bars.
        const fit = overlay.fit ?? "cover";
        if (fit === "cover") {
          const fitted = coverRect(sw, sh, localRect.width, localRect.height);
          // Clip overflow to the rect so a wider/taller cover doesn't bleed
          // outside the overlay bounds.
          ctx.save();
          ctx.beginPath();
          ctx.rect(localRect.x, localRect.y, localRect.width, localRect.height);
          ctx.clip();
          ctx.drawImage(
            frame as CanvasImageSource,
            localRect.x + fitted.x,
            localRect.y + fitted.y,
            fitted.w,
            fitted.h,
          );
          ctx.restore();
        } else {
          const fitted = fitRect(sw, sh, localRect.width, localRect.height);
          ctx.drawImage(
            frame as CanvasImageSource,
            localRect.x + fitted.x,
            localRect.y + fitted.y,
            fitted.w,
            fitted.h,
          );
        }
      }
      break;
    }
    case "code": {
      // The contain-fit that used to be applied here moved into the runtime,
      // where the body draws — so the bitmap already IS the fitted content.
      ctx.beginPath();
      ctx.rect(localRect.x, localRect.y, localRect.width, localRect.height);
      ctx.clip();
      drawBodyLayer(ctx, drawCtx, overlay, localRect);
      break;
    }
    default:
      break;
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Visible "this file is gone" placeholder for an image or video overlay
 * whose backing file was deleted (it still lives in a snapshot/version) —
 * parity with the base video scene's `missing` placeholder (renderer.ts,
 * `scene.type === "video" && scene.missing`: same "⚠ Media file missing"
 * wording, same dark-navy fill + red-400/gray-400 text). Replaces what was
 * previously silent nothing: a deleted overlay file rendered no pixels at
 * all, indistinguishable from a correctly-transparent cutout (image alpha
 * PNG or video with alpha) or an overlay that simply hasn't started yet.
 * Scoped to the overlay's own rect (not the whole frame) since an overlay,
 * unlike a scene, doesn't necessarily cover it. Shared by both kinds so the
 * "file is gone" affordance looks like one feature, not two.
 */
function drawMissingOverlayPlaceholder(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  label?: string,
): void {
  const { x, y, width: w, height: h } = rect;
  ctx.save();
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(x, y, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f87171"; // red-400
  ctx.font = `600 ${Math.max(10, Math.round(h * 0.14))}px sans-serif`;
  ctx.fillText("⚠ Media file missing", x + w / 2, y + h / 2 - (label ? h * 0.08 : 0));
  if (label) {
    ctx.fillStyle = "#9ca3af"; // gray-400
    ctx.font = `${Math.max(8, Math.round(h * 0.09))}px sans-serif`;
    ctx.fillText(label, x + w / 2, y + h / 2 + h * 0.08);
  }
  ctx.restore();
}

/**
 * A video overlay whose preview source gave up — the file answered 4xx, its
 * codec can't be decoded here, it won't demux, or the server stayed down past
 * the bounded retries (`VideoFrameSource.failure`). Before this the clip held a
 * black/frozen frame while the player showed "Buffering…" every few seconds,
 * forever (docs-local/qa/2026-09-25-video-download-and-playback-plan.md T3).
 *
 * Deliberately QUIET, unlike the red "file missing" treatment: the file is
 * there, only the preview can't show it (export reads it from disk). It paints
 * its own dark plate so it reads the same in the light and dark app themes, and
 * names the clip so the user knows which one.
 */
function drawUnplayableVideoPlaceholder(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  label?: string,
): void {
  const { x, y, width: w, height: h } = rect;
  const unit = Math.min(w, h);
  ctx.save();
  ctx.fillStyle = "rgba(24, 24, 27, 0.92)"; // zinc-900
  ctx.fillRect(x, y, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxTextW = Math.max(0, w * 0.9);
  ctx.fillStyle = "#e4e4e7"; // zinc-200
  ctx.font = `600 ${Math.max(10, Math.round(unit * 0.06))}px sans-serif`;
  ctx.fillText("This video can't be played", x + w / 2, y + h / 2 - (label ? unit * 0.045 : 0));
  if (label) {
    ctx.fillStyle = "#a1a1aa"; // zinc-400
    ctx.font = `${Math.max(8, Math.round(unit * 0.042))}px sans-serif`;
    ctx.fillText(fitLabel(ctx, label, maxTextW), x + w / 2, y + h / 2 + unit * 0.045);
  }
  ctx.restore();
}

/** `label`, cut with an ellipsis until it measures within `maxW`. */
function fitLabel(ctx: CanvasRenderingContext2D, label: string, maxW: number): string {
  if (ctx.measureText(label).width <= maxW) return label;
  let lo = 0;
  let hi = label.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(label.slice(0, mid) + "…").width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return label.slice(0, lo).trimEnd() + "…";
}

/**
 * An applied template's media slot that has not been filled yet (see
 * lib/templates/unfilled-slot.ts). Deliberately NOT the red "file missing"
 * treatment: nothing is broken, the layer is waiting for the media the user
 * was told to add. A neutral dashed box inside the overlay's rect, naming the
 * slot and what it needs.
 */
function drawUnfilledSlotPlaceholder(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  label: string,
): void {
  const { x, y, width: w, height: h } = rect;
  const unit = Math.min(w, h);
  ctx.save();
  ctx.fillStyle = "rgba(39, 39, 42, 0.85)"; // zinc-800
  ctx.fillRect(x, y, w, h);
  const inset = Math.max(2, Math.round(unit * 0.02));
  ctx.strokeStyle = "#a1a1aa"; // zinc-400
  ctx.lineWidth = Math.max(2, Math.round(unit * 0.008));
  const dash = Math.max(6, Math.round(unit * 0.03));
  ctx.setLineDash([dash, dash * 0.75]);
  ctx.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);
  ctx.setLineDash([]);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#e4e4e7"; // zinc-200
  ctx.font = `600 ${Math.max(10, Math.round(unit * 0.08))}px sans-serif`;
  ctx.fillText(label, x + w / 2, y + h / 2 - unit * 0.05);
  ctx.fillStyle = "#a1a1aa"; // zinc-400
  ctx.font = `${Math.max(8, Math.round(unit * 0.055))}px sans-serif`;
  ctx.fillText("add media", x + w / 2, y + h / 2 + unit * 0.06);
  ctx.restore();
}

/**
 * The measured point-text box for a text overlay: wrap by maxWidthPct (or
 * never), measure the widest line, place the box so its anchor sits at the
 * authored `position`. Falls back to the overlay's current rect-anchor for
 * not-yet-migrated overlays (no `position`). `measure` must already be set up
 * with the overlay's composed font.
 */
/**
 * The exact font string the renderer paints a text overlay with: the composed
 * font, with the loaded font-file family substituted in when the overlay
 * references one. UI measurement code MUST set `ctx.font` to this so a measured
 * box matches the rendered glyphs (see `drawTextOverlay` / the spatial-quad
 * measure path, which both compute the font the same way).
 */
export function textOverlayFontString(overlay: TextOverlay): string {
  const composed = composeFont(overlay);
  return overlay.fontFileId
    ? withFamily(composed, cssFamilyForFontFile(overlay.fontFileId))
    : composed;
}

export function effectiveTextRect(
  overlay: TextOverlay,
  measure: (s: string) => number,
  frameWidth: number,
): { x: number; y: number; width: number; height: number } {
  const anchor = overlay.anchor ?? "mid-center";
  const position = overlay.position ?? anchorPointOf(overlay.rect, anchor);
  const fontSizePx = overlay.fontSize ?? parseFontSizePx(composeFont(overlay)) ?? 48;
  const { rect } = layoutTextOverlay(
    {
      content: overlay.content,
      position,
      anchor,
      fontSizePx,
      lineHeight: overlay.lineHeight ?? 1.2,
      maxWidthPct: overlay.maxWidthPct,
      frameWidth,
      // Plate padding is handled separately by drawTextOverlay's background plate.
      padding: 0,
    },
    measure,
  );
  return rect;
}

// `captionPlateRect` lives with the other pure text geometry in
// lib/captions/layout.ts so the ffmpeg export can size the SAME plate without
// importing the renderer; re-exported here for existing callers.
export { captionPlateRect };

/**
 * The LEFT x to start drawing a line at when painting word-by-word with
 * `textAlign:"left"`, given the align ANCHOR x (`lineX`) and the line's measured
 * width. For center/right alignment the anchor is the center/right of the line,
 * so word-by-word painting must back off to the true left edge — otherwise the
 * words paint from the anchor and overflow to the right (the fade-words bug).
 * Shared by the karaoke + fade-words branches so they can't drift.
 */
export function alignedLineStartX(
  lineX: number,
  lineWidth: number,
  align: "left" | "center" | "right",
): number {
  if (align === "center") return lineX - lineWidth / 2;
  if (align === "right") return lineX - lineWidth;
  return lineX;
}

/**
 * Render a text overlay with structured caption styling + optional reveal.
 * Order: resolve font → wrap → background plate → shadow → per-line reveal
 * transform → strokeText (if any) then fillText → reset shadow. When no new
 * fields are present this collapses to the original single styled fillText
 * (font from composeFont, color + align honored).
 */
function drawTextOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: TextOverlay,
  drawCtx: DrawOverlayContext,
): void {
  ctx.font = textOverlayFontString(overlay);
  ctx.fillStyle = overlay.color;
  ctx.textAlign = overlay.align;
  ctx.textBaseline = "top";

  const { rect } = overlay;
  // Point-text wrap: wrap to `maxWidthPct` of the FRAME width (or never wrap),
  // NOT to the authored rect.width. Wrapping to rect.width was the
  // reflow-on-resize bug — dragging a resize handle reflowed the caption.
  const wrapWidth = overlay.maxWidthPct ? drawCtx.width * overlay.maxWidthPct : Infinity;

  const reveal = overlay.reveal && overlay.reveal.mode !== "none" ? overlay.reveal : null;
  const timing = reveal
    ? elementTiming(drawCtx.time, drawCtx.fps, overlay.startTime, overlay.duration)
    : null;
  const progress = timing ? timing.progress : 1;
  const elementTime = timing ? timing.time : 0;
  // Real per-word STT timings (element-local seconds) when the cue carries them
  // → voice-synced karaoke / word-current / fade-words. Absent ⇒ linear fallback.
  const capWords = overlay.caption?.words;
  const hasWordTimes = !!(capWords && capWords.length > 0);

  // `word-current` shows ONLY the active word, replaced as time advances; the
  // voice-synced `typewriter` shows the spoken-so-far substring (per-word letter
  // reveal). Both substitute the visible content BEFORE wrapping so the rest of
  // the styling pipeline (plate / shadow / stroke) sizes to what's shown, and so
  // the char-slice typewriter branch below is a no-op when word times drive it.
  const contentWords = overlay.content.split(/\s+/).filter(Boolean);
  const visibleContent =
    reveal?.mode === "word-current"
      ? hasWordTimes
        ? (currentWord(capWords!, elementTime) ?? "")
        : currentWordLabel(contentWords, progress)
      : reveal?.mode === "typewriter" && hasWordTimes
        ? typewriterRevealedText(capWords!, elementTime)
        : overlay.content;

  const lines = wrapText((s) => ctx.measureText(s).width, visibleContent, wrapWidth);

  const fontSizePx = overlay.fontSize ?? parseFontSizePx(ctx.font) ?? 48;
  const lineHeightPx = fontSizePx * (overlay.lineHeight ?? 1.2);

  // ── Default vertical centering ──
  // Center the wrapped text block within `rect` (textBaseline is "top", so each
  // line's Y is its top edge). `yOffset` shifts every line, the background plate,
  // and the pop-scale center together so the block sits in the rect's middle
  // instead of hugging the top. Clamped at 0 so overflowing text still starts at
  // the top rather than being pushed up out of frame.
  const totalTextHeight = lines.length * lineHeightPx;
  const yOffset = Math.max(0, (rect.height - totalTextHeight) / 2);

  // `karaoke` shows the full line and emphasizes the active word in highlightColor.
  const karaokeActiveIdx =
    reveal?.mode === "karaoke"
      ? hasWordTimes
        ? activeWordIndexByTime(capWords!, elementTime)
        : activeWordIndexByProgress(contentWords, progress)
      : -1;
  const karaokeHighlight = overlay.reveal?.highlightColor ?? "#ffd400";

  const lineX =
    overlay.align === "center"
      ? rect.x + rect.width / 2
      : overlay.align === "right"
        ? rect.x + rect.width
        : rect.x;

  // ── Background plate (hugs the measured glyph ink box + padding) ──
  if (overlay.background) {
    const pad = overlay.background.padding ?? 8;
    // Measure each line's actual ink bounds (relative to its textBaseline:"top"
    // line origin) so the plate hugs the visible glyphs — not the font's
    // reserved ascent/descent. Fall back to the fontSize approximation when the
    // engine doesn't expose actualBoundingBox metrics.
    let widest = 0;
    let inkTop = Infinity;
    let inkBottom = -Infinity;
    for (let i = 0; i < lines.length; i++) {
      const lineTop = rect.y + yOffset + i * lineHeightPx;
      const m = ctx.measureText(lines[i] || " ");
      widest = Math.max(widest, m.width);
      const asc = (m as TextMetrics).actualBoundingBoxAscent;
      const desc = (m as TextMetrics).actualBoundingBoxDescent;
      if (typeof asc === "number" && typeof desc === "number") {
        inkTop = Math.min(inkTop, lineTop - asc);
        inkBottom = Math.max(inkBottom, lineTop + desc);
      } else {
        inkTop = Math.min(inkTop, lineTop);
        inkBottom = Math.max(inkBottom, lineTop + fontSizePx);
      }
    }
    if (!Number.isFinite(inkTop)) {
      inkTop = rect.y + yOffset;
      inkBottom = rect.y + yOffset + Math.max(0, lines.length - 1) * lineHeightPx + fontSizePx;
    }
    const {
      x: plateX,
      y: plateY,
      width: plateW,
      height: plateH,
    } = captionPlateRect({
      rectX: rect.x,
      rectWidth: rect.width,
      inkTop,
      inkBottom,
      widest,
      pad,
      align: overlay.align,
    });
    const prevFill = ctx.fillStyle;
    ctx.fillStyle = overlay.background.color;
    const radius = overlay.background.radius ?? 0;
    if (radius > 0) {
      drawRoundRect(ctx, plateX, plateY, plateW, plateH, radius);
      ctx.fill();
    } else {
      ctx.fillRect(plateX, plateY, plateW, plateH);
    }
    ctx.fillStyle = prevFill;
  }

  // ── Shadow ──
  const hadShadow = !!overlay.shadow;
  if (overlay.shadow) {
    // Canvas shadows ignore the context transform (they are in output-bitmap
    // pixels), and this draw runs through the composition→backing scale — so
    // an unscaled shadow changed size with the preview's display size and came
    // out half-size in a 4K export. Scale it into composition space, like every
    // other caption field; the ffmpeg export scales it the same way.
    const k = contextScale(ctx);
    ctx.shadowColor = overlay.shadow.color;
    ctx.shadowBlur = overlay.shadow.blur * k;
    ctx.shadowOffsetX = (overlay.shadow.dx ?? 0) * k;
    ctx.shadowOffsetY = (overlay.shadow.dy ?? 0) * k;
  }

  // ── Stroke style ──
  if (overlay.stroke) {
    ctx.strokeStyle = overlay.stroke.color;
    ctx.lineWidth = overlay.stroke.width;
  }

  // ── Pop scales the whole block about the rect center ──
  const popScaled = reveal?.mode === "pop";
  if (popScaled) {
    const s = popScale(progress);
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + yOffset + (lines.length * lineHeightPx) / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);
  }

  const fullText = lines.join("");
  const fullCharCount = fullText.length;
  const wordAlphas =
    reveal?.mode === "fade-words"
      ? hasWordTimes
        ? fadeWordsAlphaByTime(capWords!, elementTime)
        : fadeWordsAlpha(countWords(overlay.content), progress, revealFraction(reveal, overlay.duration))
      : null;
  // Voice-synced typewriter: `visibleContent` is ALREADY the spoken-so-far
  // substring, so reveal all of it (the per-line slice below becomes a no-op).
  // Linear fallback (no word times): pace the caret off `progress`.
  const typedCount =
    reveal?.mode === "typewriter" && !hasWordTimes
      ? typewriterCharCount(fullCharCount, progress, revealFraction(reveal, overlay.duration))
      : fullCharCount;

  let charsSeen = 0;
  let wordsSeen = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (reveal?.mode === "typewriter") {
      const remaining = Math.max(0, typedCount - charsSeen);
      line = line.slice(0, remaining);
      charsSeen += lines[i].length;
      if (remaining <= 0) continue;
    }

    let y = rect.y + yOffset + i * lineHeightPx;
    if (reveal?.mode === "slide-up") {
      y += slideUpOffset(i, lines.length, progress, lineHeightPx);
    }

    if (reveal?.mode === "karaoke") {
      // Draw the full line once in the base color (stroke first if present),
      // then re-fill the active word in highlightColor at its measured x.
      if (overlay.stroke) ctx.strokeText(line, lineX, y);
      ctx.fillText(line, lineX, y);

      const words = line.split(/\s+/).filter(Boolean);
      const prevAlign: CanvasTextAlign = ctx.textAlign;
      const prevFill: string | CanvasGradient | CanvasPattern = ctx.fillStyle;
      ctx.textAlign = "left";
      // Re-measure word x positions from the same lineX baseline the full line
      // started at. lineX already accounts for align.
      let wx = alignedLineStartX(lineX, ctx.measureText(line).width, overlay.align);
      for (const word of words) {
        if (wordsSeen === karaokeActiveIdx) {
          ctx.fillStyle = karaokeHighlight;
          ctx.fillText(word, wx, y);
          ctx.fillStyle = prevFill;
        }
        wx += ctx.measureText(word + " ").width;
        wordsSeen++;
      }
      ctx.textAlign = prevAlign;
      continue;
    }

    if (reveal?.mode === "fade-words" && wordAlphas) {
      // Draw word-by-word so each word can fade independently.
      const words = line.split(/\s+/).filter(Boolean);
      const prevAlign: CanvasTextAlign = ctx.textAlign;
      ctx.textAlign = "left";
      // `lineX` is the align ANCHOR (center x for center-align, right x for
      // right-align). We draw left-aligned word-by-word, so start at the line's
      // true LEFT edge — otherwise center/right captions paint from the anchor
      // and overflow to the right (same correction the karaoke branch makes).
      let wx = alignedLineStartX(lineX, ctx.measureText(line).width, overlay.align);
      for (const word of words) {
        const a = wordAlphas[wordsSeen] ?? 1;
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = prevAlpha * a;
        if (overlay.stroke) ctx.strokeText(word, wx, y);
        ctx.fillText(word, wx, y);
        ctx.globalAlpha = prevAlpha;
        wx += ctx.measureText(word + " ").width;
        wordsSeen++;
      }
      ctx.textAlign = prevAlign;
      continue;
    }

    if (overlay.stroke) ctx.strokeText(line, lineX, y);
    ctx.fillText(line, lineX, y);
  }

  if (popScaled) ctx.restore();

  // ── Reset shadow so it never bleeds into later overlays ──
  if (hadShadow) {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
}

/** The uniform scale of the context's current transform (1 when the context
 *  can't report one — test doubles). */
function contextScale(ctx: CanvasRenderingContext2D): number {
  if (typeof ctx.getTransform !== "function") return 1;
  const m = ctx.getTransform();
  const k = Math.hypot(m.a, m.b);
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/** Best-effort px size from a CSS font shorthand (e.g. "700 64px Inter"). */
function parseFontSizePx(font: string): number | null {
  const m = font.match(/(\d+(?:\.\d+)?)px/);
  return m ? parseFloat(m[1]) : null;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Round-rect path. Prefers the native roundRect when available, else arcTo. */
function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  const rr = Math.min(r, w / 2, h / 2);
  const anyCtx = ctx as unknown as { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
  if (typeof anyCtx.roundRect === "function") {
    anyCtx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Exported (minimal) so the track-eval harness's --via-product-render mode can
// validate the genuine product track→rect math end-to-end. This is the EXACT
// fit/scale function the "tracked" overlay case above uses to turn a sampled
// track bbox into the on-screen rect — reusing it (rather than reimplementing)
// is the point: a fit-math regression must surface in the harness too.
// Hard sanity ceiling: a subject-pinned overlay must never exceed this
// fraction of a frame dimension. A noisy single-frame bbox (the "emoji
// briefly fills the screen" bug) is purely cosmetic damage the renderer
// can refuse — the track itself is fixed via the summary issues +
// repair loop, but this guarantees the user never SEES a frame-filling
// overlay even for one frame, on any track, ever.
const MAX_OVERLAY_FRAME_FRACTION = 0.66;

function clampToFrame(
  box: { x: number; y: number; w: number; h: number },
  frame?: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  if (!frame || frame.width <= 0 || frame.height <= 0) return box;
  const maxW = MAX_OVERLAY_FRAME_FRACTION * frame.width;
  const maxH = MAX_OVERLAY_FRAME_FRACTION * frame.height;
  if (box.w <= maxW && box.h <= maxH) return box;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // Uniform shrink (preserve aspect) so emoji/text stay proportioned.
  const k = Math.min(maxW / box.w, maxH / box.h, 1);
  const nw = box.w * k;
  const nh = box.h * k;
  return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
}

export function applyFitAndScale(
  sample: { x: number; y: number; w: number; h: number },
  rect: { x: number; y: number; width: number; height: number },
  fit: TrackFit,
  scale: number,
  frame?: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = sample;
  if (fit === "head") {
    // A "face"/object track emits a roughly-square bbox (the face). A
    // "person"/object track emits a TALL full-body bbox — the agent often
    // (correctly) prefers a person track for robustness when the subject
    // is back-facing. fit:"head" must put the overlay on the HEAD in both
    // cases. Previously it only "extended a face bbox up 50%", so on a
    // body bbox the emoji scaled to the whole body and filled the frame.
    // Person/body-like when clearly taller than wide OR a large box that
    // is at least as tall as wide (a big near-square box is a bad
    // full-body/crowd detection, NOT a face — treating it as a face and
    // extending it up 50% is exactly what ballooned the emoji at t≈5).
    const big = frame ? w * h >= 0.1 * frame.width * frame.height : false;
    const personLike = h > w * 1.3 || (big && h >= w);
    if (personLike) {
      // Isolate the head: a square at the top-center of the body bbox.
      // Head height ≈ 1/7 of standing height; 0.22 covers hair generously
      // so an emoji/sticker reads as "on the head".
      //
      // Raised-limb robustness: when the subject raises a hand/arm the
      // person box grows TALLER (the box top becomes the hand), so a
      // height-only `0.22*h` balloons the emoji for that ~1s. Box WIDTH
      // (shoulders/torso) barely changes under a vertical arm raise, so
      // cap the head size by a width-derived bound. For a normal standing
      // box (h≈3w) `0.22*h ≈ 0.66w` and the `0.9*w` cap is inert (no
      // behavior change); it only clamps pathologically tall boxes
      // (h ≳ 4w — an arm fully overhead). Position still anchors to the
      // box top — a bare body box can't reveal where the head is when a
      // limb is above it; the real fix for that is to track the HEAD
      // (sot + head anchor), which the using-object-tracking skill now
      // mandates for face overlays. This cap just bounds the damage.
      const headSide = Math.min(h * 0.22, w * 0.9);
      const cx = x + w / 2;
      x = cx - headSide / 2;
      // Top of a person bbox ≈ top of the head; nudge down slightly so
      // the overlay sits over the face, not floating above the hairline.
      y = y + headSide * 0.05;
      w = headSide;
      h = headSide;
    } else {
      // Face-sized bbox — extend upward by 50% to cover forehead / hair.
      const extra = h * 0.5;
      y -= extra;
      h += extra;
    }
  } else if (fit === "rect") {
    // Use overlay rect dimensions, centered on the bbox center.
    const cx = x + w / 2;
    const cy = y + h / 2;
    const nw = rect.width * scale;
    const nh = rect.height * scale;
    return clampToFrame({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh }, frame);
  }
  // "tight" (and "head" after extension) — scale relative to bbox.
  const cx = x + w / 2;
  const cy = y + h / 2;
  const nw = w * scale;
  const nh = h * scale;
  return clampToFrame({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh }, frame);
}

/**
 * Track-driven placement + the user's follow offset — THE single resolver for
 * where a tracked overlay's art lands. Every placement consumer (renderer,
 * hitTest, verify-render, re-anchor drag recovery) MUST route through this so
 * preview, export, and the agent's verify frames agree by construction.
 * Offset is normalized to the resolved art box (see TrackedOverlay.offset);
 * it is applied AFTER clampToFrame — the user may deliberately park the art
 * partially off-frame.
 */
export function resolveTrackedRect(
  sample: { x: number; y: number; w: number; h: number },
  overlay: Pick<TrackedOverlay, "rect" | "fit" | "scale"> & {
    offset?: { x: number; y: number };
  },
  frame?: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const box = applyFitAndScale(sample, overlay.rect, overlay.fit, overlay.scale, frame);
  const off = overlay.offset;
  if (!off || (off.x === 0 && off.y === 0)) return box;
  return { x: box.x + off.x * box.w, y: box.y + off.y * box.h, w: box.w, h: box.h };
}

function drawTrackedText(
  ctx: CanvasRenderingContext2D,
  content: { content: string; font: string; color: string; align: "left" | "center" | "right" },
  bbox: { x: number; y: number; w: number; h: number },
) {
  ctx.font = content.font;
  ctx.fillStyle = content.color;
  ctx.textAlign = content.align;
  ctx.textBaseline = "middle";
  const x =
    content.align === "center"
      ? bbox.x + bbox.w / 2
      : content.align === "right"
        ? bbox.x + bbox.w
        : bbox.x;
  ctx.fillText(content.content, x, bbox.y + bbox.h / 2);
}

function applyEffectAtRect(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement | OffscreenCanvas,
  bbox: { x: number; y: number; w: number; h: number },
  op: "blur" | "pixelate" | "mask",
  // Composition→backing scale. `source` is the main canvas whose backing store
  // may be larger than the logical composition (4K export / HiDPI preview).
  // drawImage's SOURCE-rect args read intrinsic (device) pixels — NOT affected
  // by the ctx transform — so they must be multiplied by this scale to sample
  // the same region the DEST args (in composition coords, placed by the base ctx
  // transform) draw to. 1 = legacy (backing == composition).
  renderScale = 1,
) {
  if (op === "mask") {
    ctx.fillStyle = "#000";
    ctx.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);
    return;
  }
  // Source rect in DEVICE pixels (backing store), not composition pixels.
  const sx = bbox.x * renderScale;
  const sy = bbox.y * renderScale;
  const sw = bbox.w * renderScale;
  const sh = bbox.h * renderScale;
  if (op === "pixelate") {
    const tmp =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(
            Math.max(1, Math.floor(bbox.w / 12)),
            Math.max(1, Math.floor(bbox.h / 12)),
          )
        : document.createElement("canvas");
    if (!(tmp instanceof OffscreenCanvas)) {
      tmp.width = Math.max(1, Math.floor(bbox.w / 12));
      tmp.height = Math.max(1, Math.floor(bbox.h / 12));
    }
    const tctx = (tmp as HTMLCanvasElement | OffscreenCanvas).getContext("2d")!;
    (tctx as CanvasRenderingContext2D).imageSmoothingEnabled = false;
    (tctx as CanvasRenderingContext2D).drawImage(
      source as CanvasImageSource,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      (tmp as HTMLCanvasElement).width,
      (tmp as HTMLCanvasElement).height,
    );
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      tmp as CanvasImageSource,
      0,
      0,
      (tmp as HTMLCanvasElement).width,
      (tmp as HTMLCanvasElement).height,
      bbox.x,
      bbox.y,
      bbox.w,
      bbox.h,
    );
    ctx.imageSmoothingEnabled = true;
    return;
  }
  // blur
  ctx.filter = "blur(12px)";
  ctx.drawImage(
    source as CanvasImageSource,
    sx,
    sy,
    sw,
    sh,
    bbox.x,
    bbox.y,
    bbox.w,
    bbox.h,
  );
  ctx.filter = "none";
}
