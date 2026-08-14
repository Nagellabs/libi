---
id: onboarding-demo-no-generation
title: Onboarding demo imports pre-made clips, layers animated overlays, and discloses (no generation)
skills: [onboarding-libi-explainer-short]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 300
covers: [onboarding, no-generation, import-only, disclosure, pre-made-clips, audio-clips, layer-effects]
---

## Prompt
Show me how libi works — run the onboarding demo.

## Hard invariants
```yaml
assertions:
  # The key invariant: the skill explicitly forbids generation tools.
  # No fal run_model or submit_job calls must appear in the trace.
  - { tool: "run_model", expect: absent }
  - { tool: "submit_job", expect: absent }
  # Not even exploratory generation: no model recommendation lookups.
  - { tool: "recommend_model", expect: absent }
  # No ElevenLabs TTS/SFX/music calls either — the clips carry their own audio.
  - { provider: "elevenlabs", expect: absent }
```

## Behavioral expectations
- Called `libi.import_remote_files` exactly ONCE with BOTH demo clip URLs in a single
  call (the samplelib `sample-5s.mp4` park/nature clip and the Blender `trailer_480p.mov`
  animation clip) — did NOT call it twice (one per clip), and did NOT use `libi.upload_file`
  or any other per-file import path.
- Added exactly TWO full-frame video overlays via `libi.add_overlay({ kind: "video" })`:
  the nature clip at `startTime: 0`, and the animation clip at `startTime: 5` with a
  `trim` window (start 10, end 20) so only the ~10s bunny segment plays. Did NOT use the
  retired `libi.create_video_scene`.
- Added animated text overlays via `libi.add_overlay({ kind: "text" })` — at minimum a
  title ("meet libi"), a lower-third label over the animation clip, and a closing
  ("your turn.") — and gave them motion via `libi.apply_layer_effect` (built-in effect
  ids like `pop`, `fade`, `wipe`, `fade-words`, `slide-up-lines`). Did NOT hand-write
  code/draw-function overlay bodies for these.
- Did NOT call any image or video generation tool (no fal-ai model, no recommend_model
  for generation, no ElevenLabs TTS/SFX/music), and did NOT add a separate music/audio
  clip — the imported clips' native audio is the sound.
- Called `libi.show_piece` to reveal the finished demo piece.
- The closing message plainly stated that the clips were PRE-CREATED / downloaded (not
  generated live in this session) — the transparency disclosure was NOT skipped.
- The closing message explained that in a real project assets are generated fresh
  (slower, uses credits), noted the layers are live/chat-editable (ideally with a trivial
  example command), and ended by asking the user what they want to make.
