---
name: realistic-image-generation
description: "Generate realistic AI images — especially photoreal people / creator portraits and video KEYFRAMES (start/end frames). Owns the realism model picker (gpt-image-2 default, never let recommend_model downgrade it), the anti-'AI-look' banned tokens + Flux negative prompts, the UGC selfie + demographic templates, the prompt-plausibility (anatomy) pre-check, and the post-generation image-validation rubric. Loaded BY the Storyboard keyframe step / ugc-product-video / generic-video — it produces ONE good image; the board sequences keyframe→clip. NOT a standalone entry point."
when_to_use: Loaded by a creation/storyboard flow when it needs a realistic image — a creator portrait, a character/product reference, or an FLF start/end keyframe — before animating it into a clip. Not triggered directly by user requests.
tags:
  - generation
  - reference
---

# Realistic Image Generation (keyframe + portrait craft)

This is the **image-craft** layer. The Storyboard owns the *workflow* (a card's `keyframe`
tier → its `clip` tier); `ai-asset-generation` owns the *mechanics* (call the model, save the
file). This skill owns the *craft of making the image good* — because the image is the
foundation of the whole video (FLF and i2v only animate the still you give them), so a weak or
wrong keyframe poisons everything downstream. Produce ONE image well; the board decides when and
how it becomes a clip.

Use it whenever the goal is "looks like a real phone photo, not AI" — a fictional creator
portrait (mandatory for `ugc-product-video` Stage 1), a character/product reference, or an FLF
start/end keyframe. Phase 4 round 1 shipped a flux/dev portrait with a generic prompt and the
user flagged it as "doesn't look real" — the fix is both the model and the template.

## Model picker (image gen for realism)

**`openai/gpt-image-2` is the hardened default for any realism image — do NOT let
`recommend_model` OR `search_models` downgrade it.** Image models are the foundation of the whole video
(FLF and i2v only interpolate/animate the still you give them), so a weak or wrong
keyframe poisons everything downstream. gpt-image-2 is the strongest at realism,
prompt-adherence, and — critically — **correct anatomy** (hands, fingers). A weaker
model botched the anatomy in a real run (a nail file rendered passing *through* a
finger), which is exactly why this is not negotiable.

`recommend_model` AND `search_models` optimize for "a model that can do the task" or
"what's newest/trendy," NOT for top realism — on **live fal** both surface
`fal-ai/nano-banana-2` (and Flux variants) at the top for a UGC portrait and never
even mention gpt-image-2. An agent that "preferred the recommendation"/"took the top
search hit" shipped the mangled-hand image, and a real-mode run on 2026-06-06 picked
nano-banana-2 from `search_models` without surfacing gpt-image-2 at all. **Do NOT call
`recommend_model` or `search_models` to CHOOSE the realism image model — you already
know it's `openai/gpt-image-2`. Use the fal tools only to confirm gpt-image-2's live
availability + price (`get_model_schema` / `get_pricing`), never to pick a different
model over it.** Only fall to the alternates below if `get_model_schema` shows
gpt-image-2 is genuinely unavailable on the account.

Order of preference (gpt-image-2 first, always):

1. **`openai/gpt-image-2`** — OpenAI's GPT Image 2, **hosted on fal** (uses your
   fal key — does NOT require a separate `OPENAI_API_KEY`). Strongest realism +
   prompt-adherence + the only model that reliably renders correct anatomy and
   on-image text. There's also `openai/gpt-image-2/edit` (masked inpaint/outpaint)
   for fixing one bad region instead of re-rolling. No negative-prompt field —
   phrase exclusions positively. **This is the default for any realism image — the
   FIRST image-generation call in any UGC/realism flow MUST target `openai/gpt-image-2`;
   pick it without asking `recommend_model` / `search_models` which model to use.**
2. **`fal-ai/nano-banana-2` / `fal-ai/flux-2-pro`** — capable, but weaker prompt-adherence
   and anatomy than gpt-image-2 (nano-banana-2 mangled a hand-with-file macro in QA;
   flux-2-pro produced an anatomically-impossible "palms-out showing fingernails" image).
   Use only if gpt-image-2 is unavailable.
3. **`fal-ai/flux-pro/v1.1-ultra`** with `raw: true` — proven previous-generation
   candid look.

Do NOT use `fal-ai/flux/dev`. Do NOT silently fall back to a weaker model
because a stronger one "might need a key" — check `list_mcp_servers` /
`recommend_model` first; gpt-image-2 runs on the fal key you already have.

**Budget vs. quality — surface it, don't silently downgrade.** The keyframes are
the foundation (FLF/i2v only animate the still you give them), so they're the
highest-leverage place to spend. gpt-image-2 costs more than flux-2-pro. If the
user gave a tight budget, do NOT just quietly pick flux-2-pro — state the choice
in one line ("I'll use gpt-image-2 for the keyframes — strongest realism, ~$X
each; or flux-2-pro to save ~$Y if you'd rather keep it cheap") and let them
decide. Default to gpt-image-2 when budget isn't a stated constraint.

## Banned tokens (remove from any prompt before submit)

These words have been so over-represented in AI-promoted captions that they anchor models toward the plastic "AI look":

```
beautiful, perfect, professional, professional photo, masterpiece, 8k,
hyperrealistic, ultra-detailed, award-winning, stunning, flawless,
studio lighting, golden hour (cliché — now triggers AI aesthetic)
```

If the user's brief contains any of these, paraphrase before building the engineered prompt.

## Negative prompts (Flux models only — supply as a separate field)

```
plastic skin, waxy skin, airbrushed, smooth skin, symmetric face,
perfect teeth, glossy, 3d render, cgi, illustration, painting,
oversaturated, bokeh blur, studio backdrop, professional headshot,
model pose, AI generated, deepfake, instagram filter, beauty filter, HDR
```

`gpt-image-2` doesn't accept negative prompts — for it, phrase every exclusion positively (e.g. "with realistic skin texture and visible pores", not "no plastic skin").

## UGC selfie template

Fill the placeholders from `ugc_settings` / character intake / script context. Output verbatim:

```
Front-camera selfie of a [AGE]-year-old [ETHNICITY] [woman/man] with
[HAIR] hair, [BUILD] build, wearing a [CASUAL OUTFIT — hoodie/tank/
old t-shirt], no makeup, in [SETTING — own kitchen / car driver's seat /
bedroom mirror], [TIME — morning light through window / overhead
kitchen fluorescent / late afternoon], candid expression, mid-sentence,
looking slightly off-camera, arm extended holding phone, slight lens
distortion on nose, visible skin texture, fine pores, no retouching,
faint under-eye shadow, one strand of hair out of place, autoexposure
highlights blown on cheek, slight JPEG compression, amateur framing
subject off-center, vertical 9:16. Shot on iPhone 15 Pro front camera.
Snapshot, not portrait.
```

## Demographic-specific variants

Use these patterns to swap the `[SETTING]` and add demographic-specific cues:

- **Dad-creator:** `[SETTING] = garage workbench, hands dirty`; add `slight stubble, weekend t-shirt, wedding ring on visible hand`.
- **College student:** `[SETTING] = dorm room, fairy lights blurry in background`; add `messy desk visible at edge of frame`.
- **Gym creator:** `[SETTING] = locker room mirror, post-workout flush, slight sweat on hairline`; add `tank top, hair pulled back, phone in hand`.
- **Office worker:** `[SETTING] = car driver's seat, parking lot through windshield`; add `lanyard visible, slight fluorescent reflection on glasses`.

Tune to the character described in the user's intake / script.

## Validation grade rubric (for the resulting image)

When the agent grades the generated portrait:

- **A — passes:** visible pore texture, asymmetric features, candid expression, real-life background, slight imperfection (hair strand, mid-blink, lens distortion). Use as-is.
- **B — minor:** mostly real but one mild "AI tell" (e.g. perfectly aligned teeth, too-smooth jawline). Acceptable; note the tell and proceed.
- **C — reject:** plastic skin, magazine-cover symmetry, studio-headshot background, no imperfections, eyes too sharp. Regenerate.

Auto-regenerate Cs in batch mode (within `batchCap`); ask user per-C in `ask-each` mode.

## MANDATORY — prompt plausibility (before) + image validation (after), for EVERY image

This applies to **every** image you generate (portraits, product shots, FLF
start/end keyframes, reveal seeds — all of them), not just creator portraits.
Skipping it is a skill bug. In QA, a reveal seed was generated from the prompt
*"both hands raised, palms toward the camera, all ten fingernails wearing French
tips"* — which is **anatomically impossible** (you can't see nails when palms
face you), so the model painted nails on the palm side, and the FLF apply
keyframe showed an already-long manicured nail instead of a bare one. Neither
was caught because no validation ran. Two guards:

**A) Pre-generation prompt-plausibility check (before you submit).** Read your
engineered prompt back and ask: *is what I'm describing physically/anatomically
possible to photograph, and internally consistent?* Reject and rewrite if not.
Common traps:
- "palms toward camera" + "showing fingernails" → impossible. Nails show on the
  BACK of the hand. Use "backs of hands toward camera, fingers spread, showing
  the French-tip nails" (or "nails up").
- "bare nail" for an FLF *start* frame, but the prompt also implies an existing
  manicure → the keyframe won't be bare. Be explicit: "completely bare natural
  nail, no polish, no tip."
- Two contradictory states of the same object in one image; impossible
  viewing angles; object counts that fight the framing.

**B) Post-generation validation — run a real analysis, don't just eyeball.**
After the image is saved, do BOTH:
1. **Vision-Read the pixels yourself** against an explicit, asset-specific
   checklist and score A/B/C. The checklist MUST include, for the specific
   thing requested: correct anatomy (hands/fingers/nails on the right side,
   plausible counts, natural proportions/length), the requested object actually
   present and correct, orientation matches the brief, no morphing/fusing, no
   stray text. "Looks nice" is not a pass — verify the *specific* requirement
   (e.g. "is the target nail actually bare?", "are the nails on the back of the
   fingers?").
2. **Persist the check** via `libi.analysis_save_summary` (and
   `libi.analysis_save_frames` for keyframes) — both keyed by `fileId`, no
   `analysis_start` call needed — so there's a real record, not a note. This is
   the same un-fakeable discipline as the video Stage 4.5 gate.
3. **C = regenerate** with a corrected prompt (or use `openai/gpt-image-2/edit`
   to fix one bad region). Loop until A/B. Counts against `batchCap`. A bad
   keyframe is the cheapest thing to fix and the most expensive to ignore — a
   flawed still guarantees a flawed video.

## Related

- `ai-asset-generation` — the call + save mechanics (provider/model/schema/cost/run/import).
  This skill decides WHICH image model + prompt; that one makes the actual call.
- `using-storyboard` — owns the keyframe→clip workflow (a card's `start_frame` is the image
  this skill produces).
- `physical-action-video` — when the keyframe is an FLF start/end frame for a manipulation beat.
- `ugc-craft` — the UGC genre cues the selfie/demographic templates draw on.
