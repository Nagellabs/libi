import type { Transform3D } from "@/lib/engine/types";
import type { SharedThreeRenderer } from "@/lib/engine/three-overlay";
import { CAM_FOV, CAM_DIST, planeHeightWorld } from "@/lib/engine/overlay-quad-projection";

export interface OverlayQuadInstance {
  /** Re-texture with the freshly-drawn content canvas, orient the plane by `t`,
   *  render into an `expandedW × expandedH` buffer (with the base rect framing
   *  offset by `offsetX/Y` pixels via camera view-offset), and return the shared
   *  GL canvas (drawImage'd at the EXPANDED rect by caller).
   *
   *  When `expandedW === baseW && expandedH === baseH` (no overflow), the camera
   *  view-offset is cleared and this is equivalent to the old 5-arg call. */
  render(
    content: HTMLCanvasElement | OffscreenCanvas,
    t: Transform3D,
    flip: { flipH: boolean; flipV: boolean },
    baseW: number,
    baseH: number,
    expandedW: number,
    expandedH: number,
    offsetX: number,
    offsetY: number,
  ): HTMLCanvasElement | OffscreenCanvas;
  dispose(): void;
  // test hooks (no-op in prod usage)
  __meshRotation?(): { x: number; y: number; z: number };
  __textureNeedsUpdate?(): boolean;
}

/** Build a reusable textured-quad instance against the shared renderer. The
 *  plane is sized so that an identity-scale transform roughly fills the rect
 *  (visual continuity with the planar path as a control crosses 0). Camera /
 *  plane constants come from `overlay-quad-projection.ts` so the editor's
 *  hit-test + gizmo project against the EXACT geometry rendered here. */
export async function buildQuadInstance(shared: SharedThreeRenderer): Promise<OverlayQuadInstance> {
  const THREE = await import("three");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.01, 100);
  camera.position.set(0, 0, CAM_DIST);
  camera.lookAt(0, 0, 0);
  const planeH = planeHeightWorld();
  const geom = new THREE.PlaneGeometry(planeH, planeH);
  // The initial source is overwritten on every render(); pass a stub-safe sentinel.
  const initCanvas = typeof document !== "undefined" ? document.createElement("canvas") : ({} as HTMLCanvasElement);
  const tex = new THREE.CanvasTexture(initCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  scene.add(mesh);

  return {
    render(content, t, flip, baseW, baseH, expandedW, expandedH, offsetX, offsetY) {
      (tex as unknown as { image: unknown }).image = content;
      tex.needsUpdate = true;
      const aspect = baseW > 0 && baseH > 0 ? baseW / baseH : 1; // framing keyed to BASE
      mesh.scale.set((flip.flipH ? -1 : 1) * aspect, (flip.flipV ? -1 : 1), 1);
      mesh.rotation.set(t.rotation.x, t.rotation.y, t.rotation.z);
      // `position` is in overlay/composition PIXELS (same units the planar path
      // uses). The plane fills the rect, so `baseH` pixels span `planeH` world
      // units — convert isotropically. (The old `/planeH` mapping treated a 1px
      // offset as ~half the frame, which decentered every tilted overlay.)
      const k = baseH > 0 ? planeH / baseH : 0;
      mesh.position.set(t.position.x * k, -t.position.y * k, t.position.z * (k * 0.5));
      shared.renderer.setSize(expandedW, expandedH, false);
      camera.aspect = aspect;
      if (expandedW !== baseW || expandedH !== baseH) {
        camera.setViewOffset(baseW, baseH, -offsetX, -offsetY, expandedW, expandedH);
      } else {
        camera.clearViewOffset();
      }
      camera.updateProjectionMatrix();
      shared.renderer.render(scene, camera);
      return shared.renderer.domElement;
    },
    dispose() {
      geom.dispose(); mat.dispose(); tex.dispose();
    },
    __meshRotation: () => ({ x: mesh.rotation.x, y: mesh.rotation.y, z: mesh.rotation.z }),
    __textureNeedsUpdate: () => tex.needsUpdate,
  };
}
