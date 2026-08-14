---
id: overlay-presets-02
title: Saving a preset under a name that's already taken (collision → override or rename)
skills: [guiding-manual-edits]
mcps: []
agent: claude-code
runs: 1
covers: [overlay-presets, save_overlay_preset, preset_name_exists, override]
---

## Prompt
Create a piece with a text caption that says "SAVE". Style it however you like
(e.g. a bold color with an outline). Save that look as a preset called "promo".
Then save it AGAIN as a preset called "promo" — the same name. Handle the name
collision sensibly and tell me what you did.

## Hard invariants
```yaml
# Behavioral-only: the skill-eval trace recorder captures fal-ai / elevenlabs
# generation calls, NOT core libi tool calls (save_overlay_preset etc.), so the
# collision/override behavior is verified by judging the transcript below.
assertions: []
```

## Behavioral expectations
- Created the piece and added a text caption reading "SAVE", styled with a color
  and outline/stroke of its choosing.
- Saved that styled overlay's look as a preset named "promo" via
  `libi.save_overlay_preset({ pieceId, overlayId, name: "promo" })` (captured the
  returned preset id).
- On the SECOND save under the same name "promo", the agent hit the
  `preset_name_exists` collision and did NOT silently create a duplicate preset.
- It resolved the collision deliberately — EITHER re-called
  `save_overlay_preset` with `override: true` to replace the existing "promo"
  preset, OR chose a different, non-colliding name — and clearly explained to the
  user which path it took and why.
- It did not treat the collision as a hard failure or give up; the second save
  ended with a usable preset.
