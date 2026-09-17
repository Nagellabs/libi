---
name: realistic-image-generation
description: "Generate realistic AI images — especially photoreal people / creator portraits and video KEYFRAMES (start/end frames). Owns the realism model picker (strongest realism-and-anatomy model, never let a recommendation tool downgrade it), the anti-'AI-look' banned tokens + negative prompts (provider specifics in `references/providers/fal.md`), the UGC selfie + demographic templates, the prompt-plausibility (anatomy) pre-check, and the post-generation image-validation rubric. Loaded BY the Storyboard keyframe step / ugc-product-video / generic-video — it produces ONE good image; the board sequences keyframe→clip. NOT a standalone entry point."
when_to_use: Loaded by a creation/storyboard flow when it needs a realistic image — a creator portrait, a character/product reference, or an FLF start/end keyframe — before animating it into a clip. Not triggered directly by user requests.
tags:
  - generation
  - reference
---

# Realistic Image Generation (keyframe + portrait craft)

## Provider gate — read this first

You need a **image** provider. libi generates no media itself.

1. **Check your tool list.** If you already have a provider that can do image, use it.
   If this skill ships a reference for it — `references/providers/<id>.md` under this
   skill, where `<id>` is the provider's catalog id (`fal`, `elevenlabs`, `higgsfield`,
   `ace-step`, `kokoro`, `whisper`) — **read that file and follow it**. If there is no
   reference file for your provider, use the provider's own tool docs (its
   `get_model_schema` / `list_models` / equivalent) and keep to the capability and
   constraint rules in this skill. **libi's own extension tools count as a provider**
   for their kind — `libi.generate_music` (music), `libi.generate_speech` (voice),
   `libi.analysis_transcribe_audio` (transcription), `libi.remove_background` (matting,
   not generation). Prefer them by default: they are free and on-device. If one answers
   `needs_install`, follow its install flow (`libi.get_install_plan` / the download
   tools) instead of switching provider.
2. **If you have none** — no remote provider tool and no libi extension for image — call
   `libi.suggest_provider({ kind: "image" })`, tell the user what it showed, and
   **stop**. Do not improvise a provider, do not ask for an API key, and do not fall
   back to a tool that cannot do image.
   If it answers `status: "none"`, there is nothing to connect: everything libi knows of
   for image is already connected or already installed, and its `covered` list names it.
   Do not open anything or ask for a key — use what `covered` names, or, if that
   cannot do what was asked, say plainly what libi cannot do.

`libi.list_providers()` gives you the same picture without putting a card in the chat — use it
for a general "what's connected?". When the user asks about a provider that is not in your tool
list, call `libi.suggest_provider` instead, so the chat shows the buttons to connect it.

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

## Model picker — the rule

**Pick the strongest realism-and-anatomy model your provider has, and
never let a recommendation tool downgrade it.** Image models are the foundation of the
whole video (FLF and i2v only interpolate/animate the still you give them), so a weak or
wrong keyframe poisons everything downstream. What matters, in order: correct anatomy
(hands, fingers), prompt-adherence, skin realism.

- **Your provider reference names the model.** `references/providers/<id>.md` under this
  skill, when this skill ships one for your provider. Read it — it also says which of your
  provider's tools you may use (schema/pricing, to confirm availability) and which you may
  not (recommendation/search, to choose).
- **A provider's "recommend" and "search" tools optimize for capability and novelty, not
  realism.** On a live provider they routinely put a weaker model at the top for a UGC
  portrait. An agent that "preferred the recommendation" shipped a mangled-hand image. Use
  those tools to CONFIRM a model's availability and price, never to pick one.
- **Budget: surface it, don't silently downgrade.** The keyframes are the
  highest-leverage place to spend. If the user gave a tight budget, state the trade in one
  line ("the strong model at ~$X each, or the cheaper one to save ~$Y") and let them decide.
  Default to the strongest when budget isn't a stated constraint.
- **If this skill has no reference for your provider**, read its schema tool for the
  candidate models and pick on anatomy + prompt-adherence; say which you picked and why.

Do NOT silently fall back to a weaker model because a stronger one "might need a key" —
your provider reference (`references/providers/<id>.md`) names the model to confirm, and
your provider's own schema tool tells you whether it is available on this account.

## Banned tokens (remove from any prompt before submit)

These words have been so over-represented in AI-promoted captions that they anchor models toward the plastic "AI look":

```
beautiful, perfect, professional, professional photo, masterpiece, 8k,
hyperrealistic, ultra-detailed, award-winning, stunning, flawless,
studio lighting, golden hour (cliché — now triggers AI aesthetic)
```

If the user's brief contains any of these, paraphrase before building the engineered prompt.

## Negative prompts

Some image models take a separate negative-prompt field and some do not. When yours does,
supply an anti-"AI-look" list — your provider reference has the exact one this skill ships.
When yours does **not** (gpt-image-2 is the notable case), phrase every exclusion
positively: "with realistic skin texture and visible pores", not "no plastic skin". A
negative prompt pasted into a positive field makes the output worse, not better.

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
3. **C = regenerate** with a corrected prompt — or, when the flaw is one localized
   region and your provider has a masked-edit endpoint (see
   `references/providers/<id>.md`), inpaint that region instead of re-rolling the
   whole image. Loop until A/B. Counts against `batchCap`. A bad keyframe is the
   cheapest thing to fix and the most expensive to ignore — a flawed still
   guarantees a flawed video.

## Related

- `ai-asset-generation` — the call + save mechanics (provider/model/schema/cost/run/import).
  This skill decides WHICH image model + prompt; that one makes the actual call.
- `using-storyboard` — owns the keyframe→clip workflow (a card's `start_frame` is the image
  this skill produces).
- `physical-action-video` — when the keyframe is an FLF start/end frame for a manipulation beat.
- `ugc-craft` — the UGC genre cues the selfie/demographic templates draw on.
