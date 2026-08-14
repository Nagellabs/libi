---
id: animated-text-overlays-flat-by-default
title: A plain caption stays FLAT 2D — no 3D / tilt unless the user asks
skills: [animated-text-overlays, speech-captions, three-overlays]
mcps: []
agent: claude-code
runs: 1
covers: [text-overlay, flat-default, no-threeD, no-tilt, captions]
---

## Prompt
I have a piece open. Add a caption near the bottom that says "Fresh drop, today only".

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Added the caption as a FLAT 2D text overlay — `libi.add_overlay({ kind: "text" })`
  (or the `speech-captions` path), upright and readable.
- Did NOT enable 3D: no `threeD` block on the text overlay, no `kind: "three"` WebGL
  scene, no extrusion/depth/tilt. A plain "add a caption that says X" request is flat
  by default — depth is opt-in and only when the user explicitly asks for a 3D /
  tilted / road / fly-through look (this request does not).
- Did NOT tilt the caption edge-on or off-plane. (A flat caption can never be tilted
  edge-on — the renderer guardrails this; the agent should not even attempt it here.)
- If it set any rotation at all (it need not), only a small 2D in-plane
  `overlay.rotation` on the Transform tab would be acceptable — never a 3D tilt /
  yaw / orbit angle, which only exist once a caption is made 3D.
- Reasonable bottom-safe placement with a readability treatment (stroke or plate);
  did not over-style into a 3D/perspective look the user never requested.

## Inverse (for the judge's reference — NOT this scenario's prompt)
If the prompt HAD asked for a "3D" / "tilted" / "road" / "fly-through" caption, the
correct behavior is the opposite: enable the 3D opt-in (set `threeD` on the `kind:
"text"` overlay, or use the `three-overlays` skill for an arbitrary 3D scene) and let
the on-canvas orbit gizmo drive 3D positioning. That path is covered by the
`three-d-text` and `three-overlays` scenarios.
