---
name: three-overlays
description: "Add a real 3D (three.js) overlay: perspective captions laid on a road or floor, floating billboard text that moves with the camera, 3D lyrics, or a simple animated 3D object. Load before libi.add_overlay with kind three. Not for flat animated text (animated-text-overlays), speech subtitles (speech-captions), rigs, physics or heavy models."
tags: [overlays, 3d, animation]
---

# 3D / WebGL overlays (three.js)

Done looks like this: a `three` overlay you have rendered and looked at, whose orientation and
size the user can still change from the gizmo and inspector.

## Is it a three overlay at all?

Text first. A tilted, extruded, posed or billboard caption is `kind: "text"` plus `place3d` /
`transform3d` and `threeD` (`add_overlay({ kind: "text" })`, then `update_overlay({ place3d:
true, transform3d })`), even when the user says "real 3D" or "WebGL". Reach for `kind: "three"`
only when the look is one of:

- an arbitrary 3D object or scene (a rotating ring, a mesh, a built scene);
- text on moving 3D geometry that tracks the footage (a road or fly-through that recedes with
  the camera, beyond a static pose), or a camera fly-through;
- animation beyond static pose, depth and extrusion.

Flat animated text is `animated-text-overlays`; speech-synced subtitles are `speech-captions`.
Captions are flat unless the user explicitly asks for a 3D, tilted, road or fly-through look.
Out of scope for a three overlay: character rigs, skeletal animation, physics, imported glTF
models, Blender-level scenes. Generation covers those.

## Copy a vetted template

Do not hand-write camera or animation math, and do not strip a template down. Copy a complete
body below (`billboardCaption`, `simpleObject`, `roadCaption`) and change only the text and
colour. Copy the bodies below; there is no other copy.

**Default to a billboard that faces the user** (`billboardCaption`, `cameraPreset:
"billboard"`) unless the user explicitly asks for road, ground, tilted or fly-through
perspective. Keep the body's camera frontal (leave it to `cameraPreset`, or `camera.lookAt(0,
0, 0)`), put content at the origin facing +Z, and never bake a placement rotation. Orientation
then comes from the controls (`transform3d`, the Rotation dial) and framing from
`cameraPreset` and the `rect`, so Reset 3D always returns it to facing the viewer. For an
adjustable road lay-down, use the billboard body plus `transform3d: { rotation: { x: -1.05, y:
0, z: 0 } }`. `roadCaption` welds a non-frontal camera and tilt into the body, which the dial
cannot undo, so use it only when that fixed look is explicitly wanted.

## The authoring contract: build once, update per frame

`libi.add_overlay({ pieceId, kind: "three", displayName, body?, rect, startTime, duration,
cameraPreset?, z?, opacity? })`. `displayName` is required (the timeline label). It returns
`{ overlayId, codeFilePath }`, the overlay's `scene.jsx`. Omit `body` and a starter is
scaffolded; refine by editing that file directly, because there is no code-string update tool.
`body` runs once to build the scene and returns a per-frame `update` closure. In scope without
imports: `THREE`, `scene`, `camera` (positioned per `cameraPreset`), `renderer`, `width`,
`height`, `Text` (3D text), `helpers` (`interpolate`, `spring`, `easeOutCubic`,
`easeInCubic`, `easeOutBack`, ...) and `three3d` (`groundPlane`, `glowText`).

1. Build meshes and `Text` once, in the body. Never create them inside the update closure:
   geometry and text are expensive and rebuilding 30 times a second tanks the preview.
2. Pace off `progress` (0→1 across the overlay's own window) or element-local `time`
   (seconds), never composition frames. The update receives `{ progress, time, frame, duration,
   compositionTime, overlayStart, pieceDuration }`. Never hard-code a composition time in a
   body: when it must line up with the piece's timeline, read `compositionTime`, `overlayStart`
   or `pieceDuration`.
3. Keep a road caption readable at its peak. End the dolly short of the camera (`-1`, not past
   0) and size `fontSize` so the whole word fits the frame at its largest; longer lines get a
   smaller font or a farther end z.

A body that returns nothing renders a static scene.

```js
// roadCaption — ground-camera perspective lyric. The four lines that make it perspective:
// the road-tilt rotation.x, the ground camera, and the glow outlineColor/outlineBlur.
const amb = new THREE.AmbientLight(0xffffff, 1.2);
scene.add(amb);
const label = new Text();
label.text = "EH OH EH";
label.fontSize = 0.9;                 // smaller for longer lines
label.anchorX = "center";
label.anchorY = "middle";
label.color = "#ff3df2";
label.outlineColor = "#ff3df2";       // glow, match the caption colour
label.outlineBlur = 0.28;
label.outlineWidth = 0;
label.rotation.x = -Math.PI / 2.6;    // road tilt (required)
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
```

**billboardCaption** (`cameraPreset: "billboard"`): glowing text facing the camera, drifting with a pop-in.

```js
const amb = new THREE.AmbientLight(0xffffff, 1.4);
scene.add(amb);
const label = new Text();
label.text = "EH OH EH";
label.fontSize = 1.0;
label.anchorX = "center";
label.anchorY = "middle";
label.color = "#ff3df2";
label.outlineColor = "#ff3df2";   // glow
label.outlineBlur = 0.3;
label.outlineWidth = 0;
label.material.transparent = true;
label.position.set(0, 0, 0);
scene.add(label);
camera.position.set(0, 0, 6);
camera.lookAt(0, 0, 0);
camera.updateProjectionMatrix();
return ({ progress }) => {
  const p = progress || 0;
  label.position.x = helpers.interpolate(p, [0, 1], [-0.5, 0.5]);
  label.position.y = Math.sin(p * Math.PI * 2) * 0.12;
  const s = helpers.easeOutBack(Math.min(1, p / 0.2));
  label.scale.set(s, s, s);
  const fadeOut = 1 - helpers.easeInCubic(Math.max(0, (p - 0.85) / 0.15));
  label.material.opacity = Math.min(1, p / 0.1) * fadeOut;
};
```

**simpleObject** (`cameraPreset: "billboard"` or `"angled"`): a rotating torus knot with a scale spring.

```js
const amb = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(amb);
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(2, 3, 4);
scene.add(dir);
const geo = new THREE.TorusKnotGeometry(0.9, 0.28, 120, 16);
const mat = new THREE.MeshStandardMaterial({ color: "#19e3c2", metalness: 0.5, roughness: 0.3 });
const mesh = new THREE.Mesh(geo, mat);
scene.add(mesh);
camera.position.set(0, 0, 4);
camera.lookAt(0, 0, 0);
camera.updateProjectionMatrix();
return ({ progress, time }) => {
  const p = progress || 0;
  const t = time || 0;
  mesh.rotation.y = t * 1.2;
  mesh.rotation.x = t * 0.6;
  const s = helpers.easeOutBack(Math.min(1, p / 0.2));
  mesh.scale.set(s, s, s);
};
```

## cameraPreset, placement and edits

`cameraPreset`: `billboard` (default; faces the viewer), `ground` (down a receding plane: the
road look), `lowAngle` (looking up: heroic rise), `highAngle` (looking down: map or overhead),
`angled` (static 3/4 view that shows an object's depth).

Static placement of the whole object goes in `transform3d` on `add_overlay` or `update_overlay`,
not in camera math: `position` in world units, `rotation` as Euler XYZ in radians (45° is
`0.785`). There is no scale: resize the overlay `rect`, which is the window the scene renders
into. The user can set the same fields with the on-canvas gizmo.

Change the scene or animation (text, colours, camera) by editing `scene.jsx` at `codeFilePath`
(rediscover it with `libi.get_overlays`); the watcher rebuilds it. To reuse another scene's
setup, `libi.code_outline` first and read only the lines you need with `includeSource`, or reuse its
helpers with `include: { fromOverlayId, names }` on `libi.add_overlay` rather than copying them by hand.
Use `libi.update_overlay` only for structured fields (`cameraPreset`, `rect`, timing, `z`, `opacity`,
`transform3d`); it never touches code (its `include` only prepends another scene's helpers).

## Verify: render, look, fix

You build blind: a wrong camera value often renders blank or off-frame with no error. After
adding or changing a three overlay, call `libi.render_overlay_frames({ pieceId, overlayId })`
(it picks start, middle and end; pass `atTimes` for specific moments), view each returned
`path`, and compare with the intent.

- Blank: the yaw-sign / behind-camera footgun. A roadside caption must recede toward -z, which
  needs a positive `rotation.y` (about +0.4 to +0.8 rad); the wrong sign, or a plane behind
  `camera.position.z`, renders nothing and raises no error.
- Clipping the frame: shrink the font or pull the dolly end z back toward -1.5, then re-render.
  Projected size depends on the camera, so your eyes on the PNG are the guard. `overflow.touchesEdge` is a
  hint only, and over full-frame video it reflects the video, not your overlay.
- Wrong position, size, motion or colour: fix the template parameters, not the camera math.

Fix by editing `scene.jsx`, then render again; stop after about two loops and tell the user
what is off. Check the hardest frame: the end of a dolly, or the moment the camera passes a
world-anchored element.

## Guardrails

- Each active three overlay is a WebGL render per frame: a few are fine, avoid many at once
  and huge geometry (the soft-budget `data.warning` says when to simplify).
- No `import`, `require`, `fetch` or `new Function`; the validator rejects them as for code
  overlays.
- Exports use the chromium-render path automatically. Terminal and bring-your-own-CLI exports
  need Playwright's Chromium once, as canvas and code overlays do.

When orientation, position or size is not what the user wanted, fix it through the controls
rather than thrashing the body: `libi.highlight_property` on `transform3d.rotation`, `rect` or
`cameraPreset`, and load `guiding-manual-edits`. `mimic-video-captions` drives this skill when
reproducing a source's perspective captions.
