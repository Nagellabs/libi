---
id: inline-chat-media-salient
title: Agent surfaces a salient generated asset inline in the chat via show_in_chat
skills: [ai-asset-generation, using-storyboard]
mcps: [fal-ai]
agent: claude-code
runs: 1
# Single image generation, then the agent puts the result in front of the user
# inline in the chat. Lightweight flow.
timeoutSec: 600
covers: [show-in-chat, salient-result, inline-media]
---

## Prompt
Generate one realistic product photo of a matte-black ceramic coffee mug on a
sunlit wooden table, and show it to me right here in the chat.

## Hard invariants
```yaml
assertions:
  # Exactly one image generation for a single asset (no over-generation).
  - { tool: run_model, count: ">=1" }
  - { tool: run_model, count: "<=2" }
```

## Behavioral expectations
- **Put the result in front of the user** — after generating and importing the
  image, the agent calls `libi.show_in_chat({ fileId, caption? })` so the photo
  renders inline in the conversation. This is the core expectation.
- **Showed the salient result, once** — it surfaced the single accepted image,
  not every intermediate attempt; it did not spam multiple `show_in_chat` calls
  for a batch.
- **Used the real file id** — the `fileId` passed to `show_in_chat` is the id of
  the imported generated image (not a guess / not a storyboard slot key).
- **Did not rely on markdown alone** — surfacing the asset went through the
  `show_in_chat` tool (which renders a real inline player/thumbnail), not just a
  bare markdown link in prose.
- **Surface-appropriate** — `show_in_chat` is the in-app mechanism; the agent
  did not additionally try to emit terminal escape codes or a sixel image.
