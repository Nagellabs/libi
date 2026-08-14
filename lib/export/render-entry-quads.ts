/** Spatial-2D-overlay quad building for the export (chromium-render) path.
 *
 * The export render entry (`lib/export/render-entry.ts`) must build an
 * `OverlayQuadInstance` for EVERY overlay the preview builds one for, or a
 * perspective-tilted 2D overlay exports BLANK. The preview hook
 * (`hooks/preview/use-overlay-quads.ts`) builds a quad for image / video / code /
 * (text without `threeD`) overlays whose resolved transform classifies as
 * `spatial` (out-of-plane rotation.x/y ≠ 0 or position.z ≠ 0). This module
 * mirrors that classification + build for the export pass, keyed by `overlay.id`
 * into the same `spatialQuads` map the unified renderer reads
 * (`lib/engine/overlay-renderer.ts` spatial branch).
 *
 * Same shape as `render-entry-three.ts`: the pure selector + the
 * dependency-injected builder live here (unit-testable without WebGL); the
 * browser-only `render-entry.ts` wires the real implementations.
 */
import type { Overlay, TextOverlay } from "@/lib/engine/types";
import type { OverlayQuadInstance } from "@/lib/engine/overlay-quad";
import type { SharedThreeRenderer } from "@/lib/engine/three-overlay";
import { classifyTransform, resolveOverlayTransform } from "@/lib/engine/overlay-transform";

/** True when an overlay needs a spatial textured-quad to render: an
 *  image / video / code / (text without `threeD`) overlay whose resolved
 *  Transform3D classifies as `spatial` (an out-of-plane tilt or z-depth that the
 *  flat Canvas2D affine path can't represent). `three` and `text+threeD`
 *  overlays own the three renderer and are excluded — they build a
 *  ThreeOverlayInstance instead (see `render-entry-three.ts`). MUST stay in
 *  lock-step with `use-overlay-quads.ts` and the renderer's spatial branch. */
export function overlayNeedsSpatialQuad(o: Overlay): boolean {
  const is2DKind =
    o.kind === "image" ||
    o.kind === "video" ||
    o.kind === "code" ||
    (o.kind === "text" && !(o as TextOverlay).threeD);
  if (!is2DKind) return false;
  return classifyTransform(resolveOverlayTransform(o)) === "spatial";
}

/** The spatial-2D overlays in a list, in input order. Pure — unit-testable. */
export function selectSpatialOverlays(overlays: Overlay[]): Overlay[] {
  return overlays.filter(overlayNeedsSpatialQuad);
}

/** Injected dependencies for the export quad builder. Production wires the real
 *  three-overlay + overlay-quad browser implementations; tests pass stubs. */
export interface BuildOverlaySpatialDeps {
  createSharedThreeRenderer: () => Promise<SharedThreeRenderer>;
  buildQuadInstance: (shared: SharedThreeRenderer) => Promise<OverlayQuadInstance>;
}

export interface BuildOverlaySpatialResult {
  quads: Record<string, OverlayQuadInstance>;
  dispose: () => void;
}

/** Build one `OverlayQuadInstance` per spatial-2D overlay, keyed by
 *  `overlay.id`. One shared WebGL renderer for the whole export (separate from
 *  the three-scene renderer — matches the preview, where `useOverlayQuads` owns
 *  its own `SharedThreeRenderer`). The quad is content-agnostic (re-textured per
 *  frame), so a single instance per overlay suffices. A per-instance build
 *  failure is logged + skipped (the renderer no-ops for that id) rather than
 *  failing the export — parity with the preview hook's per-instance catch. */
export async function buildOverlaySpatialQuadsWithDeps(
  overlays: Overlay[],
  deps: BuildOverlaySpatialDeps,
): Promise<BuildOverlaySpatialResult> {
  const needed = selectSpatialOverlays(overlays);
  if (needed.length === 0) return { quads: {}, dispose: () => {} };

  const shared = await deps.createSharedThreeRenderer();
  const quads: Record<string, OverlayQuadInstance> = {};

  for (const o of needed) {
    try {
      quads[o.id] = await deps.buildQuadInstance(shared);
    } catch (err) {
      console.warn("[Render] spatial overlay quad build failed; skipping", o.id, err);
    }
  }

  return {
    quads,
    dispose() {
      for (const inst of Object.values(quads)) inst.dispose();
      shared.dispose();
    },
  };
}
