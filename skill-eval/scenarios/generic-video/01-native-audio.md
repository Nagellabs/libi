---
id: generic-video-native-audio
title: Generic AI video keeps native audio (no unsolicited TTS)
skills: [generic-video, ai-asset-generation, video-generation-craft]
mcps: [fal-ai]
agent: claude-code
runs: 1
# Routed through the storyboard by default; the flow legitimately takes >300 s.
timeoutSec: 900
covers: [native-audio, no-kokoro, video-generation-craft, generic-video]
---

## Prompt
Make a 10-second AI video of a friendly barista explaining today's special at a
cafe. She speaks one short line to camera. Generate it and assemble.

## Hard invariants
```yaml
assertions:
  - { endpoint_id: "bytedance/seedance-2.0/*", where: "input.generate_audio == false", expect: absent }
```

## Behavioral expectations
- Kept native audio ON for the spoken line (`generate_audio=true`); did not mute.
- Did NOT generate a separate Kokoro / ElevenLabs / TTS voiceover for a single short clip.
- Loaded the video-generation-craft skill's policy (native audio by default).
