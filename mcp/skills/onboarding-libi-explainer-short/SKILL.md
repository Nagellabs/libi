---
name: onboarding-libi-explainer-short
description: "Run ONLY during first-run onboarding when the user clicks \"show me how it works\" (or asks for the libi intro/demo). Builds a short, tasteful explainer piece by importing 2 hosted demo clips (a calm nature shot + a playful animation), layering an animated title, caption, and lower-third on top, then transparently telling the user these clips were pre-made (downloaded, not generated live) and inviting them to start their own video."
when_to_use: "First-run onboarding demo only. Do not use for real user projects."
---

# Onboarding: libi explainer demo

You are giving a brand-new user their first look at libi. Build one short, good-looking
example piece FAST and token-lean, then hand off by capturing what they want to make.

The whole point of the demo is to **show, don't tell**: the user watches real footage
*with sound*, then sees a title, a caption, and a motion-graphic lower-third layer on top
of it — so they immediately grasp libi's model: **editable layers on a timeline, all made
by chatting.**

**Do NOT call any image/video/audio GENERATION tools here** (no `fal-ai` `run_model` /
`submit_job`, no `recommend_model`, no ElevenLabs). The clips are pre-made and the
overlays are declarative. This flow is import + overlays + built-in effects only.

## The two demo clips (fixed — do not substitute)

Both are free-licensed, hosted on stable public CDNs, and — importantly — carry an
**audible** audio track (real-world park ambience, then an orchestral score). Both were
loudness-checked (not just probed for a stream — a silent track is worse than none). The
native audio IS the sound design; do NOT add music.

1. **Nature / real footage** — a sunny green park: `https://download.samplelib.com/mp4/sample-5s.mp4` (~6s, 1080p, ambient outdoor sound)
2. **Animation** — the Big Buck Bunny trailer: `https://download.blender.org/peach/trailer/trailer_480p.mov` (~33s, CC-BY, orchestral score)

The composition is 1920×1080. All rects below are in composition pixels.

## Steps (in order — no generation)

1. **Create the piece:** `libi.create_piece` with name "Welcome to libi".

2. **Import both clips in ONE call:**
   `libi.import_remote_files({ urls: ["https://download.samplelib.com/mp4/sample-5s.mp4", "https://download.blender.org/peach/trailer/trailer_480p.mov"], pieceId: <pieceId>, autoUpload: true })`
   Keep the returned fileIds in order: `natureId` (first), `animId` (second).

3. **Base video layers** (full-frame `fit:"cover"`, native audio kept — omit `rect`):
   - `libi.add_overlay({ pieceId, kind: "video", fileId: natureId, startTime: 0 })` — the calm real-footage opener (~6s).
   - `libi.add_overlay({ pieceId, kind: "video", fileId: animId, startTime: 5, trim: { start: 10, end: 20 } })` — a punchy 10s window of the bunny (the trim skips the logo intro and lands on the iconic meadow shot). This layer runs 5→15s.

   The hard cut at 5s from the calm sunny park to the big cartoon bunny — and the park
   ambience handing off to the orchestral score — is the demo's one "whoa" moment. The
   timing below protects it.

4. **Layer 5 text overlays on top — give EACH its motion.** For every row below: call
   `libi.add_overlay`, keep the returned overlay id, then apply the effect(s) in its last
   column with `libi.apply_layer_effect({ pieceId, layerId: <that overlayId>, phase, effectId, durationMs })`.
   The motion is what makes the demo feel alive — **all five overlays get an effect.**

   | # | kind | content | startTime | duration | rect (x,y,w,h) | z | align/color | effects (apply_layer_effect) |
   |---|---|---|---|---|---|---|---|---|
   | 1 Title | text | `meet libi` | 0.4 | 2.4 | 288, 300, 1344, 200 | 12 | center, white | in `pop` (600ms), out `fade` (400ms) |
   | 2 Tagline | text | `the editor you talk to` | 0.8 | 2.0 | 384, 540, 1152, 110 | 12 | center, white | in `fade` (500ms) |
   | 3 Caption | text | `this caption? just a layer — like everything else here` | 2.8 | 2.1 | 230, 820, 1460, 140 | 13 | center, white | in `fade-words` (word-by-word reveal) |
   | 4 Lower-third | text | `BIG BUCK BUNNY\ndropped in & trimmed — just by asking` | 5.8 | 3.6 | 96, 864, 960, 150 | 13 | left, white | in `wipe` (500ms), out `fade` (400ms) |
   | 5 Closing | text | `your turn.` | 12.2 | 2.8 | 480, 432, 960, 220 | 14 | center, white | in `slide-up-lines` |

   Rect fields are `{ x, y, width, height }`. `phase` is `"in"` or `"out"`; the effect ids
   above are built-in (declarative — never hand-write draw code). `fade-words` and
   `slide-up-lines` are text-reveal effects (they show as `reveal` on the overlay rather
   than `effects.in` — that is expected, not a failure). Only ONE added overlay is ever on
   screen at a time — Title+Tagline share the opening, Caption ends before the 5s cut,
   Lower-third rides the bunny, then a beat of clean footage, then Closing.

5. **Reveal it:** `libi.show_piece({ pieceId })`.

Keep the whole flow minimal — import + 2 base clips + 5 animated text overlays + the
honest summary. No generation, no extra polish passes.

## Required closing message (transparency — do NOT skip)

Say this in chat, in your own warm voice, keeping every honest point below:

- Everything they just watched is a **stack of layers on a timeline** — the clips, the
  title, the caption, that animated lower-third.
- One honest note: those two clips were **pre-made samples you downloaded and dropped in**
  so the demo appears instantly — you did **not** generate them live. In their **own**
  projects you generate footage fresh, which takes a little longer and uses their credits.
- Every layer here is **live and chat-editable** — give one or two trivial example
  commands they can try right now (e.g. *"make the title huge"* or *"move the caption to
  the top"*).
- End by asking **what they want to make first** (paste a product image or describe it),
  with no further text after the question.
