---
name: mimic-video
description: "Recreate, copy or remake an existing video with AI: 'make one like this', 'the same video but shorter or in another style', 'do this again'. Analyzes the source and hands off to the right creation skill; generates nothing itself. Not for copying only the on-screen captions (mimic-video-captions)."
tags:
  - generation
  - recreate
---

# Mimic / Recreate Video (dispatcher)

The front door for "recreate this video". Done looks like: the source is analyzed, classified, turned into a block plan the user has seen, and handed to the creation skill that owns the craft, with the flags below. **This skill generates nothing.** Recreating by feeding `video-analysis` output straight into generation is the failure it exists to prevent: it loses the source's structure.

## Flow

1. **Locate the source** (the user's attachment or a file on the piece) and check for an existing analysis with `libi.analysis_query` action `get`.
2. **Analyze if needed.** Use the `video-analysis` skill (keyframes, per-frame vision, summary), and `audio-analysis` for a transcript when the source has meaningful speech or on-screen captions or lyrics you will reproduce (a lyric reel is "music-only" but its captions are the words). Skip the transcript only for a silent, caption-free clip. Have the analysis capture any on-screen text: wording, position, colour and font, and how it animates. Reuse an analysis that already exists; do not redo it here.
3. **Classify and recommend one creation skill**, and let the user pick or override; when it is genuinely ambiguous, offer two:
   - a person showing or using a product (retail packaging, a demo): `ugc-product-video`
   - a song drives the structure, lyrics on screen: `music-video-creation`
   - anything else (vlog, explainer, cinematic, b-roll, timelapse, meme, stylized): `generic-video`
4. **Extract the build plan.** Load `video-planning` and reverse-engineer the source's build algorithm into a block breakdown (not a shot transcription). State the classification with a one-line reason, present the plan, and confirm before handing off.
5. **Hand off** to the chosen skill with: the source `fileId` and its analysis, the block plan, the user's intent (faithful copy or reinterpretation, if stated), the target duration if known, and the flags below. The sub-skill runs its own intake, refines the plan and builds; your job ends at the hand-off.

**Load the sub-skills before you present any plan.** If the user wants to see a plan before generation, first load `video-planning`, the chosen creation skill and, whenever source footage will be reused, `stitching-multi-clip`, and the voice reference in `video-generation-craft`. A plan drafted from general knowledge at the router gets two things wrong every time: it lays the source audio under the AI clip as a separate track instead of carrying the voice by reference, and it fragments the source's shots into several short clips instead of a few full-length ones. The plan the user approves must already be the sub-skill's plan.

## Constraints and flags

- **Match the source's orientation, not the platform's stereotype.** Read the actual frame dimensions from the analysis (or ffprobe) and carry them into the plan and every card's `aspect_ratio`. A 1920x1080 source is landscape even when it came from a platform where vertical is typical. A recreation in the wrong orientation is unfaithful however good the rest is.
- **Clip count.** A recreation reproduces the source's content and pacing, not one clip per source shot: ask the sub-skill to group shots into the fewest full-length multi-beat clips, one card per clip.
- **Stitch variations.** If the user wants variations of a source ad (new character, new speech, new hook), do not plan the partition here. Flag the intent; `stitching-multi-clip` owns the partition, the voice question and the continuity check, and the sub-skill loads it before drafting beats, intake questions or the character.
- **Voice.** The recreation should reproduce the source's voice, never default to a silent version of a talking video. The sub-skill asks reuse-versus-fresh voice (`video-generation-craft`'s voice reference); changing the voice is the separate `voice-replacement` skill.
- **Music.** If the source is carried by music, the bed is a building block with a reuse-versus-generate decision owned by `music-creation`: reuse the original track (`libi.extract_audio`, attached under the new visuals) or generate a new one in the same vibe. Surface the choice; do not silently go silent or auto-generate a replacement. Reuse is the sensible default for a faithful recreate.
- **Captions and lyrics.** If reproducing the source's on-screen captions is part of the recreate, do not build or approximate them here: flag it and load `mimic-video-captions`, which owns the flow.

Creation skills also work on their own for a direct "make a UGC ad" or "make a music video"; this skill is specifically the recreate-an-existing-video entry. Stitch-versus-fully-AI is the creation skill's intake question, not yours; you route by genre only.

Related: `video-analysis`, `audio-analysis`, `ugc-product-video`, `music-video-creation`, `generic-video`, `mimic-video-captions`, and for the captions it hands over, `speech-captions`, `animated-text-overlays`, `three-overlays`.
