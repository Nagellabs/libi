---
name: mimic-video-captions
description: Reproduce / mimic the ON-SCREEN CAPTIONS of an existing video — lyric typography, kinetic text, road/perspective captions, glowing animated subtitles. Owns the caption-mimic flow — the authoritative words+timing come from the Whisper transcript, the visual treatment + motion from a caption-focused paid analysis, routing each caption to the right renderer (3D/perspective → three-overlays, flat kinetic 2D → animated-text-overlays, plain subtitle → speech-captions), then RENDER and self-correct via the verify loop. Load this when the user wants the source's captions reproduced faithfully — NOT for recreating the video's content (that is mimic-video).
when_to_use: The user wants to reproduce / mimic / copy the ON-SCREEN CAPTIONS or lyric typography of an existing video onto a piece — "add the same captions", "mimic the lyric text", "recreate the floating road captions", "copy how the words animate". Triggers when the captions THEMSELVES are the thing to reproduce. Loaded by mimic-video when it routes a caption-reproduction request here; also a direct entry point.
tags:
  - overlays
  - recreate
  - captions
---

# Mimic On-Screen Captions

The owner of "reproduce the captions of THIS video." A caption is its **motion + style on
the footage**, not just its words — so a faithful reproduction needs THREE things, from TWO
sources, then a **render-verify loop** to prove it:

1. **The exact words + timing** — authoritative from the **Whisper transcript** (`audio-analysis`).
2. **The visual treatment + how it animates** — from a **caption-focused paid analysis**
   (`extra_analysis_model({ focus: "captions" })`), which watches the WHOLE video so it can
   describe motion a per-frame still can't.
3. **The right renderer** for each caption — 3D/perspective vs flat-kinetic-2D vs plain subtitle.

Then you **build → render → look at the pixels → fix** (the verify loop), because the agent
builds blind otherwise and over-scales captions out of frame.

> **Why a dedicated skill.** Reproducing captions is a craft with its own failure modes
> (deciding 2D-vs-3D off frozen stills, mis-reading sung words, over-scaling 3D text out of
> frame, building blind with no render feedback). `mimic-video` stays a thin router; this skill
> owns the caption craft so the router stays clean.

---

## Step 1 — Split the two sources (words vs look). This split is the whole game.

The video model **mis-reads words and timing** but **sees the visual treatment**. The transcript
gives **exact words + word-level timing** but says nothing about look. So:

- **Words + timing → the Whisper transcript.** Invoke `audio-analysis` (Whisper). Use the
  `medium` model for non-English / sung lyrics (per `music-video-creation` Rule 6). Yes —
  transcribe even a "music-only" lyric reel, because **the captions ARE those words**. This is
  the authoritative source for WHAT each caption says and WHEN.
- **Look + motion → the caption-focused analysis (paid, see Step 2).** Never trust the analysis
  for the exact words — only for anchor (world vs screen), keyframes (center + height-fraction),
  orientation, reveal schedule, color/glow.

Never take words from the analysis or look from the transcript. Cross the streams and the
captions read wrong or animate wrong.

## Step 2 — Strongly suggest the caption-focused paid analysis (ask first, disclose cost)

When the user wants to **mimic** captions, the caption-focused analysis is the single biggest
quality lever — it is **strongly recommended**. It is PAID (fal credits, ~$0.002/s of source;
a 20s reel ≈ a few cents). It is a libi-core paid tool with **no automatic approval card**, so
you MUST disclose the cost and **ask for confirmation before calling it** (cooperative approval,
the libi paid-tool convention):

> "To mimic these captions faithfully I'd run a caption-focused analysis — it watches the whole
> video and returns each caption's exact motion (anchor, keyframes, orientation, reveal, color).
> It costs about <X> in fal credits (~$0.002/s). Want me to run it? I can also try from frames
> alone for free, but the result will be rougher."

On **yes**: call
`libi.extra_analysis_model({ fileId, focus: "captions" })`.
The result is a per-caption spec returned as text in `data.captions` (NOT a structured Script —
it lives under a `caption_spec:*` analysis step, separate from any production script, and never
shows in the Script tab). It gives, per caption:
- `text` (use the TRANSCRIPT's words instead — see Step 1),
- `appear_sec`/`exit_sec`,
- `anchor`: **world** (locked in the 3D scene — drifts/recedes/grows as the camera moves) vs
  **screen** (fixed, only scales/fades) — this decides the whole rebuild,
- `keyframes`: time | center cx,cy (0..1) | **height as a FRACTION of frame height** (0..1),
- `reveal`: all-at-once vs progressive (with the per-character schedule),
- `orientation`: billboard / ground-tilted / roadside-wall (+ degrees),
- color hex + glow blur + font weight.

On **no** (declined the cost): fall back to sampling a few frames across ONE caption's window
with **`libi.analysis_extract_frames`** (FREE — frames land in the Frames tab; NEVER
`libi.generate_thumbnails`, which dumps throwaway JPGs into the piece's assets) and read them
with your own Read tool. This is rougher — a still freezes the animation, so you will under-call
motion — but it is free.

## Step 3 — Flat by default; go 3D only when the source clearly is (or the user asks).

Captions are **flat 2D by default**. Only reproduce a caption as 3D when the SOURCE
genuinely shows real depth (text laid on a road/floor, world-anchored lyrics that recede
with the footage) or the user explicitly asks for a 3D look. A static frame freezes the
animation, and a centered scale-punch (2D) and a 3D dolly-toward-camera look **identical
in a still** — so don't infer 3D from a frozen frame alone.

- If you ran the **caption-focused analysis** (Step 2), let its `anchor` + `orientation`
  decide: `world` + roadside-wall/ground-tilted ⇒ **3D**; `screen` + billboard ⇒ **flat 2D**
  (the default).
- If you did NOT (frames only) and the depth is genuinely ambiguous, **default to flat 2D**.
  Only ask the user when the source plausibly reads as a real 3D / road / perspective look
  and the call materially changes the result — frame it as "flat 2D vs 3D animated" and
  wait for the answer before building that caption. Do not reflexively recommend 3D.

Route by the decision (climb the kind ladder — pick the lowest kind that expresses it):
- **3D / perspective** (text genuinely mapped onto road/floor geometry, world-anchored lyrics
  that recede/grow WITH the footage) → **`three-overlays`** (real WebGL `three` overlays). Note:
  a caption that merely LOOKS 3D but isn't footage-mapped is `kind:"text"` + `place3d:true`
  (set via `update_overlay`), NOT a `three` overlay — reserve `three` for perspective-on-geometry.
- **Flat kinetic 2D** (typewriter, word-by-word, pop, slide, glowing flat text) → **DECLARATIVE
  `kind:"text"` + a `reveal:{ mode }` FIRST** via `speech-captions` / `animated-text-overlays`,
  layering `libi.apply_layer_effect` for entrance/exit/loop motion. Escalate to a `code` overlay
  ONLY for motion the declarative reveal modes + effects genuinely can't express (per-word color
  cycling, beat-synced bursts, smooth position morphing). Even then, write the declarative version
  first to lock timing before swapping in code.
- **Plain synced subtitle** (one line at a time, no kinetic treatment) → **`speech-captions`**.

Captions are **text / code / three overlays added in post** — never baked into a generated clip.

## Step 4 — Time + style each caption from the two sources

For each caption:
1. **Time** it to the transcript: place it at the word/line's real timestamp, peak-aligned to the
   vocal onset (`music-video-creation` Rule 5 — no global lead offset).
2. **Style** it to match the source: color, font weight, position, glow from the analysis (or the
   frames). Don't default to a generic subtitle look.
3. **Size + place** from the analysis keyframes: drive the overlay so at each moment its on-screen
   center ≈ (cx,cy) and its height ≈ height_fraction × frame_height. If center/height change across
   keyframes, ANIMATE so it visibly moves/recedes. **HARD RULE: never exceed the given
   height-fraction** — this is what keeps the text in frame (most captions are SMALL, 0.04–0.15).

## Step 5 — VERIFY LOOP (mandatory): build → render → look → fix

The agent builds blind. After adding each caption (or a small batch), **prove it** with the
render-verify loop **owned by `three-overlays`** (it applies to any 3D overlay; captions are one
use):

1. `libi.render_overlay_frames({ pieceId, overlayId })` — rasterizes a few real composition
   frames (base video + your overlay) to PNGs on disk and returns their paths + an `overflow`
   flag per frame.
2. **Read the returned PNG paths with your Read tool** (it opens them as images — the proven
   `analysis_extract_frames` pattern). LOOK at them.
3. Check, against the source/intent:
   - **Blank frame** ⇒ the 3D **yaw-sign / behind-camera footgun** — fix the geometry (a
     roadside-wall caption needs POSITIVE `rotation.y` to recede toward −z; the wrong sign throws
     the word behind the camera and it renders blank with no error).
   - **`overflow.touchesEdge: true`** ⇒ the caption is clipping the frame — shrink it. (3D text
     can't be statically clamped — its projected size depends on the camera — so this detector +
     your eyes are the only guard.)
   - **Wrong position / size / motion** vs the source ⇒ fix.
4. Fix by **editing the overlay's code file directly** — the `scene.jsx` (3D) or `draw.jsx` (2D)
   at the `codeFilePath` returned by `add_overlay` (rediscover via `get_overlays`); the watcher
   re-renders the preview. Then re-verify. Cap ~2 loops per caption — if still wrong after two,
   tell the user what's off rather than thrashing.

A caption you didn't render and look at is unverified. Do the loop on at least the hardest
captions (the world-anchored / receding ones), and always on any the analysis flagged as large.

---

## Copyright fallback — if you decline to transcribe / display the actual lyrics, DON'T drop the captions

Build the full caption SCAFFOLD and hand the words to the user:
1. **Timing without the words.** Get caption times from `libi.music_detect_beats({ fileId })`,
   vocal-onset timing, or the on-screen appearance times the analysis recorded. (You MAY reuse a
   Whisper transcript's **timestamps** — timing is not the copyrighted work — while NOT rendering
   the lyric words.)
2. **Full design.** Apply the complete style + effect (color, glow, position, kinetic animation) —
   the look is not copyright-encumbered.
3. **Placeholder text, trivially swappable.** Put a neutral placeholder at each timed slot matching
   the source's line/phrase rhythm + word count (`LINE 1`, `● ● ●`, `[lyric]`). For ordinary
   kinetic captions this is declarative `kind:"text"` overlays — the words are already
   click-to-edit in Preview. Only when the caption genuinely required a `code` overlay (motion the
   reveal modes + effects couldn't express), hold ALL line strings in ONE labelled array at the TOP
   of the draw function (`const LINES = ["LINE 1", …]`) so they stay easy to replace.
4. **Hand off with a per-line map** — each caption's start time + where to type its words.

Try the faithful reproduction FIRST; fall to this scaffold only when reproducing the actual words
is declined. Never deliver a caption-less recreation of a caption-driven video.

Licensing caveat: reproducing a recognizable song's lyrics verbatim may carry rights issues — flag
it (as with a reused music bed) for the user's own / cleared content.

## Cross-skill references
- `audio-analysis` — Whisper transcript (authoritative words + word-level timing).
- `video-analysis` — documents `extra_analysis_model({ focus: "captions" })` (the paid
  caption-spec mode this skill drives).
- `three-overlays` — real 3D / perspective captions + the build→render→inspect→fix verify loop.
- `animated-text-overlays` — flat kinetic 2D caption effects (code overlays).
- `speech-captions` — plain transcript-synced subtitles.
- `mimic-video` — the video-content recreate router; hands caption-reproduction requests here.
