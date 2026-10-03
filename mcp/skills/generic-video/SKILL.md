---
name: generic-video
description: "Make a video that is not a UGC product ad or a music video (vlog, explainer, cinematic, b-roll, timelapse, meme, stylized take) from a fresh brief ('make me a 10s video of X'), or as the build step after mimic-video hands over a source. Not for product ads (ugc-product-video) or music videos (music-video-creation)."
tags:
  - generation
  - recreate
---

# Generic Video Creation

Needs a **video** provider: one in your tool list, or a libi extension (those count). Read the `references/providers/<id>.md` here for the provider you use before your first call. With none, call `libi.suggest_provider({ kind: "video" })` and stop; the full rule is `libi.read_manual({ section: "providers" })`.

Done looks like: a video that matches what the user asked for (or the source they wanted recreated), built through the storyboard, every AI clip checked before it counts, voiced as agreed, with any on-screen text added as overlays and the result verified against the plan before commit.

Two ways in: `mimic-video` hands you a source with its analysis and block plan, or the user gives a fresh brief. Either way, settle the intake, plan, build, verify.

## Intake: ask only what you cannot infer

- **Fidelity** (recreation only): a faithful copy, or a reinterpretation in a new theme or style.
- **Look and feel**: theme, mood, palette, era; pacing (calm, normal, punchy) and cut rhythm.
- **Target duration.**
- **Stitch or fully AI** (recreation only): reuse the source's own clips with AI around them, or regenerate everything. A stitch goes to `stitching-multi-clip`; the rest of this skill covers the fully-AI path.
- **Model**: recommend a default and verify it at runtime with your provider's schema and pricing tools (the provider reference names them). The engine's prompting rules are in `video-generation-craft`.
- **Voice**: the voice-line intake in `ai-asset-generation`, asked once per brief: a spoken line, or no line and then an offer of a music bed (`music-creation`, or the user's own music provider) or ambient only. Native model audio stays on either way.

## Plan, then build through the storyboard

Load `video-planning` and produce the block breakdown before authoring any card. In a recreation, refine the plan `mimic-video` extracted. Then build through `using-storyboard`, for every AI video including a one-clip request; it owns the card, schematic, generation-spec and take mechanics. The mapping that matters here: a card is one generated clip and a beat is a jump cut inside it, so a short video is one card. Group beats into the fewest clips the model's own per-clip max allows (a 30-second video is about two clips, never one per shot); `ugc-product-video` states the reasoning in full. Skip the storyboard only if the user says to.

Set every card's clip and keyframe aspect ratio to the piece's canvas, or in a recreation to the source's actual aspect. The provider does not read the piece, so an unset ratio inherits the model's default.

## Generate and check each clip

Generate through `ai-asset-generation` (call, cost disclosure, import), writing each prompt with the engine guide in `video-generation-craft`. A manipulation beat or a realistic person has its own reference there; read it when the brief needs it.

- **No readable text inside the video.** Titles and captions are overlays added afterwards.
- **Native audio on for every clip**, with a beat's dialogue taken from its card's `voiceover.line`. One voice across several clips: `video-generation-craft`'s voice reference.
- **Validate before a clip counts.** Run each generated clip through `video-analysis` and look at the frames: extra or missing fingers, illegible text, broken physics and off-model drift are failures. Grade each clip and record it as `ugc-product-video`'s validation gate does (the `validation=` entry on the notes lineage line). Regenerate a rejected clip with a prompt aimed at the failure, as a new take on the same card, then `libi.storyboard_take` action `select` so the timeline fills as clips land.

## Audio, text, verify

Layer a music bed (`music-creation`) if the intake called for it; a separate voice-over only when the user opted out of native audio (`video-generation-craft`'s voice reference); captions and titles are overlays (`speech-captions`, `animated-text-overlays`). Clips stay separate overlays, never pre-joined: joining is an export concern. Before committing, read the composition back and confirm the clip count and order, the audio shape and the overlays match the plan, and render and look at the text before telling the user it is done (the manual's "Putting results in front of the user"). Then commit.

Related: `video-planning`, `using-storyboard`, `video-generation-craft`, `ai-asset-generation`, `video-analysis`, `stitching-multi-clip`, `voice-replacement` (changing the voice of an existing video, only when the user asks).
