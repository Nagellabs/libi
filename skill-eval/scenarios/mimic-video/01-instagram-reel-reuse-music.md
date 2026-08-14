---
id: mimic-video-instagram-reel-reuse-music
title: Mimic an Instagram reel — download, analyze, plan, storyboard, reuse original music, generate
skills: [mimic-video, video-planning, video-analysis, audio-analysis, using-storyboard, generic-video, ugc-product-video, music-video-creation, music-creation, ugc-craft, ai-asset-generation, ai-video-models, realistic-image-generation, physical-action-video, voiceover-production, stitching-multi-clip, speech-captions, animated-text-overlays, using-asset-folders, using-snapshot-draft, using-character-library]
mcps: [YouTube Downloader, Whisper (local STT), fal-ai, ElevenLabs, Local TTS (Kokoro), Local Music (ACE-Step)]
agent: claude-code
runs: 1
# HEAVY FULL-BUILD over a LIVE network source. The agent must: download a real Instagram
# reel (yt-dlp), analyze it (frames + transcript + identify the music), plan it as building
# blocks (video-planning), build it through the Storyboard with sketched keyframes, REUSE the
# original music track (extract + attach — the music-creation Stage 0.5 reuse path), and
# generate the clips via fake-fal. Expected wall-clock 25-45 min; whisper bootstraps its model
# in the hermetic temp home (network) and each fake-fal video placeholder is a real ~1-2 min
# ffmpeg encode, so a TIMEOUT here is a hardware/network artifact, NOT a skill regression.
# On TIMEOUT, JUDGE FROM THE PARTIAL transcript + the kept LIBI_HOME artifacts (storyboard
# JSON, analysis record, fal-calls.jsonl): the download, analysis, plan, storyboard cards,
# sketches, music decision, and the generation PROMPTS are all authored before the slow tail.
# Run with --keep to retain the temp LIBI_HOME for inspection. This scenario hits a live
# Instagram URL and is therefore NOT a deterministic regression guard — it is a manual
# validation harness for the mimic + video-planning + music-reuse path.
timeoutSec: 3000
covers: [mimic-video, video-planning, music-reuse, storyboard-spine, sketches, no-fragmentation, source-download]
---

## Prompt
Mimic this video for me: https://www.instagram.com/reel/DYKWOATvOkc/

Download it, analyze what it actually is (the shots, the structure, and the music), then think
like a senior editor and reverse-engineer the build algorithm into a plan. Build the recreation
through the storyboard with a sketched keyframe per card. For the music, use the ORIGINAL
soundtrack from the reel (keep that exact track) rather than generating a new one. Then generate
the clips. Match the original's format (orientation + aspect ratio) and pacing — don't fragment it
into a pile of tiny per-shot clips.

## Hard invariants
```yaml
assertions:
  # Anti-fragmentation: a ~19s reel must group into the fewest model-max clips, not one per shot.
  - { tool: run_model, endpoint_id: "*video*", count: "<=5" }
```

## Behavioral expectations
1. **Downloaded the source** — used the YouTube Downloader (yt-dlp) to fetch the reel and imported
   it into the piece via `libi.upload_file`. No fabricated content; the build is grounded in the
   actual downloaded file.
2. **Analyzed before building** — ran `video-analysis` (frames + summary) and `audio-analysis`
   (transcript) on the source, and **identified the music** (it reasoned about the track / its
   role), rather than jumping straight to generation.
3. **Loaded the right skills, in order** — `mimic-video` (dispatcher) → `video-analysis` /
   `audio-analysis` → `video-planning` (the senior-editor plan) → a creation sub-skill →
   `using-storyboard`. The plan is authored with the planning/craft skills loaded, not from
   general knowledge (the mimic HARD-GATE).
4. **Presented a building-block plan before spending** — an ordered breakdown (content,
   source-vs-AI, combine-vs-split, style inheritance) reverse-engineered from the source.
5. **Storyboard is the backbone** — built the recreation as `libi.add_storyboard_card` per block
   with a **sketched keyframe schematic** per card, then generated through the board
   (schematic → spec → take). It did NOT generate clips outside the storyboard.
6. **Reused the original music** — extracted the source audio (`libi.extract_audio`) and attached
   it under the visuals (`libi.audio_add_clip`), exercising the `music-creation` Stage 0.5 reuse
   path. It did NOT generate a new track, and did NOT leave the recreation silent.
7. **Generation prompts make sense** — the image/video prompts sent to fal describe the subjects,
   look, and motion that the analysis found in the source (the recreation is faithful to what the
   reel actually is), and no on-screen caption text is baked into a generated clip (captions, if
   any, are text overlays).
8. **No errors** — the run completed (or progressed) without tool failures, validation rejections,
   or the agent getting stuck.
