---
id: file-based-overlays-edit-file
title: Agent adds a three overlay then edits its scene file to refine it
skills: [three-overlays, animated-text-overlays]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [file-based-overlays, add_overlay, get_overlays, edit-overlay-file, verify-loop]
---

## Prompt
On a new 1920x1080 piece, add a single 3D object overlay — a ring of small cubes
orbiting the center — for the first 4 seconds. Then refine the MOTION: make the
cubes orbit faster and have them bob up and down on a sine wave as they go around.
Do NOT generate any video or audio clips — this is overlay work only.

## Hard invariants
```yaml
assertions:
  - endpoint_id: "*"
    expect: absent
```

## Behavioral expectations
- Created the overlay with `libi.add_overlay({ kind: "three", ... })` (the consolidated
  tool) and captured the returned `codeFilePath`.
- **Refined the MOTION by EDITING the returned `scene.jsx` file with its file tools** —
  changing the per-frame animation LOGIC / geometry generation (orbit speed + a sine-wave
  bob in the `update(frameApi)` closure), which is genuinely code-only and CANNOT be
  expressed through inspector controllers. There is no code-string update tool; code lives
  in the file.
- **Did NOT route this motion-logic change through `update_overlay`** — but understood that
  color, size, and position WOULD instead be controller edits (`libi.update_overlay`
  transform/effect fields), not a body edit. Controllers-first for those structured props;
  a file edit is reserved for behavior the controllers can't express (here, the custom
  orbit + bob motion).
- Used `libi.get_overlays` if it needed to rediscover the file path.
- Ran the render-verify loop (`libi.render_overlay_frames` → Read the PNG) after editing,
  and fixed via another file edit if the render was blank/wrong.
- Generated nothing (no fal/image/video calls).
