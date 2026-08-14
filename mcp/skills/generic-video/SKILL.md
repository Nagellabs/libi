---
name: generic-video
description: Create a genre-agnostic AI video — either recreating a source (handed over by mimic-video) or from a fresh brief. Owns the creative intake (fidelity, theme/style, pacing, duration, stitch-vs-fully-AI, model, voice) and the build flow. References ugc-craft for prompt craft, ai-video-models for per-engine rules, ai-asset-generation for mechanics.
when_to_use: User wants to create or recreate a video that is NOT specifically a UGC/product ad or a music video — a vlog, explainer, cinematic, b-roll, timelapse, meme, stylized reinterpretation, etc. Invoked directly ("make me a 10s video of X") or handed a source by mimic-video.
tags:
  - generation
  - recreate
---

# Generic Video Creation

Genre-agnostic AI video creation. Two entry modes: (a) `mimic-video` handed you a source +
analysis to recreate; (b) a direct from-scratch brief. Either way: run the intake, then build.

**Load by reference (never duplicate):**
- `video-planning` — the senior-editor planning/director layer: decompose the source/brief into
  building blocks (source-vs-AI, combine-vs-split, style inheritance) BEFORE building cards. Owns
  Step 3's beat plan.
- `ugc-craft` — the 9-layer prompt formula, the **clip-duration methodology (≤15s one
  multi-beat clip; do NOT fragment a short ad into many 3–6s clips)**, realism cues, negative
  lists.
- `ai-video-models` — the per-engine prompting guide for your chosen model.
- `ai-asset-generation` — the call + save mechanics (recommend_model / schema / pricing / polling /
  import) and the universal video invariants (**no in-video text**; **native audio on**).
- `realistic-image-generation` — the keyframe / portrait image craft (gpt-image-2 default).
- `physical-action-video` — manipulation-beat craft (FLF-first, decomposition, model ladder) when
  a beat physically manipulates an object.
- `voiceover-production` — the generation-time audio/voice authority (native audio always; multi-clip voice carry).
- `voice-replacement` — re-voice / dub an EXISTING video (clone or new voice + lip-sync); user-triggered, only when asked.

## The Storyboard is the build spine (default — not optional)

You build the video **through the Storyboard** — it is the mechanism, not an optional planning
step. Invoke **`using-storyboard`** and follow it; this skill owns the genre-agnostic *intake*
(below) and hands the beat plan to the board to realize. This is the default for **every** AI
video, including a single-clip request.

**Card = a generated clip = a timeline scene. A beat is a jump-cut INSIDE a card.** So a single
≤15s one-shot is **ONE card** (do NOT make one card per beat); a 30s video is ~2 cards; an
extend chain is ONE card (the extend versions are its takes); a multi-clip / stitch is N cards
(link consecutive cards with `set_storyboard_reference` `reference_video` for continuity). For
each card: author its schematic (free blocking review) → its generation spec (keyframe + clip
params, carrying any consistency reference) → `libi.show_storyboard` → schematic approval (free
pre-spend gate) → generate the take → validate (Step 5) → `libi.select_storyboard_take` to place
the scene. Placement-by-select-take fills the timeline as each card lands.

**Opt-off is a rare, explicit user exception** — ONLY if the user directly says "skip the
storyboard / just generate" do you drop to direct generation + `libi.add_overlay({ kind: "video" })`. Never
your default; never offered proactively.

## Step 1 — Intake (ASK; do not assume)
Skip any the user already answered:
1. **Fidelity** (recreate mode only) — faithful copy vs reinterpret (new theme/style)?
2. **Theme / style** — look, mood, palette, era.
3. **Speed / pacing** — calm / normal / punchy; cut rhythm.
4. **Target duration.**
5. **Stitch vs fully-AI** — reuse the original's clips, or regenerate everything with AI?
6. **Model** — recommend a default, verify via `ai-asset-generation` (`recommend_model` →
   `get_model_schema` → `get_pricing`), then read its guide in `ai-video-models`.
7. **Voice / audio** — default ON (native model audio, per `ai-asset-generation`); confirm.

## Step 2 — Branch on stitch-vs-fully-AI
- **Stitch** → hand to `stitching-multi-clip` (reuse the source's segments as separate scenes).
- **Fully-AI** → continue.

## Step 3 — Plan first via `video-planning` (living)
**Load `video-planning` and produce the block breakdown before authoring cards.** Recreate mode:
reverse-engineer the source's build algorithm into building blocks (or refine the plan
`mimic-video` already extracted). Direct mode: decompose the brief into blocks. For each block
decide source-vs-AI, combine-vs-split, and style inheritance, then present the plan for the free
pre-spend review and capture the editorial intent in the storyboard **overview**. Keep it a LIVING
plan you update as beats land / re-roll. Honor the ≤15s one-clip rule from `ugc-craft` — a 30s
video is ~2 clips, not 7. The blocks map 1:1 to storyboard cards (Step 4).

## Step 4 — Generate (per card)
Each clip is a Storyboard **card's take**. Compose its prompt using the chosen engine's guide
(`ai-video-models`) + `ugc-craft` craft, then generate via `ai-asset-generation`. **No in-video
text** — captions are overlays (Step 7). Voice: default `generate_audio=true` for beats with
spoken lines. After Step 5 validation, `libi.attach_storyboard_clip` the take to its card and
`libi.select_storyboard_take` to place the scene (a regen is a new take on the same card).

## Step 5 — Validate every clip
Invoke `video-analysis` on each generated clip; grade for AI-failure modes (extra/missing
fingers, illegible text, broken physics, off-model drift); record severity; branch
ok / minor / reject (regenerate rejects with a targeted prompt patch).

## Step 6 — Audio
Scenes are already placed incrementally via `libi.select_storyboard_take` (Step 4) — one SEPARATE
scene per card, never pre-concatenated (the editor smooths seams; concatenation is FINAL-EXPORT
only). Apply the audio plan here: native voice from generation; add a music bed / VO via
`ai-asset-generation` if wanted.

## Step 7 — Captions / overlays + verify-before-commit
Add on-screen text as overlays (never baked into the video). Before committing, read the
composition back and confirm scene count/order, audio shape, and overlays match the plan; then
commit.

## Cross-skill references
- `video-planning` (the planning/director layer that produces the block plan — Step 3),
  `using-storyboard` (the build spine — schematic + generation-spec + take/select mechanics),
  `ugc-craft`, `ai-video-models`, `ai-asset-generation`, `video-analysis`,
  `stitching-multi-clip`, `using-snapshot-draft`.
