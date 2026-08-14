---
id: ugc-fully-ai-nail-ad
title: Recreate a 30s nail ad, fully AI
skills: [ugc-product-video, ai-asset-generation, ai-video-models, voiceover-production, realistic-image-generation, physical-action-video]
mcps: [fal-ai]
agent: claude-code
runs: 1
timeoutSec: 900
covers: [gpt-image-2, native-audio, seedance-2.0, prompt-quality, no-kokoro]
---

## Prompt
Create a 30-second UGC nail-polish ad for a fictional brand "Lumi", fully AI-generated
(no source footage). Generate the hero product images and the video clips, then build
the composition. Use the best image model for product realism.

## Hard invariants
```yaml
assertions:
  # Endpoint-scoped, NOT tool-scoped: the agent may reach gpt-image-2 via the
  # sync `run_model` OR the async `submit_job` path (both observed) — assert the
  # model choice, not the call style.
  - { endpoint_id: openai/gpt-image-2, expect: present }
  - { endpoint_id: "fal-ai/nano-banana*", expect: absent }
  - { endpoint_id: "bytedance/seedance-2.0/*", where: "input.generate_audio == false", expect: absent }
  - { endpoint_id: "bytedance/seedance-2.0/*", count: ">=1" }
```

## Behavioral expectations
- Wrote specific, structured image/video prompts (subject, lighting, framing) — not vague one-liners.
- Used `openai/gpt-image-2` for product stills and did NOT silently downgrade to nano-banana via recommend_model.
- Did NOT generate a Kokoro voiceover for a UGC ad.
- If it proposed a voiceover, it ASKED the user first rather than adding one unprompted.
