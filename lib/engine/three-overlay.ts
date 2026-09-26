/** three.js overlay runtime: a per-overlay instance that COMPILES a `three`
 *  body, builds its scene ONCE and exposes a synchronous render() that the 2D
 *  compositor drawImage's onto the frame. Only the sandboxed overlay runtime
 *  (`lib/sandbox/runtime/three.ts`) calls it. The renderer pool and instance
 *  contract live in the compiler-free leaf `three-renderer.ts` (re-exported
 *  here) — import THAT from any page that must not be able to compile a body.
 *  three is lazy-imported so the base bundle is unaffected until a 3D overlay
 *  is used. Text is rendered via the dependency-free Canvas2D-texture
 *  replacement in lib/engine/canvas-text.ts (NOT troika-three-text). */

import { makeCanvasTextClass } from "@/lib/engine/canvas-text";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import { applyCameraPreset, THREE3D_HELPERS, type CameraPreset } from "@/lib/engine/three-helpers";
import {
  compileThreeBody,
  defaultWrapperLineOffset,
  mapBodyError,
} from "@/lib/sandbox/runtime/compile";
import type { SharedThreeRenderer, ThreeFrameApi, ThreeOverlayInstance } from "@/lib/engine/three-renderer";

export {
  createOverlayRendererPool,
  createSharedThreeRenderer,
  MAX_OVERLAY_RENDERERS,
  type OverlayRendererPool,
  type SharedThreeRenderer,
  type ThreeFrameApi,
  type ThreeOverlayInstance,
} from "@/lib/engine/three-renderer";

/** Build one overlay instance. Compiles the body via the same injected-param
 *  signature validateThreeFunction checks, invokes it ONCE to populate the
 *  scene + capture the update closure, then exposes a sync render(). */
export async function buildThreeInstance(
  body: string,
  cameraPreset: CameraPreset | undefined,
  shared: SharedThreeRenderer,
  /** The layer's logical size, passed to the body as `width`/`height`. The
   *  historical value was 0/0 ("bodies that need it read camera.aspect"); the
   *  sandboxed runtime passes the real rect (spec §4.3). Callers that have no
   *  size yet keep the historical behaviour. */
  size: { width: number; height: number } = { width: 0, height: 0 },
  /** Lines `new Function` prepends to the body, so a `build` throw reports the
   *  body's own line. Measured once per runtime, not assumed. */
  wrapperLineOffset: number = defaultWrapperLineOffset(),
  /** Called the moment before the body's factory runs. The sandbox runtime
   *  announces the body's owner here (async-owner.ts): a build runs inside a
   *  `load`, which the host does not bracket the way it brackets a render. */
  beforeBody?: () => void,
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

  // Validated at COMPILE, not only on the MCP write paths: `compileThreeBody`
  // runs `validateThreeFunction` before `new Function`, so a body that reached
  // a piece without the write-time gate (a preset merge, an applied template, a
  // hand-edited or restored manifest) is refused here as a BodyError("compile")
  // and never runs. An EMPTY body compiles to a no-op and keeps rendering an
  // empty scene, as it always has. This runs only inside the sandboxed runtime.
  const factory = compileThreeBody(body, wrapperLineOffset) as (
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
  let update: ((api: ThreeFrameApi) => void) | undefined;
  beforeBody?.();
  try {
    update = factory(
      THREE,
      scene,
      camera,
      shared.renderer,
      size.width,
      size.height,
      TrackedText,
      DRAW_HELPERS,
      THREE3D_HELPERS,
    );
  } catch (err) {
    throw mapBodyError(err, "build", wrapperLineOffset);
  }

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
  // What the drawing buffer measured right after this instance last sized it.
  // A renderer SHARED past the pool's cap, or one shrunk by idle eviction, can
  // be resized behind this instance's back; comparing the live buffer catches
  // that without a realloc when nothing changed (reading `width` is free).
  let _bufW = -1;
  let _bufH = -1;

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
      const buf = shared.renderer.domElement as { width?: number; height?: number } | undefined;
      if (baseW !== _lastW || baseH !== _lastH || (buf?.width ?? -1) !== _bufW || (buf?.height ?? -1) !== _bufH) {
        shared.renderer.setSize(baseW, baseH, false);
        _lastW = baseW;
        _lastH = baseH;
        _bufW = buf?.width ?? -1;
        _bufH = buf?.height ?? -1;
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
    releaseDrawingBuffer() {
      shared.renderer.setSize(1, 1, false);
      _lastW = -1;
      _lastH = -1;
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
