---
name: three-overlays
description: Add a real 3D / WebGL (three.js) overlay — perspective captions (text laid on a ground plane, floating billboard text that moves with the camera) and simple animated 3D objects, composited over the layers beneath. Load this BEFORE calling `libi.add_overlay` with kind three. Use when a caption needs DEPTH/PERSPECTIVE that flat Canvas2D code overlays cannot express (text mapped onto a road/floor, 3D-positioned lyrics that play with the footage), or for a simple rotating/animated 3D object. NOT for flat animated text (typewriter, word reveal, kinetic 2D caption → animated-text-overlays); NOT for speech subtitles (→ speech-captions); NOT for character rigs, physics, or imported heavy 3D models.
tags: [overlays, 3d, animation]
---

# 3D / WebGL Overlays (three.js)

Use this when the user wants **real 3D** layered on a scene — an **arbitrary 3D
scene** (a simple animated 3D object — a rotating ring/knot/box), **floating
billboard text** that drifts in depth, or text mapped in **perspective onto the
road/floor**. This is the path when the look needs a real WebGL camera /
perspective / bespoke meshes that a flat Canvas2D `add_overlay({ kind: "code" })`
can't express.

> **STOP — gate before you build a `three` overlay.** If a `kind: "text"`
> overlay + `place3d` (+ `threeD` extrusion) can express it, use THAT, NOT a
> `three` overlay. A tilted, extruded, posed, or billboard CAPTION is text +
> `place3d` — including anything phrased "real 3D" or "WebGL". A plain "3D
> caption" is `add_overlay({ kind: "text" })` THEN `update_overlay({ place3d:
> true, transform3d })` (+ `threeD` for thickness) — never a `three` overlay.
> Reach for `kind: "three"` ONLY when the look is one of:
> - an arbitrary 3D **object / scene** (not just text) — a rotating ring, a mesh,
>   a built scene;
> - **text mapped onto moving 3D geometry that tracks the footage** (a road /
>   fly-through that recedes WITH the camera, beyond a static pose);
> - a **camera fly-through**;
> - **animated 3D beyond static pose + depth + extrusion** (something `threeD` +
>   `transform3d` on a text overlay genuinely can't capture).

**For 3D TEXT, try `kind: "text"` + `place3d` / `threeD` FIRST.** A text overlay
is now declarative for depth — set `place3d: true` + `transform3d` (and the
`threeD` field — depth, bevel, front/side color, lighting, tilt — on
`libi.add_overlay({ kind: "text" })`) to get extruded / tilted / posed 3D text
with NO code, plus the full `reveal` vocabulary (`typewriter`, `fade-words`,
`slide-up`, `pop`, `karaoke`, `word-current`). That covers essentially all "make
the title/lyric 3D" requests. Reach for THIS skill's `three` overlay only when a
single declarative extruded-text element can't express the look (see the STOP
gate above).

For **flat** animated text (typewriter, word-by-word, pop, slide) use
**`animated-text-overlays`** (`kind: "text"`). For **speech-synced subtitles**
use **`speech-captions`**. Reach for a `three` overlay only when an arbitrary 3D
scene / bespoke perspective is the point.

**Captions are FLAT by default.** A 3D / tilted caption is opt-in — only build it
(here, or via `kind: "text"` + `threeD`) when the user explicitly asks for a 3D /
tilted / road / fly-through look. Don't reach for depth on a plain "add a caption"
request. (For a 3D text overlay the inspector exposes this as the **3D tab's "Make
text 3D" opt-in**, and 3D positioning is the **on-canvas orbit gizmo** — see "Static
placement" below; a `three` overlay is always 3D by nature.)

> **STOP — do not hand-write three.js camera/animation math from scratch, and
> do not strip the template down.** Copy a **complete vetted body printed below
> in this skill** (`billboardCaption` / `simpleObject` / `roadCaption`) and change
> ONLY the text + colour. You cannot read `lib/engine/three-templates.ts` from
> your workspace — the authoritative bodies live INLINE here, so use them verbatim.

## Default = billboard facing the user; orientation lives in the CONTROLS

**Unless the user explicitly asks for a road / ground / tilted / fly-through
perspective, create a BILLBOARD caption that faces the user** — the
`billboardCaption` body + `cameraPreset: "billboard"`. That is the good default:
text shown flat, front-on, readable, framed in its `rect`. A "make it 3D caption"
request with no perspective ask → billboard, facing the viewer.

**The orientation contract — keep the body's camera FRONTAL so the inspector
controls work.** This is the same controllers-first default the base instruction
states under "#### Overlay kind — controllers-first (HARD DEFAULT)": placement /
transform / pose belong on the gizmo + inspector (`transform3d` / `rect`), not
hardcoded in the scene body. A `three` overlay's orientation should come from the
**Pose grid + Rotation dial** (`transform3d`) and its framing from `cameraPreset`
+ the `rect` — NOT from a hand-aimed camera or a baked whole-scene rotation in the
body.
Concretely, in the scene body:
- Place content at the origin and leave it **facing +Z** (toward the camera). Do
  NOT bake a placement rotation like `label.rotation.x = -…` for "lay it on the
  ground" — that welds the orientation in.
- Either don't touch `camera` at all (let `cameraPreset` position it), or keep it
  **frontal** (`camera.lookAt(0, 0, 0)`). NEVER aim it off-axis
  (`camera.lookAt(0, 0, -6)` down a road) — that's what makes the overlay
  un-resettable.

Then **"Reset 3D" always returns the overlay to facing the user**, and
Angle/Elevation/Spin reorient it predictably. For a **road / perspective
lay-down**, don't bake it — set the **Elevation** on the Rotation dial (a
`transform3d.rotation.x` of about `-1.05`) on a billboard body; it gives the
on-road tilt AND stays adjustable + resettable. The legacy `roadCaption` body
below bakes a non-frontal camera + tilt, which **locks that perspective in** (the
dial/Reset can't bring it back to face the user) — reach for it only when that
fixed look is explicitly wanted; otherwise prefer billboard + Elevation.

## The authoring contract — build ONCE, then update per frame

`libi.add_overlay({ pieceId, kind: "three", displayName, body?, rect, startTime, duration, cameraPreset?, z?, opacity? })`.
`displayName` is REQUIRED for three overlays — a short human name (e.g. `"Logo Spin"`) shown in the timeline track label.
The call returns `{ overlayId, codeFilePath }` — `codeFilePath` is the
per-overlay `scene.jsx` file on disk. **You refine a 3D overlay by EDITING that
file directly with your file tools** (Read + Edit/Write); the storage watcher
re-renders the preview automatically. There is no code-string update tool. Pass
`body` to seed the scene (a starter is scaffolded when you omit it); then open
`codeFilePath` and edit it to match the look.

`body` (and the `scene.jsx` file it lands in) is a JS body that runs **once** to
build the scene, and **returns a per-frame `update` closure**:

```js
// Injected (already in scope — do NOT import anything):
//   THREE     — the three.js namespace
//   scene     — a THREE.Scene (add your meshes/text to it)
//   camera    — a THREE.PerspectiveCamera (positioned per cameraPreset)
//   renderer  — the shared WebGLRenderer (you normally don't touch it)
//   width, height — overlay rect size (the camera aspect is set for you per frame)
//   Text      — 3D text class (new Text()) — Canvas2D-texture glyphs on a plane
//   helpers   — math/easing: interpolate, spring, easeOutCubic, easeInCubic, easeOutBack, …
//   three3d   — convenience: groundPlane(THREE, {size,color}), glowText(text, {color,intensity})

// === roadCaption (the on-road perspective lyric look) — COPY THIS WHOLE BODY ===
// The four lines that MAKE it perspective (omit any of them and it renders as
// flat centered text — the #1 road-caption bug): the road-tilt `rotation.x`, the
// `ground` camera, and the glow `outlineColor`/`outlineBlur`.
const amb = new THREE.AmbientLight(0xffffff, 1.2);
scene.add(amb);
const label = new Text();
label.text = "EH OH EH";
label.fontSize = 0.9;                 // smaller for longer lines so it stays in-frame
label.anchorX = "center";
label.anchorY = "middle";
label.color = "#ff3df2";
label.outlineColor = "#ff3df2";       // GLOW — match the caption colour
label.outlineBlur = 0.28;
label.outlineWidth = 0;
label.rotation.x = -Math.PI / 2.6;    // ROAD-TILT — lays the text flat onto the road (REQUIRED)
label.position.set(0, 0, -2);
label.material.transparent = true;
scene.add(label);
camera.position.set(0, 1.1, 3.5);     // ground camera tilted down the road
camera.lookAt(0, 0, -6);
camera.updateProjectionMatrix();

// RETURN the per-frame update. `progress` is 0→1 across THIS overlay's window.
return ({ progress }) => {
  const p = progress || 0;
  // Dolly toward camera, but END SHORT of it (-1, not past 0) so the text peaks
  // readable instead of overflowing the frame. See the readability rule below.
  label.position.z = helpers.interpolate(p, [0, 1], [-7, -1.0]);
  const fadeIn = helpers.easeOutCubic(Math.min(1, p / 0.15));
  const fadeOut = 1 - helpers.easeInCubic(Math.max(0, (p - 0.85) / 0.15));
  label.material.opacity = fadeIn * fadeOut;
};
```

**Two rules that matter:**

1. **Build meshes/Text ONCE, in the body. NEVER create them inside the update
   closure.** three.js geometries/materials/text are expensive — the body runs
   once, the closure runs every frame. Creating `new THREE.Mesh()` / `new Text()`
   in the closure rebuilds the scene 30×/second and tanks the preview.
2. **Pace animation off `progress` (0→1 over the overlay's own window), never
   off composition frames** — the same element-local timing rule as code
   overlays. The update api is `{ progress, time, frame, duration }`; prefer
   `progress` for reveals and `time` (seconds, element-local) for steady spins.
3. **Keep the caption READABLE at its peak — never let the dolly overflow the
   frame.** A road caption should grow from tiny-at-the-vanishing-point to a
   big-but-legible size, then fade — it must NOT balloon past the frame edges at
   the end of the dolly (that reads as a bug, and real reels keep the lyric
   readable at its largest). With the `ground` preset the camera sits at z≈3.5,
   so END the dolly **short of the camera** (`-1`, not `+1.5`/`0`) and pick a
   `fontSize` so the whole word fits the frame width at its peak. Longer lines →
   smaller `fontSize` and/or a slightly farther end-z.

A static scene is fine too — if the body returns nothing, it renders as-is.

## cameraPreset

- **`ground`** — camera tilted down a receding plane (the road/floor look). Use
  for captions mapped in perspective onto the ground (the reel lyric look).
- **`billboard`** (default) — camera facing a fronto-parallel plane. Use for
  floating text that faces the viewer and drifts in depth, or a centered object.
- **`lowAngle`** — camera below the subject looking up. Use for heroic/dramatic
  text that rises into view.
- **`highAngle`** — camera above the subject looking down. Use for an
  overhead/map look over a ground plane.
- **`angled`** — a static 3/4 view that reveals an object's 3D depth (better than
  fronto-parallel for `simpleObject`-style rotating objects).

Keep the body's camera **frontal** (looking at the origin) — or don't touch it at
all and let the preset position it. Express tilt / perspective / orientation via
`transform3d` (the Rotation dial), NOT a non-frontal `camera.lookAt` or a baked
content rotation — otherwise the Pose/Rotation/Reset controls can't reorient the
overlay and the user can't reset it to face them (see "Default = billboard" above).

## Static placement — use `transform3d`, not hand-edited camera math

To **position or orient a 3D object as a whole** (static placement — e.g.
"rotate it 45° to the side", "move it left"), set the **`transform3d`** field on
`libi.add_overlay` (kind `three`) or `libi.update_overlay` — do NOT rewrite the
`sceneFunction`'s camera/scene math for static placement. `transform3d` is applied
to the scene root automatically every frame:

- `position` — `{ x, y, z }` in **world units**
- `rotation` — `{ x, y, z }` Euler **XYZ in RADIANS** (45° → `0.785`, 90° → `1.5708`)

There is no `transform3d.scale`. **To make it bigger/smaller, resize the overlay
`rect`** (the Size control) — a three overlay is a rect window the scene renders
into, so a larger `rect` enlarges the apparent content, exactly like image/video.
Example — `libi.update_overlay({ pieceId, overlayId, rect: { x, y, width, height } })`.

Example — rotate the object 45° to the side:
`libi.update_overlay({ pieceId, overlayId, transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0.785, z: 0 } } })`.

The user can also drag the **in-canvas gizmo** on a selected 3D overlay (move +
corner-resize the rect window, plus the depth thumb + rotation dial) to set the
same fields directly. Either way, reserve `sceneFunction` edits for the build-once
scene + per-frame animation; let `transform3d` own static orientation/position and
`rect` own size.

## Vetted template bodies (copy verbatim, change only text + colour)

**billboardCaption** — glowing text facing the camera, drifting + pop-in scale (`cameraPreset: "billboard"`):

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

**simpleObject** — a rotating torus knot popping in with a scale spring (`cameraPreset: "billboard"` or `"angled"`):

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

## Workflow

1. **Pick the template body** that matches the look and **copy it verbatim**, then
   change only the text + colour. **Default to billboard** unless the user
   explicitly asked for perspective (see "Default = billboard" above):
   - glowing text facing the viewer (THE DEFAULT) → **billboardCaption** body (below), `cameraPreset: "billboard"`
   - a rotating 3D object → **simpleObject** body (below), `cameraPreset: "billboard"`
   - text on the road/floor in perspective, ADJUSTABLE → **billboardCaption** body + set `transform3d: { rotation: { x: -1.05, y: 0, z: 0 } }` (the Elevation lay-down — stays resettable)
   - text WELDED onto the road in perspective (fixed look, not resettable) → **roadCaption** body (above), `cameraPreset: "ground"` — only when the locked perspective is explicitly wanted
2. **Set the window + rect.** `startTime`/`duration` (seconds) define the window
   `progress` runs across; `rect` is the box it composites into (usually the full
   frame — read `width`/`height` from `get_composition`). Pick `z` above the base
   scene; raise it above any 2D captions you want it in front of.
3. **Adapt** the text/color in the template call. Keep edits to the template's
   parameters — don't rewrite the camera/animation math.
4. **Add** via `libi.add_overlay({ kind: "three", body, ... })`. Capture the
   returned `codeFilePath` (the `scene.jsx` file). If the result carries a
   `data.warning` (a heavy-geometry heads-up), simplify the body.
5. **Verify by RENDERING and LOOKING — do the verify loop below.** You cannot see
   the live preview; the only way to know what a 3D overlay actually looks like is
   to render real frames and open them. Run the **Verify loop** (next section) on
   every 3D overlay before considering it done.
6. **Tweak by EDITING the file, don't re-add.** To change the SCENE/animation of a
   3D overlay you already added — new text, different colours, retuned camera math —
   **open its `scene.jsx` (`codeFilePath` from `add_overlay`, or rediscover it with
   `libi.get_overlays`) and edit it directly with your file tools.** The storage
   watcher re-validates and rebuilds the scene in the preview automatically — no
   tool call. For STRUCTURED changes only (a different `cameraPreset`, a moved/
   resized `rect`, a retimed `startTime`/`duration`, `z`, `opacity`) call
   `libi.update_overlay({ pieceId, overlayId, ... })` — but that tool NEVER touches
   code; the scene body lives in the file.

## Verify loop — build → render → look → fix (mandatory for ANY 3D overlay)

You build 3D overlays **blind** — three.js camera/projection math is easy to get
subtly wrong, and a wrong value often renders BLANK or off-frame with no error.
So after adding (or updating) a 3D overlay, **prove it by looking at real rendered
pixels.** This loop applies to any `three` overlay — a road caption, a floating
billboard title, a rotating object — captions are just the most common case.

1. **Render.** Call `libi.render_overlay_frames({ pieceId, overlayId })`. It
   rasterizes a few real composition frames (base video + your overlay, through the
   same pipeline as export) to PNG files and returns
   `frames: [{ time, path, overflow: { touchesEdge, edges } }]`. (You can also pass
   explicit `atTimes: [t1, t2, …]` — 1–8 seconds — to check specific moments; with
   `overlayId` it auto-picks start / middle / end.)
2. **Look.** **Open each `path` with your Read tool** — it loads the PNG as an image
   so you actually SEE the frame (the proven `analysis_extract_frames` pattern).
   Do not skip this — a tool result that "succeeded" tells you nothing about whether
   the overlay looks right.
3. **Diagnose against the intent:**
   - **Blank / nothing rendered** ⇒ the **yaw-sign / behind-camera footgun**. A
     roadside-wall caption must recede toward **−z**, which needs a **POSITIVE**
     `rotation.y` (~`+0.4`…`+0.8` rad); the wrong sign throws the plane behind the
     camera and it renders blank with no error. Also check the plane isn't placed
     behind `camera.position.z`. Fix the geometry and re-render.
   - **Clipping the frame** ⇒ the element is too big / mis-placed and is running off
     the frame. **3D overlays can't be statically clamped** — projected size depends on
     the camera — so your **eyes on the rendered frame are the real guard**. The
     `overflow.touchesEdge` flag is a SECONDARY hint and is **base-dependent**: over a
     dark / canvas base it reliably means your overlay hit the edge, but **over a
     full-frame video it just reflects the VIDEO reaching the edges, not your overlay**
     — so do NOT shrink a caption merely because `touchesEdge` is true over video; trust
     what you SEE in the PNG. When it genuinely overflows: shrink (`fontSize` down, or
     pull the dolly end-z back toward `-1.5`), or reposition, then re-render.
   - **Wrong position / size / motion / colour** vs the source or intent ⇒ fix the
     template parameters (not the camera math).
4. **Fix + re-verify.** Apply the fix by **editing the `scene.jsx` file** (the
   `codeFilePath`) with your file tools — the watcher rebuilds the scene — then render
   again. **Cap at ~2 loops per overlay** — if it's still wrong after two passes,
   stop and tell the user what's off rather than thrashing.

A 3D overlay you didn't render and look at is **unverified**. Always run the loop on
the hardest frames — for a receding/dollying caption that's the END of the window
(where it's most likely to overflow), and for a world-anchored element the moments
the camera moves past it.

## Guardrails

- **Keep it light.** Each active 3D overlay is a WebGL render + composite per
  frame. A few are fine; don't stack many simultaneously, and avoid huge geometry
  (high segment counts / mesh-building loops) — the soft budget warning flags the
  worst cases, but lean meshes keep the 30 Hz preview smooth.
- **No imports.** three.js + the `Text` class are injected; the body must not `import` /
  `require` / `fetch` / `new Function` — the validator rejects those (same
  blocklist as code overlays).
- **In scope: captions + simple objects + animation.** OUT of scope: character
  rigs, skeletal animation, physics, imported glTF models, "Blender-level" scenes
  — AI generation handles those; do not attempt them in a `three` overlay.
- **Export is automatic.** A composition with a `three` overlay exports through
  the chromium-render path (same as canvas/code overlays) — no extra setup in the
  app. (Terminal / bring-your-own-CLI exports need Playwright's Chromium once,
  exactly like canvas/code-overlay exports.)

## When your 3D result isn't right — point at the control

If the overlay's orientation / position / size isn't what the user wanted, fix it
through the **controls**, not by thrashing the scene body: use
`libi.highlight_property` to surface the exact field (a `transform3d.rotation`
axis, `rect`, `cameraPreset`) and lean on the **`guiding-manual-edits`** skill to
walk the user through the hand-tweak on the gizmo + inspector. That keeps the
result adjustable and resettable instead of welded into `sceneFunction`.

## Cross-skill references
- `animated-text-overlays` — flat (2D) kinetic captions / titles (the default for text)
- `guiding-manual-edits` — walking the user through a hand-tweak via `highlight_property`
- `speech-captions` — transcript-synced subtitles
- `mimic-video-captions` — the caption-mimic flow; drives this skill (and its verify
  loop) when reproducing a source video's 3D / perspective captions
- `mimic-video` — the video-content recreate router (routes a perspective/3D caption
  look to `mimic-video-captions`, which routes the 3D build here)
