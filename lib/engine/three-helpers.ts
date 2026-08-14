/** 3D convenience helpers injected into three-overlay scene bodies as `three3d`,
 *  plus the camera-preset applier used by the instance builder. `THREE` is
 *  passed in (never imported here) so this module is GL-free and unit-testable. */

type AnyTHREE = typeof import("three");

export type CameraPreset = "billboard" | "ground" | "lowAngle" | "highAngle" | "angled";

/** Build a perspective camera positioned for the given preset. The instance
 *  builder updates `.aspect` per render from the overlay rect. */
export function applyCameraPreset(THREE: AnyTHREE, preset: CameraPreset): import("three").PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
  switch (preset) {
    case "ground":
      // Tilted down a receding plane — the road/floor look.
      cam.position.set(0, 1.1, 3.5);
      cam.lookAt(0, 0, -6);
      break;
    case "lowAngle":
      // Below the subject looking up — heroic/dramatic rising text.
      cam.position.set(0, -1.2, 4.5);
      cam.lookAt(0, 0.9, -1);
      break;
    case "highAngle":
      // Above the subject looking down — overhead/map look.
      cam.position.set(0, 3.4, 4.2);
      cam.lookAt(0, -0.4, -2.5);
      break;
    case "angled":
      // Static 3/4 view — reveals an object's 3D depth (vs flat fronto-parallel).
      cam.position.set(3.4, 1.6, 4.4);
      cam.lookAt(0, 0, 0);
      break;
    case "billboard":
    default:
      // Fronto-parallel — text/objects facing the viewer.
      cam.position.set(0, 0, 6);
      cam.lookAt(0, 0, 0);
      break;
  }
  cam.updateProjectionMatrix();
  return cam;
}

export const THREE3D_HELPERS = {
  /** A horizontal plane receding into the distance (the road/floor look). */
  groundPlane(THREE: AnyTHREE, opts: { size?: number; color?: number } = {}) {
    const { size = 24, color = 0x0a0a0a } = opts;
    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  },
  /** Apply a glowing outline to a Text instance (canvas-text). Mutates + returns it. */
  glowText(text: Record<string, unknown>, opts: { color?: string | number; intensity?: number } = {}) {
    const { color = 0xffffff, intensity = 1 } = opts;
    text.color = color;
    text.outlineColor = color;
    text.outlineBlur = 0.25 * intensity;
    text.outlineWidth = 0;
    return text;
  },
};
