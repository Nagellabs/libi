---
name: video-generation-craft
description: "Reference for generating AI video and its keyframes, loaded by creation skills once the engine or beat type is known: per-engine prompt rules, physical-action beats (first/last frame, decomposition), realistic people and keyframe images, native audio and one voice across clips. Not for direct requests."
tags:
  - generation
  - reference
---

# Video generation craft

Reference material for the creation skills (`ugc-product-video`, `generic-video`, `music-video-creation`, `mimic-video`, `stitching-multi-clip`). They have already gated on a provider and chosen the workflow; this skill only says how to make the generation itself good. `ai-asset-generation` owns the call, cost disclosure and import; `using-storyboard` owns the card and take workflow. Read only the reference the situation needs. Read `references/providers/<id>.md` for the provider you use before your first provider call; it names the endpoint ids, input names and tools.

| Situation | Read |
| --- | --- |
| About to write a video prompt for an engine | `references/engines/seedance.md`, `veo.md` or `kling.md` |
| A beat where a person handles an object (apply, peel, press, pour, grip, twist, write, cut) | `references/physical-action.md` |
| A realistic person, creator portrait, character or product reference, or a start/end keyframe | `references/realistic-images.md` |
| Any decision about audio or voice on generated video, or one voice across several clips | `references/voice.md` |

## Rules that hold everywhere

- **Verify the engine at runtime.** Endpoint ids, input names, limits and prices in these files are hints: confirm them with the provider's schema and pricing tools before submitting, and never submit to an id you have not confirmed or invent a tier or variant.
- **First/last-frame input names differ per engine and per endpoint** (`first_frame_url`/`last_frame_url`, `start_image_url`/`end_image_url`, a bare `end_image_url`). There is no universal name; use the spelling in the schema you are about to call. A wrong name drops both keyframes silently. The table is in the provider reference.
- **Native audio stays on** for engines that have it, and one voice across clips is carried by reference, never by muting clips and laying a synthesized track. `references/voice.md` owns this.
- **No readable text inside generated video.** `ai-asset-generation` owns the rule and how text is added afterwards as an overlay; engine guides only note where their model differs.
- **Image first.** The start frame sets everything an image-to-video or first/last-frame call can do, so a flawed still guarantees a flawed clip. View it before spending on the clip.
- **A different voice on a finished video** (clone, new narrator, dub) is the `voice-replacement` skill, started by the user after the video exists. It is not generation.
