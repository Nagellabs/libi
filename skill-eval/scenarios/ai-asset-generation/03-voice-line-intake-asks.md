---
id: voice-line-no-line-means-music-offer
title: A user who says "no spoken line" gets native audio kept and a music bed offered, not a silenced clip
skills: [ai-asset-generation, using-storyboard, voiceover-production]
mcps: [fal-ai]
agent: claude-code
runs: 1
timeoutSec: 900
covers: [voice-line-intake, music-bed-offer, native-audio-kept]
---

## Prompt
Make me a 6-second vertical clip of a barista pouring latte art in a sunlit café,
slow push-in, warm tones. Use Seedance. No spoken line in it.

## Hard invariants
```yaml
assertions:
  # The clip is generated with native audio ON — "no line" never means generate_audio=false.
  - { tool: submit_job, endpoint_id: "bytedance/seedance-2.0/*", where: "input.generate_audio != false", expect: present }
  - { tool: submit_job, endpoint_id: "bytedance/seedance-2.0/*", where: "input.generate_audio == false", expect: absent }
  # The no-line branch of the intake: a music bed is offered, naming the free on-device path.
  - { transcript_contains: ["libi.generate_music", "libi_generate_music", "ACE-Step"], expect: present }
```

## Behavioral expectations
- Respected "no spoken line": no dialogue in the prompt, no line on the card.
- Kept `generate_audio = true` (ambient/SFX) and did not call the clip "silent".
- Offered (or, pre-authorized, planned) a music bed — libi's free on-device
  `libi.generate_music` first, the user's provider only on request — as a separate audio clip
  under the video, not by muting the generation.
