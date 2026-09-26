/** three.js inside the worker: the SAME per-overlay renderer pool and cap as
 *  the host used (spec §4.4), each renderer bound to an OffscreenCanvas so its
 *  drawing buffer can be transferred as the layer bitmap. A worker has no
 *  document, so a canvas MUST be passed — three would otherwise createElement. */
import type { CameraPreset } from "@/lib/engine/three-helpers";
import {
  buildThreeInstance,
  createOverlayRendererPool,
  createSharedThreeRenderer,
  MAX_OVERLAY_RENDERERS,
  type SharedThreeRenderer,
  type ThreeOverlayInstance,
} from "@/lib/engine/three-overlay";

export interface ThreeRuntimeDeps {
  acquire(id: string): Promise<SharedThreeRenderer>;
  release(id: string): void;
  build(
    body: string,
    cameraPreset: CameraPreset | undefined,
    shared: SharedThreeRenderer,
    size: { width: number; height: number },
    wrapperLineOffset: number,
    /** Runs the moment before the body's factory (`buildThreeInstance`). */
    beforeBody?: () => void,
  ): Promise<ThreeOverlayInstance>;
}

export function makeThreeRuntimeDeps(): ThreeRuntimeDeps {
  const pool = createOverlayRendererPool(MAX_OVERLAY_RENDERERS, () =>
    createSharedThreeRenderer(new OffscreenCanvas(1, 1)),
  );
  return {
    acquire: (id) => pool.acquire(id),
    release: (id) => pool.release(id),
    build: (body, cameraPreset, shared, size, wrapperLineOffset, beforeBody) =>
      buildThreeInstance(body, cameraPreset, shared, size, wrapperLineOffset, beforeBody),
  };
}
