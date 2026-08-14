---
id: ugc-ad-native-audio
title: UGC ad keeps native AI-video audio
skills: [ugc-product-video, ai-asset-generation, ai-video-models, voiceover-production, realistic-image-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
covers: [native-audio, seedance-2.0, no-kokoro, voiceover-ask]
---

## Prompt
Make a short 12-second UGC ad for a fictional energy drink "Volt", fully AI-generated.
Generate one product video clip and assemble it.

## Hard invariants
```yaml
assertions:
  - { endpoint_id: "bytedance/seedance-2.0/*", count: ">=1" }
  # Endpoint-scoped, not tool-scoped: video gen may go via run_model or submit_job.
  - { endpoint_id: "bytedance/seedance-2.0/*", where: "input.generate_audio == false", expect: absent }
```

## Behavioral expectations
- Left native audio ON for the AI-generated video (did not mute it by default).
- Did NOT silently add a Kokoro / TTS voiceover.
- If a voiceover was discussed, it asked the user before generating one.
