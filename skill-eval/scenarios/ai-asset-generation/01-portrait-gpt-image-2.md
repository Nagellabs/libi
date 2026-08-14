---
id: portrait-gpt-image-2
title: Hero person portrait uses gpt-image-2 (not nano-banana)
skills: [ai-asset-generation, realistic-image-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
covers: [gpt-image-2, no-nano-banana, character-portrait, anatomy]
---

## Prompt
Generate a single photorealistic hero portrait of a fictional skincare-brand
spokesperson: a woman in her 30s, warm smile, holding the product bottle with
her hands clearly visible in frame. Studio lighting, shallow depth of field.
Use the best image model for realistic people and hands.

## Hard invariants
```yaml
assertions:
  - { endpoint_id: openai/gpt-image-2, expect: present }
  - { endpoint_id: "fal-ai/nano-banana*", expect: absent }
  # One portrait was requested — must NOT over-generate into video.
  - { endpoint_id: "bytedance/seedance-2.0/*", expect: absent }
```

## Behavioral expectations
- Chose `openai/gpt-image-2` for the photoreal person and did NOT downgrade to
  nano-banana via recommend_model (gpt-image-2 is the hardened default for
  realistic people/hands — the domain where nano-banana produced bad anatomy).
- Wrote a specific prompt (subject, lighting, framing, hands) — not a vague one-liner.
- Did not over-generate (one portrait was requested — it should not spin up video
  or extra assets unprompted).
