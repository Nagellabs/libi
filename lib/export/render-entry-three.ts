/** 3D-TEXT instance building for the export (chromium-render) path.
 *
 * The export render entry (`lib/export/render-entry.ts`) must build a
 * ThreeOverlayInstance for every text overlay the preview builds one for, or 3D
 * text exports as flat 2D. `kind === "three"` overlays are NOT built here: a
 * `three` body is untrusted code and renders only inside the overlay sandbox
 * (`lib/sandbox/export-layers.ts`), exactly as in the preview
 * (`hooks/preview/use-overlay-three.ts`). 3D text is host code — libi's own
 * builder over the overlay's text — so it stays in the page (plan deviation 1).
 *
 * The pure classifier + the dependency-injected builder live here so they are
 * unit-testable without WebGL / opentype. The browser-only `render-entry.ts`
 * wires the real implementations.
 */
import type { Overlay } from "@/lib/engine/types";
import { textUsesThreeInstance, withSynthesizedThreeD } from "@/lib/overlays/three-d-mode";
import type {
  ThreeOverlayInstance,
  SharedThreeRenderer,
} from "@/lib/engine/three-renderer";
import type {
  BuildTextThreeDeps,
  buildTextThreeInstance as BuildTextThreeInstanceFn,
} from "@/lib/engine/text-3d/build-text-three";

/** True when this overlay needs a host-built ThreeOverlayInstance: a `text`
 *  overlay in 3D mode. Classification is the shared `textUsesThreeInstance`
 *  gate (place3d OR threeD), so export builds a 3D instance for EXACTLY the
 *  text the preview does. `three` BODIES render in the overlay sandbox; plain
 *  text and every other kind render via their own 2D path. */
export function overlayNeedsThreeInstance(o: Overlay): boolean {
  return o.kind === "text" && textUsesThreeInstance(o);
}

/** Injected dependencies for the export 3D builder. Production wires the real
 *  three-renderer + text-3d browser implementations; tests pass stubs. */
export interface BuildOverlayThreeDeps {
  createSharedThreeRenderer: () => Promise<SharedThreeRenderer>;
  buildTextThreeInstance: typeof BuildTextThreeInstanceFn;
  makeBrowserTextThreeDeps: (
    lookupFilename?: (fileId: string) => string | null,
  ) => BuildTextThreeDeps;
}

export interface BuildOverlayThreeResult {
  scenes: Record<string, ThreeOverlayInstance>;
  dispose: () => void;
}

/** Build one ThreeOverlayInstance per 3D-text overlay, keyed by `overlay.id`.
 *  Awaits each instance's text-rasterization readiness so the FIRST captured
 *  frame is deterministic (no blank text). One shared renderer for the whole
 *  export.
 *
 *  Mirrors the preview hook (`useOverlayThreeScenes`): `buildTextThreeInstance`
 *  with the browser font-loading deps (valid in the headless-Chromium render
 *  page). A per-instance build failure is logged and skipped (the renderer
 *  no-ops for that id) rather than failing the export — parity with the
 *  preview's per-instance catch. */
export async function buildOverlayThreeScenesWithDeps(
  overlays: Overlay[],
  deps: BuildOverlayThreeDeps,
): Promise<BuildOverlayThreeResult> {
  const needed = overlays.filter(overlayNeedsThreeInstance);
  if (needed.length === 0) return { scenes: {}, dispose: () => {} };

  const shared = await deps.createSharedThreeRenderer();
  const scenes: Record<string, ThreeOverlayInstance> = {};

  // Browser text-3D deps are built once and reused (matches the preview hook).
  // The render page runs in headless Chromium, so font fetches (/fonts/3d/<file>
  // for bundled, /api/files/by-id/<id>/content for uploaded) resolve there.
  let textDeps: BuildTextThreeDeps | null = null;

  for (const o of needed) {
    try {
      if (o.kind !== "text") continue;
      if (!textDeps) textDeps = deps.makeBrowserTextThreeDeps();
      // Synthesize a flat depth:0 threeD for place3d-only text so the builder
      // (which requires a threeD block) renders 3D — shared with the preview
      // hook via withSynthesizedThreeD so the two paths cannot drift.
      const inst = await deps.buildTextThreeInstance(withSynthesizedThreeD(o), textDeps, shared);
      await inst.ready; // canvas-text rasterization gate — deterministic export
      scenes[o.id] = inst;
    } catch (err) {
      console.warn("[Render] 3D text build failed; skipping", o.id, err);
    }
  }

  return {
    scenes,
    dispose() {
      for (const inst of Object.values(scenes)) inst.dispose();
      // Free the shared WebGL context promptly (forceContextLoss) rather than on GC.
      shared.dispose();
    },
  };
}
