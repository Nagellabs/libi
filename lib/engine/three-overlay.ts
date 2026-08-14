/** three.js overlay runtime: ONE shared WebGLRenderer for all 3D overlays,
 *  plus a per-overlay instance that builds its scene ONCE and exposes a
 *  synchronous render() that the 2D compositor drawImage's onto the frame.
 *  three is lazy-imported so the base bundle is unaffected until a
 *  3D overlay is used. Text is rendered via the dependency-free Canvas2D-texture
 *  replacement in lib/engine/canvas-text.ts (NOT troika-three-text). */

import { THREE_PARAM_NAMES } from "@/lib/ai/scene-validator";
import { makeCanvasTextClass } from "@/lib/engine/canvas-text";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import type { ContentBoundsNDC } from "@/lib/engine/three-content-bounds";
import { applyCameraPreset, THREE3D_HELPERS, type CameraPreset } from "@/lib/engine/three-helpers";
import type { Transform3D } from "@/lib/engine/types";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";

export interface ThreeFrameApi {
  frame: number;
  time: number;
  totalFrames: number;
  duration: number;
  progress: number;
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
export async function createSharedThreeRenderer(): Promise<SharedThreeRenderer> {
  const THREE = await import("three");
  const renderer = new THREE.WebGLRenderer({
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
): OverlayRendererPool {
  const dedicated = new Map<string, SharedThreeRenderer>();
  let fallback: SharedThreeRenderer | null = null;
  let warnedOverflow = false;
  return {
    async acquire(id: string): Promise<SharedThreeRenderer> {
      const existing = dedicated.get(id);
      if (existing) return existing;
      if (dedicated.size < maxDedicated) {
        const r = await createSharedThreeRenderer();
        // Re-check: another concurrent acquire for the same id may have won.
        const raced = dedicated.get(id);
        if (raced) { r.dispose(); return raced; }
        dedicated.set(id, r);
        return r;
      }
      if (!fallback) fallback = await createSharedThreeRenderer();
      if (!warnedOverflow) {
        warnedOverflow = true;
        // eslint-disable-next-line no-console
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

/** Build one overlay instance. Compiles the body via the same injected-param
 *  signature validateThreeFunction checks, invokes it ONCE to populate the
 *  scene + capture the update closure, then exposes a sync render(). */
export async function buildThreeInstance(
  body: string,
  cameraPreset: CameraPreset | undefined,
  shared: SharedThreeRenderer,
): Promise<ThreeOverlayInstance> {
  const THREE = await import("three");

  const scene = new THREE.Scene();
  const camera = applyCameraPreset(THREE, cameraPreset ?? "billboard");

  // Canvas2D-texture text (synchronous; replaces troika-three-text). Track every
  // Text the body creates so we can rasterize/size it + dispose.
  // NOTE: only Texts constructed during the synchronous factory() call below are
  // tracked — a body that lazily `new Text()`s inside its update closure will not
  // be gated/disposed here (templates build all text up front, as documented).
  const CanvasText = makeCanvasTextClass(THREE);
  const texts: Array<InstanceType<typeof CanvasText>> = [];
  class TrackedText extends CanvasText {
    constructor() {
      super();
      texts.push(this as InstanceType<typeof CanvasText>);
    }
  }

  // eslint-disable-next-line no-new-func
  const factory = new Function(...[...THREE_PARAM_NAMES], body) as (
    ...args: unknown[]
  ) => ((api: ThreeFrameApi) => void) | undefined;

  // Snapshot the preset camera BEFORE the body runs so we can detect whether the
  // body authored its own camera (e.g. roadCaption dollies down a road). A body
  // that takes camera control opts OUT of the never-cut content-fit below — its
  // framing is intentional (looming fly-throughs etc.). Bodies that leave the
  // preset camera alone get auto-framed so their content is never cut.
  const camPosBefore = camera.position.clone();
  const camQuatBefore = camera.quaternion.clone();

  // Order MUST match THREE_PARAM_NAMES: THREE, scene, camera, renderer, width, height, Text, helpers, three3d.
  const update = factory(
    THREE,
    scene,
    camera,
    shared.renderer,
    0, // width — overlays size at render time; bodies that need it read camera.aspect
    0, // height
    TrackedText,
    DRAW_HELPERS,
    THREE3D_HELPERS,
  );

  const bodyAuthoredCamera =
    !camera.position.equals(camPosBefore) || !camera.quaternion.equals(camQuatBefore);

  // ── Content-fit camera (fill the rect, never cut, Depth still works) ──────
  // The viewport is the overlay rect; content WIDER/TALLER than what the camera
  // sees at the content plane spills outside the rect and is clipped ("cut by the
  // wrapping box"). We frame the content's NATURAL axis-aligned bounding box so it
  // fills the rect snugly (like a 2D overlay sits close to its box edges) at any
  // rect aspect: the binding dimension (width OR height) touches the margin.
  //
  // TWO subtleties this handles:
  //  • Depth (transform3d.position.z) must still do something. We frame the camera
  //    around the content's ROTATED-about-origin center but DO NOT follow its
  //    z-translation — so pushing Depth moves the content toward/away from a fixed
  //    camera (bigger/smaller), instead of the camera chasing it (which made Depth
  //    a no-op).
  //  • Gizmo pitch/yaw (Elevation/Angle) only FORESHORTEN the content (it gets
  //    smaller on screen), so a box that fits the un-rotated content also contains
  //    every pitched/yawed pose — no cut. In-plane roll is the 2D rotation control
  //    (applied after this render), so it never affects the 3D framing.
  const FIT_MARGIN = 1.06; // ~6% breathing room so glyphs sit near, not on, the edge.
  const fitDir = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(camera.quaternion)
    .normalize();
  // Content bounds measured in the scene's LOCAL space (gizmo transform excluded),
  // computed once it has non-zero extent and then cached — the body builds content
  // up front, so the box is stable across frames.
  let contentBox: { center: import("three").Vector3; halfW: number; halfH: number } | null = null;
  /** Measure the content's AABB at its NATURAL state (scale 1, base position) —
   *  call ONCE after text rasterization and BEFORE any update() runs, so per-frame
   *  body animation (billboard's scale pop-in / drift) plays WITHIN the framing
   *  instead of fighting it. Neutralizes the scene's own transform so the
   *  measurement is gizmo-independent. Idempotent (only sets once). */
  function measureContentBox() {
    if (contentBox) return;
    const pos = scene.position.clone();
    const quat = scene.quaternion.clone();
    const scl = scene.scale.clone();
    scene.position.set(0, 0, 0);
    scene.quaternion.identity();
    scene.scale.set(1, 1, 1);
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    scene.position.copy(pos);
    scene.quaternion.copy(quat);
    scene.scale.copy(scl);
    scene.updateMatrixWorld(true);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const halfW = size.x / 2;
    const halfH = size.y / 2;
    if (halfW > 0 || halfH > 0) contentBox = { center, halfW, halfH };
  }
  /** Reposition the camera along its preset direction so the content's AABB fills
   *  the current aspect (binding dimension touches the margin). Framed about the
   *  content's rotated-origin center, NOT its depth translation, so Depth keeps
   *  working. No-op until the box has extent. */
  function fitCameraToContent(aspect: number) {
    if (!contentBox || aspect <= 0) return;
    const tanV = Math.tan(((camera.fov * Math.PI) / 180) / 2);
    if (tanV <= 0) return;
    const distH = contentBox.halfH / tanV; // distance to fit content height
    const distW = contentBox.halfW / (tanV * aspect); // distance to fit content width
    const dist = Math.max(distH, distW) * FIT_MARGIN;
    // Target = content center rotated about the ORIGIN by the gizmo rotation only
    // (NOT translated by scene.position) so Depth (position.z) is NOT cancelled.
    const target = contentBox.center.clone().applyQuaternion(scene.quaternion);
    camera.position.copy(target).addScaledVector(fitDir, -dist);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }

  // Rasterize every Text to its texture + size its plane. CanvasText.sync(cb)
  // draws synchronously and fires cb immediately, so `ready` settles at once —
  // but we keep the gate so the export path's `await inst.ready` stays correct.
  const ready = Promise.all(
    texts.map((t) => new Promise<void>((res) => t.sync(() => res()))),
  ).then(() => undefined);
  // Fire-and-forget guard: ready can never reject in practice (sync has no
  // error path), but it's awaited by the export gate — shield against an
  // UnhandledPromiseRejection the way MediaBunnyFrameSource does for its init.
  void ready.catch(() => {});

  // Measure the content box NOW — texts are rasterized/sized (sync fired
  // synchronously above) and no update() has run yet, so this captures the
  // natural (un-animated) extent. Re-measured at render only if it was empty
  // here (e.g. a body that builds content lazily).
  if (!bodyAuthoredCamera) measureContentBox();

  // Last GL drawing-buffer size this instance requested. setSize() reallocs the
  // native buffer (canvas.width assignment reallocs even for the same value), so
  // only call it when the dims ACTUALLY change — with a per-overlay renderer this
  // makes a static overlay size its buffer once and never realloc again.
  let _lastW = -1;
  let _lastH = -1;

  return {
    update: typeof update === "function" ? update : undefined,
    // MECHANISM CHOICE: apply the gizmo transform to the SCENE ROOT (the
    // THREE.Scene, which is itself an Object3D with position/rotation/scale) —
    // NOT a new wrapper Group. Rationale (lowest risk):
    //   • No re-parenting of body-created objects → can't disturb lights/meshes
    //     or break a body that holds direct references to scene children.
    //   • The camera is passed SEPARATELY to renderer.render(scene, camera) and
    //     is never a scene child here, so transforming the scene leaves the
    //     camera (and its preset) untouched.
    //   • Lights ARE scene children and rotate WITH the content — the desired
    //     gizmo behaviour (the whole object + its lighting rig move together).
    //   • Identity transform sets position(0,0,0)/rotation(0,0,0)/scale(1,1,1),
    //     i.e. the Scene's defaults, so the render is byte-identical to before
    //     this hook existed.
    applyTransform(t) {
      scene.position.set(t.position.x, t.position.y, t.position.z);
      // rotation is Euler XYZ in RADIANS (per Transform3D contract).
      scene.rotation.set(t.rotation.x, t.rotation.y, t.rotation.z);
      // Reset the scene-root scale defensively (identity). Sizing is the rect
      // window, applied by the compositor's drawImage — three has no scale field.
      scene.scale.setScalar(1);
    },
    render(baseW, baseH) {
      if (baseW !== _lastW || baseH !== _lastH) {
        shared.renderer.setSize(baseW, baseH, false);
        _lastW = baseW;
        _lastH = baseH;
      }
      if (baseW > 0 && baseH > 0) {
        camera.aspect = baseW / baseH;
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
      }
      // Force the scene's world matrix to recompute from the (just-set) gizmo
      // transform every frame. WebGLRenderer's implicit auto-update can leave a
      // STALE scene.matrixWorld when one renderer is reused across overlays —
      // which made applyTransform's scene.rotation/position silently not render.
      // Forcing it here is the minimal fix (transform stays on the Scene root).
      scene.updateMatrixWorld(true);
      // Frame the content to the rect so it's never cut (and so an in-plane Spin
      // is visible at identity). Runs after the world matrix is current so the
      // content center is placed for THIS frame's gizmo transform. Skipped when
      // the body authored its own camera (intentional framing — see above).
      if (!bodyAuthoredCamera && baseW > 0 && baseH > 0) {
        if (!contentBox) measureContentBox(); // fallback: lazy-built content
        fitCameraToContent(baseW / baseH);
      }
      shared.renderer.render(scene, camera);
      return shared.renderer.domElement;
    },
    dispose() {
      for (const t of texts) t.dispose();
      scene.traverse((obj) => {
        const mesh = obj as unknown as {
          geometry?: { dispose?: () => void };
          material?: { dispose?: () => void } | Array<{ dispose?: () => void }>;
        };
        mesh.geometry?.dispose?.();
        if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose?.());
        else mesh.material?.dispose?.();
      });
    },
    ready,
  };
}
