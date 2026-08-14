/** Vetted three-overlay scene bodies. Each returns a build-once body STRING
 *  (compiled via createThreeScene; injected params per THREE_PARAM_NAMES).
 *  Pace animation off the update closure's `progress`, never composition frames. */

export interface RoadCaptionParams {
  text: string;
  /** CSS color or hex. Default magenta to match the reel look. */
  color?: string;
}

/**
 * Glowing lyric/caption text laid toward a receding ground plane in
 * perspective, dollying toward the camera and fading at the ends. The
 * motivating "road-mapped caption" case. The dolly ENDS short of the camera
 * (z −7 → −1) so the text peaks at a readable size instead of overflowing the
 * frame — matching how source reels keep the lyric legible at its largest.
 */
export function roadCaption(p: RoadCaptionParams): string {
  const color = p.color ?? "#ff3df2";
  return `
const amb = new THREE.AmbientLight(0xffffff, 1.2);
scene.add(amb);
const label = new Text();
label.text = ${JSON.stringify(p.text)};
label.fontSize = 0.9;
label.anchorX = "center";
label.anchorY = "middle";
label.color = ${JSON.stringify(color)};
label.outlineColor = ${JSON.stringify(color)};
label.outlineBlur = 0.28;
label.outlineWidth = 0;
label.rotation.x = -Math.PI / 2.6;
label.position.set(0, 0, -2);
label.material.transparent = true;
scene.add(label);
camera.position.set(0, 1.1, 3.5);
camera.lookAt(0, 0, -6);
camera.updateProjectionMatrix();
return ({ progress }) => {
  const p = progress || 0;
  label.position.z = helpers.interpolate(p, [0, 1], [-7, -1.0]);
  const fadeIn = helpers.easeOutCubic(Math.min(1, p / 0.15));
  const fadeOut = 1 - helpers.easeInCubic(Math.max(0, (p - 0.85) / 0.15));
  label.material.opacity = fadeIn * fadeOut;
};
`.trim();
}

export interface BillboardCaptionParams {
  text: string;
  /** CSS color or hex. Default magenta. */
  color?: string;
}

/**
 * Glowing caption text facing the camera, floating in 3D with a gentle
 * horizontal parallax drift + a pop-in scale and fade. Fronto-parallel
 * (cameraPreset "billboard").
 */
export function billboardCaption(p: BillboardCaptionParams): string {
  const color = p.color ?? "#ff3df2";
  return `
const amb = new THREE.AmbientLight(0xffffff, 1.4);
scene.add(amb);
const label = new Text();
label.text = ${JSON.stringify(p.text)};
label.fontSize = 1.0;
label.anchorX = "center";
label.anchorY = "middle";
label.color = ${JSON.stringify(color)};
label.outlineColor = ${JSON.stringify(color)};
label.outlineBlur = 0.3;
label.outlineWidth = 0;
label.material.transparent = true;
label.position.set(0, 0, 0);
scene.add(label);
// NOTE: do NOT set the camera — leaving the preset camera alone lets the
// renderer auto-frame the content so the caption is never cut by the rect, at
// any rect aspect or gizmo rotation. (A body that sets its own camera opts out
// of auto-framing — see roadCaption.)
return ({ progress }) => {
  const p = progress || 0;
  label.position.x = helpers.interpolate(p, [0, 1], [-0.5, 0.5]);
  label.position.y = Math.sin(p * Math.PI * 2) * 0.12;
  const s = helpers.easeOutBack(Math.min(1, p / 0.2));
  label.scale.set(s, s, s);
  const fadeOut = 1 - helpers.easeInCubic(Math.max(0, (p - 0.85) / 0.15));
  label.material.opacity = Math.min(1, p / 0.1) * fadeOut;
};
`.trim();
}

export interface SimpleObjectParams {
  /** CSS color or hex for the object material. Default teal. */
  color?: string;
}

/**
 * A rotating 3D primitive (torus knot) lit by an ambient + directional light,
 * popping in with a scale spring. The worked "simple animated object" example.
 * Fronto-parallel (cameraPreset "billboard").
 */
export function simpleObject(p: SimpleObjectParams = {}): string {
  const color = p.color ?? "#19e3c2";
  return `
const amb = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(amb);
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(2, 3, 4);
scene.add(dir);
const geo = new THREE.TorusKnotGeometry(0.9, 0.28, 120, 16);
const mat = new THREE.MeshStandardMaterial({ color: ${JSON.stringify(color)}, metalness: 0.5, roughness: 0.3 });
const mesh = new THREE.Mesh(geo, mat);
scene.add(mesh);
// NOTE: do NOT set the camera — the renderer auto-frames the content so it's
// never cut by the rect (see billboardCaption). Bodies that need a specific
// camera (e.g. roadCaption's dolly) set it and opt out of auto-framing.
return ({ progress, time }) => {
  const p = progress || 0;
  const t = time || 0;
  mesh.rotation.y = t * 1.2;
  mesh.rotation.x = t * 0.6;
  const s = helpers.easeOutBack(Math.min(1, p / 0.2));
  mesh.scale.set(s, s, s);
};
`.trim();
}
