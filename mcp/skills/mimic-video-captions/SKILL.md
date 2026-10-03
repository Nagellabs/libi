---
name: mimic-video-captions
description: "Reproduce the on-screen captions of an existing video onto a piece: lyric typography, kinetic text, road or perspective captions, glowing subtitles ('add the same captions', 'copy how the words animate'). Also entered from mimic-video. Not for recreating the video itself (mimic-video) or plain speech subtitles (speech-captions)."
tags:
  - overlays
  - recreate
  - captions
---

# Mimic On-Screen Captions

Done looks like: the piece's captions say the source's exact words at the right times and look and move like the source's, and you have rendered frames and looked at them to prove it. A caption is its motion and style on the footage, not just its words, so a faithful reproduction needs three things from two sources, then a verify loop.

## Words and look come from different sources

The video model sees the visual treatment but mis-reads words and timing; the transcript has exact words and word-level timing but says nothing about look. Cross them and the captions read wrong or animate wrong.

- **Words and timing: the transcript.** Run `audio-analysis` (local Whisper), using the medium model for non-English or sung lyrics. Transcribe even a "music-only" lyric reel: the captions are those words. Never take words from the visual analysis.
- **Look and motion: a caption-focused analysis** that watches the whole video and returns, per caption, its anchor (world: locked in the scene and drifting or growing with the camera, or screen: fixed, scaling or fading), keyframes (centre cx, cy and height as a 0 to 1 fraction of frame height), reveal schedule (all at once or progressive), orientation (billboard, ground-tilted, roadside wall, with degrees), and colour, glow and weight. Never take look from the transcript.

## The caption-focused analysis is paid: ask first

It is the biggest quality lever, so recommend it, but it runs on a video-understanding model on your provider, libi shows no approval card for it, and it spends the user's credits. Before running it, name the model, give the per-second price from the provider's pricing tool, and get a yes. Say what you would run and what it costs even when no source file is loaded yet. The call and the exact flow (the caption-spec prompt, saving the result under `summary.custom.caption_spec` with `libi.analysis_save` action `summary_custom`, which needs a `summary` step to exist first) are in the `video-analysis` skill and its provider reference.

If the user declines, fall back to the free path: sample a few frames across one caption's on-screen window with `libi.analysis_extract` action `frames` (never `libi.generate_thumbnails`, which leaves throwaway JPGs in the piece's assets) and view them. It is rougher, because a still freezes the animation and you will under-call the motion.

## Flat by default, 3D only when the source is

A static frame cannot tell a centred scale-punch (2D) from a 3D dolly toward the camera, so do not infer 3D from stills. Reproduce a caption in 3D only when the source genuinely shows depth (text laid on a road or floor, world-anchored lyrics that recede with the footage) or the user asks. With the caption-focused analysis, its `anchor` and `orientation` decide: world plus roadside-wall or ground-tilted is 3D; screen plus billboard is flat 2D. Without it and genuinely unsure, default to flat; ask the user ("flat 2D or 3D animated?") only when the source plausibly reads as a real road or perspective look and the answer changes the result.

Route each caption:
- **Text mapped onto road or floor geometry, receding or growing with the footage**: `three-overlays` (a real `three` overlay). A caption that only looks 3D but is not footage-mapped is a text overlay with `place3d: true`, not a `three` overlay.
- **Flat kinetic 2D** (typewriter, word by word, pop, slide, glow): a declarative text overlay with a `reveal` first, via `speech-captions` or `animated-text-overlays`, plus `libi.layer_effect` action `apply` for entrance, exit and loop motion. Escalate to a code overlay only for motion those cannot express (per-word colour cycling, beat-synced bursts, position morphing), and write the declarative version first to lock the timing.
- **Plain synced subtitle**: `speech-captions`.

Captions are overlays added in post, never baked into a generated clip.

## Time, style and size each caption

Place each caption at its word or line's real transcript timestamp, peak-aligned to the vocal onset with no global lead offset. Match the source's colour, weight, position and glow rather than a generic subtitle look. Size and position from the analysis keyframes: at each moment the on-screen centre should be near (cx, cy) and the height near its height fraction of the frame; if those change across keyframes, animate so it visibly moves or recedes. **Never exceed the given height fraction**: most captions are small (0.04 to 0.15), and exceeding it is what pushes text out of frame.

## Verify by rendering

You build blind otherwise. After each caption or small batch, `libi.render_overlay_frames({ pieceId, overlayId })` (the loop `three-overlays` owns), view the frames, and check them against the source:

- A blank frame on a 3D caption is the geometry footgun (a roadside-wall caption needs a positive `rotation.y` to recede; the wrong sign throws it behind the camera with no error). `three-overlays` has the fix.
- `overflow.touchesEdge: true` means it clips the frame; shrink it. A 3D caption's projected size depends on the camera, so this flag and your eyes are the only guard.
- Wrong position, size or motion against the source: fix it.

Fix a text overlay with `libi.update_overlay`; for a code or three caption edit the file at the `codeFilePath` from `libi.add_overlay` (or `libi.get_overlays`) and the watcher re-renders. Allow about two loops per caption, and if it is still wrong, tell the user what is off rather than thrashing. Do the loop on the hardest captions (world-anchored, receding, or flagged large) at minimum. A caption you did not render and look at is unverified.

## If you decline to display the actual lyrics

Reproducing a recognizable song's lyrics verbatim may carry rights issues, so flag it for the user's own or cleared content. If you decline to put the words in, build the whole scaffold and hand the words to the user rather than dropping the captions:

1. Get timing without the words from `libi.music_detect_beats({ fileId })`, vocal onsets or the appearance times in the analysis. You may reuse the transcript's timestamps; timing is not the copyrighted work.
2. Apply the complete look and animation; style is not encumbered.
3. Put a neutral placeholder at each timed slot matching the source's line rhythm and word count (`LINE 1`, `[lyric]`). Declarative text overlays are already click-to-edit; a code overlay that was genuinely needed holds all its line strings in one labelled array at the top of the draw function.
4. Hand over a per-line map: each caption's start time and where to type its words.

Try the faithful reproduction first, and never deliver a caption-less recreation of a caption-driven video.

Related: `audio-analysis`, `video-analysis`, `three-overlays`, `animated-text-overlays`, `speech-captions`, and `mimic-video`, which hands caption requests here.
