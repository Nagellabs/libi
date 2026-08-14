---
name: mimic-video
description: Top-level dispatcher for recreating / mimicking an existing video. Analyzes the source (via video-analysis), classifies it, and routes to the right creation skill — ugc-product-video for product ads, music-video-creation for music videos, generic-video otherwise. Generates nothing itself; it picks the path and hands off.
when_to_use: User wants to recreate / mimic / copy / remake an existing video, or "make one like this", "the same video but shorter / in a different style", "do this video again with AI". Triggers whenever a source video is the thing to reproduce.
tags:
  - generation
  - recreate
---

# Mimic / Recreate Video (dispatcher)

The FRONT DOOR for "recreate this video." A thin router: understand the source, then hand off
to the creation skill that owns the craft. **Generate nothing here.** Do NOT fall back to
generating clips directly from `video-analysis` output — that is the exact failure this skill
exists to prevent.

## Step 1 — Locate the source + any existing analysis
Identify the source file (the user's attachment / a file on the piece). Call `libi.analysis_get`
(or inspect the piece) to see whether an analysis already exists.

## Step 2 — Ensure analysis (reuse or run)
If no analysis exists, **invoke the `video-analysis` skill** to analyze the source (keyframes +
per-frame vision + summary), and `audio-analysis` for the transcript when the source has
meaningful speech **OR on-screen captions / lyrics you intend to reproduce** (see the "Captions"
note below — for a lyric/kinetic-caption reel you DO transcribe, even though it's "music-only",
because the captions ARE the words). Skip the transcript only for a truly silent / caption-free
b-roll clip. While analyzing, have `video-analysis` capture any **on-screen text** it sees — the
caption wording, position, color/font, glow, and how it animates — that is the style spec you
reproduce. If an analysis already exists, reuse it. Do NOT re-implement analysis here.

## Step 3 — Classify + extract the build plan
From the analysis, do TWO things:

**(a) Classify + recommend one sub-skill** — present the options and let the user pick / override.
When genuinely ambiguous, surface two and ask.
- **product / UGC ad** (a person showing or using a product, retail packaging, a demo) →
  `ugc-product-video`
- **music video** (a song drives the structure / lyrics on screen) → `music-video-creation`
- **anything else** (vlog, explainer, cinematic, b-roll, timelapse, meme, stylized clip, …) →
  `generic-video`

**(b) Extract the build plan** — load **`video-planning`** and reverse-engineer the source's
**build algorithm** into a block breakdown (the building blocks, each block's source-vs-AI decision,
combine-vs-split, and style inheritance). This is the senior-editor reading of the video — NOT a
shot transcription. The plan is what makes a recreation faithful to the source's *structure*, not
just its content. (This is exactly the "author the plan with the right skills loaded first" the
HARD-GATE below demands — `video-planning` IS that skill, so loading it here satisfies the gate.)

State the classification + a one-line why, present the extracted block plan, and confirm before
handing off.

## Step 4 — Hand off
Invoke the chosen creation skill and pass it: the source `fileId` + its analysis, **the extracted
block plan from Step 3(b)**, the user's recreate intent (faithful copy vs reinterpret, if stated),
and the target duration if known. The sub-skill runs its OWN intake (model, stitch-vs-fully-AI,
voice, etc.), refines the plan via `video-planning`, and does the creation. Your job ends at the
hand-off.

**HARD GATE — author the plan only with the planning/craft skills loaded, never from general
knowledge.** The block plan is authored by **`video-planning`** (Step 3b); the beat / shot / voice
*craft* is owned by the creation sub-skill. If the user wants to see or approve a plan *before*
generation (e.g. they say "analyze first"), you MUST **load `video-planning`, the chosen creation
sub-skill, `voiceover-production`, AND — whenever any source footage will be reused (a stitch) —
`stitching-multi-clip` first**, then let THOSE skills' rules author the plan you present. Do NOT
draft a beat partition or an audio/voice plan from general knowledge at the router level and hand it
off afterward. A plan authored before those skills are loaded gets two things wrong every time:
- **Voice mechanism** — it invents "lay the source audio under the AI clip as a separate track"
  instead of the prescribed `reference-to-video` `@Audio1` carry (`generate_audio: true`). That is
  the mute-and-overlay anti-pattern `voiceover-production` exists to stop.
- **Clip granularity** — it fragments a contiguous faceless run into several short inserts (8s+4s+3s)
  instead of ONE model-max multi-beat clip (≤15s with in-prompt jump cuts).

Load the sub-skills first, plan second — every time. The plan the user approves must already be the
sub-skill's plan, not one you'll "reconcile" after handing off.

## Notes
- **Orientation / aspect (match the SOURCE, not the platform stereotype):** read the source's
  ACTUAL frame dimensions from the analysis (or ffprobe) and recreate in that orientation. A
  1920×1080 source is **landscape 16:9**; a 1080×1920 source is **portrait 9:16** — even when it
  came off Instagram/TikTok/YouTube, where one orientation is *typical* but not guaranteed. Do NOT
  assume "it's a reel, so it's vertical." Carry the source's real aspect into the plan and set every
  card's clip (and keyframe) `aspect_ratio` to it, so the recreation matches the source's shape end
  to end. A landscape source recreated in portrait (or vice-versa) is a faithfulness failure even if
  every other detail is right.
- Sub-skills are independently invokable — a direct "make a UGC ad" / "make a music video" enters
  them without you. You are specifically the *recreate-an-existing-video* entry point.
- Stitch-vs-fully-AI is NOT your decision — each creation sub-skill offers it as an intake branch
  and routes the stitch path to `stitching-multi-clip`. You only route by genre.
- **Clip count (flag this in the hand-off):** a faithful recreation reproduces the source's
  CONTENT + pacing, NOT one clip per source shot. The sub-skill must GROUP the source's shots
  into the fewest model-max multi-beat clips (in-prompt jump cuts) — a ~30s recreation ≈ 2 clips,
  not 8. Never map one source shot to one generation (see `ugc-craft` clip-duration methodology).
  The sub-skill builds these clips THROUGH the storyboard by default (each generated clip = ONE
  card; a beat is a jump-cut INSIDE a card) — so the recreation is N cards = N clips, never one
  card per source shot.
- **Stitch (flag this for product / UGC ads):** if the user wants *variations* of a source ad
  (a new character, new speech, a new hook), **do NOT describe or plan the partition here.** The
  stitch partition, the voice always-ask, AND the physical-continuity gate (the new character must
  MATCH the reused footage's visible body parts — skin tone, age, build) are ALL owned by
  `stitching-multi-clip`, which the creation sub-skill MUST `Skill`-launch **before** drafting the
  beats, the intake questions, or the character. Just flag the variation intent in the hand-off.
- **Audio (flag this in the hand-off):** match the source's audio character — the recreation should
  reproduce the voice, never default to a silent recreation of a talking video. For a stitch, the
  voice runs through the **`stitching-multi-clip` always-ask gate**: ask the user whether to **reuse
  the source voice** (keep a reused beat's VO + sample it for `@Audio1`) or use a **fresh** voice —
  `@Audio1` sync by default; an explicit voice-change is the separate `voice-replacement` skill. Not
  a silent recreation, not an auto-TTS dub. Generation-time voice owned by `voiceover-production`.
- **Music bed (flag this in the hand-off):** if the source is carried by **music** (a song / score,
  not just speech), the music is a building block with a reuse-vs-generate decision owned by
  **`music-creation` Stage 0.5**: ask whether to **reuse the original track** (extract the source
  audio via `libi.extract_audio` and attach it under the new visuals) or **generate a new track in
  the same vibe** (seeded from the original's `music_profile`). Identify the music in the analysis
  and surface this choice — do NOT default to a silent recreation of a music-driven video, and do
  NOT auto-generate a replacement when the user may want the original. Reuse is the sensible default
  for a faithful "same video" recreate.
- **Captions / on-screen text (REPRODUCE them, don't approximate) — load `mimic-video-captions`:**
  if the source has on-screen captions, lyrics, or kinetic typography (e.g. flowing / animated lyric
  text) and reproducing them is part of the recreate, **do NOT build them here and do NOT substitute
  "original hook words" or skip them.** The caption-mimic flow is owned by the dedicated
  **`mimic-video-captions`** skill — `Skill`-launch it and run that flow. It splits the two sources
  (transcript for exact words + timing; a caption-focused paid analysis for the visual treatment +
  motion), decides 2D-vs-3D (asking the user when it can't tell from stills), routes to
  `three-overlays` / `animated-text-overlays` / `speech-captions`, runs the mandatory render-verify
  loop so a caption can't ship out of frame or blank, and owns the lyric-copyright scaffold fallback.
  Flag the caption-reproduction intent in your hand-off / surface it to the user, then hand the
  captions to that skill.

## Cross-skill references
- `video-analysis`, `audio-analysis` (source understanding)
- `ugc-product-video`, `music-video-creation`, `generic-video` (creation targets)
- `mimic-video-captions` (the owner of reproducing the source's on-screen captions / lyric typography — load it when captions are part of the recreate)
- `speech-captions` (transcript-synced subtitles), `animated-text-overlays` (kinetic/flowing 2D caption effects), `three-overlays` (real 3D / perspective captions + simple 3D objects)
