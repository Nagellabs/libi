/** three.js renderer plumbing shared by every 3D path — the host's 3D text and
 *  perspective quads, the export page, and the sandboxed overlay runtime: the
 *  per-overlay renderer pool and the `ThreeOverlayInstance` contract.
 *
 *  Deliberately a LEAF with no body compiler behind it. `buildThreeInstance`
 *  (which compiles and runs a `three` overlay's body) lives in
 *  `three-overlay.ts` and is reached only from the sandbox worker; the export
 *  render page imports its renderer from HERE, so no code path in that page
 *  can compile a body (overlay-sandbox gate h3, held by construction and
 *  pinned by `__tests__/unit/bundles/browser-bundle.test.ts`). three is
 *  lazy-imported so a bundle pays for it only when a 3D layer is used. */

import type { ContentBoundsNDC } from "@/lib/engine/three-content-bounds";
import type { Transform3D } from "@/lib/engine/types";

export interface ThreeFrameApi {
  frame: number;
  time: number;
  totalFrames: number;
  duration: number;
  progress: number;
  /** The piece clock, as in a code body's context: this frame's absolute time on
   *  the timeline, where the overlay starts, how long the piece runs (seconds).
   *  Optional because the host-built 3D-TEXT path does not set them. */
  compositionTime?: number;
  overlayStart?: number;
  pieceDuration?: number;
  /** Gizmo-driven 3D transform applied to the scene root this frame. A template
   *  MAY read it (most won't — the renderer already applies it via
   *  applyTransform before render). Identity/absent ⇒ no transform. */
  readonly transform3d?: Transform3D;
  /** Voice-synced caption word timings (element-local seconds) when the overlay
   *  carries `caption.words`. The 3D-text reveal drives karaoke / word-current /
   *  typewriter off THESE (paired with `time`) instead of the linear `progress`;
   *  a custom three caption body reads them with the injected word helpers.
   *  Absent/empty ⇒ fall back to progress-based reveal. */
  readonly words?: import("@/lib/captions/types").CaptionCueWord[];
}

export interface SharedThreeRenderer {
  renderer: import("three").WebGLRenderer;
  dispose(): void;
}

export interface ThreeOverlayInstance {
  /** Per-frame closure captured from the body's return (undefined for a static scene). */
  update?: (api: ThreeFrameApi) => void;
  /** Apply the gizmo 3D transform to the scene ROOT (position/rotation).
   *  Identity (or absent) leaves the render byte-identical (no-op). Called by the
   *  overlay renderer immediately before render(). */
  applyTransform: (t: Transform3D) => void;
  /** Synchronous: size the shared renderer and render, returning the GL canvas.
   *  The `three` overlay renders the scene into the base rect (window model) and
   *  ignores the trailing super-frame args. The 3D-TEXT instance
   *  (lib/engine/text-3d/build-text-three.ts) still uses the optional
   *  expanded/offset args to render into a content-bounds super-frame via
   *  camera.setViewOffset — both impls share this interface. */
  render: (
    baseW: number,
    baseH: number,
    expandedW?: number,
    expandedH?: number,
    offsetX?: number,
    offsetY?: number,
  ) => HTMLCanvasElement | OffscreenCanvas;
  /** Free geometries/materials/textures + canvas-text instances. */
  dispose: () => void;
  /** Shrink the renderer's GL drawing buffer to 1×1; the next `render()` sizes
   *  it back. The sandbox runtime's idle eviction (spec §4.9) — a three layer
   *  has no 2D canvas of its own to shrink. */
  releaseDrawingBuffer?: () => void;
  /** Project the scene's content AABB to normalized viewport bounds — used ONLY by
   *  the 3D-TEXT path (content-bounds super-frame). The `three` overlay (window
   *  model) does NOT implement this; callers use optional chaining. */
  contentBoundsNDC?: () => ContentBoundsNDC | null;
  /** Resolves when initial text rasterization completes (export gate). Canvas2D
   *  text is synchronous, so this settles on the next microtask. */
  ready: Promise<void>;
}

/** Create ONE renderer. `preserveDrawingBuffer` is REQUIRED so the 2D ctx can
 *  drawImage the WebGL canvas after render() in the same tick.
 *
 *  NOTE (perf, measured 2026-06-27): a renderer must be sized by AT MOST ONE
 *  overlay. Sharing a renderer across multiple active 3D overlays of different
 *  expanded sizes makes `render()` call `setSize()` (a native GL drawing-buffer
 *  realloc — `canvas.width = …` reallocs even for the same value) once PER
 *  overlay PER frame, which churns GPU memory and triggers a recurring major GC
 *  (~38ms, ~0.7×/s) → dropped frames + visible stutter. The fix is a per-overlay
 *  renderer (see `OverlayRendererPool`) so each renderer only ever sees one
 *  overlay's (mostly stable) size. See
 *  docs-local/superpowers/notes/smoothness-fixture.md. */
export async function createSharedThreeRenderer(canvas?: OffscreenCanvas): Promise<SharedThreeRenderer> {
  const THREE = await import("three");
  const renderer = new THREE.WebGLRenderer({
    // A worker has no document, so three cannot createElement its own canvas
    // there: the sandbox runtime passes an OffscreenCanvas (spec A1 §2). The
    // host passes nothing and three behaves exactly as before.
    ...(canvas ? { canvas } : {}),
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  return {
    renderer,
    dispose() {
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

/** Max DEDICATED per-overlay renderers (WebGL contexts) a single pool hands out.
 *  Browsers cap total live contexts at ~16; with two pools (3D scenes + quads)
 *  this keeps the combined ceiling safe. Overlays beyond the cap share ONE
 *  fallback renderer (degrades to the old per-frame-realloc behaviour for the
 *  overflow only — a logged, bounded degradation). */
export const MAX_OVERLAY_RENDERERS = 6;

/** Hands out a dedicated `SharedThreeRenderer` per overlay id (up to
 *  `maxDedicated`), so an overlay's per-frame `render()` only ever resizes its
 *  OWN GL drawing buffer — never another overlay's. Overflow overlays share a
 *  single lazily-created fallback renderer. One pool per hook; dispose on unmount. */
export interface OverlayRendererPool {
  /** Renderer for this overlay id (created on first request; cached by id). */
  acquire(id: string): Promise<SharedThreeRenderer>;
  /** Dispose + drop the dedicated renderer for this id (no-op for the fallback). */
  release(id: string): void;
  /** Dispose every dedicated renderer + the fallback. */
  disposeAll(): void;
}

export function createOverlayRendererPool(
  maxDedicated: number = MAX_OVERLAY_RENDERERS,
  create: () => Promise<SharedThreeRenderer> = createSharedThreeRenderer,
): OverlayRendererPool {
  const dedicated = new Map<string, SharedThreeRenderer>();
  let fallback: SharedThreeRenderer | null = null;
  let warnedOverflow = false;
  return {
    async acquire(id: string): Promise<SharedThreeRenderer> {
      const existing = dedicated.get(id);
      if (existing) return existing;
      if (dedicated.size < maxDedicated) {
        const r = await create();
        // Re-check: another concurrent acquire for the same id may have won.
        const raced = dedicated.get(id);
        if (raced) { r.dispose(); return raced; }
        dedicated.set(id, r);
        return r;
      }
      if (!fallback) fallback = await create();
      if (!warnedOverflow) {
        warnedOverflow = true;
        console.warn(
          `[overlay-3d] >${maxDedicated} concurrent 3D overlays — extras share one renderer (may stutter). Reduce active 3D overlays for smooth playback.`,
        );
      }
      return fallback;
    },
    release(id: string) {
      const r = dedicated.get(id);
      if (r) { r.dispose(); dedicated.delete(id); }
    },
    disposeAll() {
      for (const r of dedicated.values()) r.dispose();
      dedicated.clear();
      fallback?.dispose();
      fallback = null;
    },
  };
}
