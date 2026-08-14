<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling (ai-asset-generation flow, fal-ai model ids, libi.upload_file). -->

# Feature walkthrough — Seedance 2.0

**Use when:** a person is actively wearing or using the product and speedruns its
features one by one, physically demonstrating each. The vibe is enthusiastic,
informative, fast — an influencer who genuinely loves the thing and is racing
through every reason why.

**Read first:** the Seedance 2.0 platform guide from the **`ai-video-models`** skill
(`model-seedance-2` — platform rules) and [forbidden-words.md](forbidden-words.md). Tone +
pacing + read-aloud timing live in [script-craft.md](script-craft.md) — reference it, don't
duplicate it.

## What defines this style

This is NOT a review — no skepticism arc, no "I was surprised", no before/after.
The person loves the product from frame 1 and the whole clip is a high-energy
feature dump, each beat isolating one feature and proving it on camera.

1. **Show, don't tell.** Every feature claim is backed by a physical action.
   "Hidden pockets" = she reaches into the pocket on camera. "Stretchy waistband"
   = she pulls the elastic. The person never *talks about* a feature — they
   *prove it* with their hands. **No talking-only feature beats.**
2. **Density without overwhelm.** Fast talk, lots of ground, but each beat is
   cleanly separated by a jump cut. A 15s clip covers 1–2 distinct features. For
   products with many features, generate **multiple clips**, each a different
   slice.
3. **First-person embodiment.** The person IS the demo — wearing it, using it,
   living in it while they talk. Camera close, framing personal.

## The 7 layers

```
 1. FORMAT HEADER       — duration, content type, device, lighting, angle
 2. PERSON + PRODUCT    — appearance AND the product they're wearing/using (inseparable)
 3. SETTING             — simple background that doesn't compete
 4. FEATURE BEATS       — one feature per beat: dialogue + physical demo
 5. OVERLAY PLAN        — keyword captions / size / swatches (libi, not in-video)
 6. TONE & PACING       — energy, rhythm, relationship to viewer (→ script-craft.md)
 7. TECHNICAL QUALITY   — camera, lighting, audio
```

---

### Layer 1: Format header

```
15 seconds UGC style {{CONTENT_TYPE}} video, filmed on smartphone, {{LIGHTING_SOURCE}}, {{CAMERA_ANGLE}}.
```

| Variable | Options |
|---|---|
| `CONTENT_TYPE` | product showcase, feature walkthrough, try-on review, gear breakdown |
| `LIGHTING_SOURCE` | natural living-room light, bright overhead apartment light, daylight from large windows, bedroom lamp light — indoor residential, never studio |
| `CAMERA_ANGLE` | casual handheld selfie angle, phone propped at chest height, phone in one hand slightly below eye level — always front-facing, personal |

**Pace constraint:** a natural speaker covers 2–3 short sentences in 15s. This
style is fast, so push to 3–4 short punchy lines — that's the ceiling. Structure
each clip as **one hook + 1–2 feature demos + a kicker.**

**Multi-clip strategy** (product has 4+ features → split across 2–3 clips):

| Clip | Beat 1 (Hook) | Beat 2 (Demo) | Beat 3 (Kicker) |
|---|---|---|---|
| **A: Hero** | "If I could only own one…" | demos the #1 standout feature | reaction — "I'm obsessed" |
| **B: Features** | "Let me show you why this is different" | demos 1–2 secondary features | use case — "perfect for travel" |
| **C: Fit + CTA** | "The fit on this is unreal" | turn-around, pulls fabric, shows sizing | urgency — "go run, sizes selling out" |

---

### Layer 2: Person + product (combined, inseparable)

```
A {{AGE_RANGE}} {{GENDER}} with {{HAIR}}, {{SKIN_DETAILS}}, wearing/holding the @Image1 ({{PRODUCT_DESCRIPTION}}) — {{FIT_OR_USE_DETAILS}}.
```

| Variable | How to fill |
|---|---|
| `AGE_RANGE` | young woman, woman in her late 20s, guy in his mid-20s |
| `HAIR` | long dark hair with soft waves, short curly hair, blonde ponytail |
| `SKIN_DETAILS` | 1–2 reality cues — lighter touch than raw UGC |
| `PRODUCT_DESCRIPTION` | full name + key visual details: color, pattern, material — visually recognizable |
| `FIT_OR_USE_DETAILS` | how it sits / how it's held — relaxed, oversized, fitted, cropped, in-hand |

**Skin detail bank** (pick 1–2): `natural skin with visible texture and warm
undertones` · `light makeup, natural-looking foundation` · `natural complexion,
slight shine on the forehead` · `clean skin with a few expression lines when
smiling`. (Same guard as the UGC formula: texture cues, never acne/blemishes.)

Add a consistency anchor: "the product from @Image1 and the outfit stay unchanged
across all cuts."

---

### Layer 3: Setting

Simple, residential. Says "her real home" without stealing attention.

```
standing in {{SPACE}} — {{DETAIL_1}}, {{DETAIL_2}}, {{ATMOSPHERE}}. The background is slightly out of focus, keeping attention on {{PRONOUN}} and the product.
```

| Setting | Background details | Atmosphere |
|---|---|---|
| **Living room** | couch behind her, neutral walls | bright, open, modern |
| **Bedroom** | bed, pillows, nightstand lamp | cozy, personal |
| **Hallway / entry** | door frame, coat hooks, shoes by the door | casual, on-the-go |
| **Kitchen** | counter, cabinets, morning light | warm, everyday |

Max 2 background details.

---

### Layer 4: Feature beats — the engine

Strict per-beat formula: **one feature = one physical demo + one dialogue line.**

```
{{TRANSITION}} — {{FRAMING_CHANGE}}, {{PRONOUN}} {{PHYSICAL_DEMO}}: "{{DIALOGUE}}"
```

**3-beat structure (15s):**

| Beat | Purpose | What happens | Dialogue | Budget |
|---|---|---|---|---|
| 1 | **Hook** | bold claim, gestures to product | 1 punchy sentence | ~4s |
| 2 | **Feature demo** | physically demonstrates 1–2 features | 1–2 short sentences | ~7s |
| 3 | **Kicker** | quick reaction / verdict / CTA | 1 short line | ~4s |

**Silent-beat option:** one of the three beats can be a silent physical demo (no
dialogue, just action) — a breath in the dense talk. If used, put it at beat 2.

**Physical demonstration bank:**

| Feature type | Physical demo |
|---|---|
| Hidden pockets | reaches in, pulls hand out showing depth |
| Stretch / comfort | pulls the waistband or fabric, shows snap-back |
| Hood / built-in feature | pulls the hood up, shows how it works |
| Softness / material | runs a hand across, bunches it to show texture |
| Fit | turns around, shows the back, pulls at the sides |
| Zipper / closure | zips up/down, shows the fastening |
| Weight / structure | lifts it slightly, lets it drop to show heft |
| One-hand / mechanism (gadgets) | triggers the button/latch, shows the action in one motion |

**Dialogue:** confident, not questioning — she KNOWS it's good; descriptive and
specific (names materials, features, design choices); fast, short, punchy; uses
"this"/"these" (pointing at what she's using); the last beat carries urgency
("go run to", "selling out", "link in bio"). Read-aloud timing per
[script-craft.md](script-craft.md).

---

### Layer 5: Overlay plan — captions / size / swatches (libi, not in-video)

Keyword captions, size references, and color swatches are powerful here — but
they are **libi text overlays added after Stage 4.5**, never burned into the
generated video (see the Seedance 2.0 platform guide in the `ai-video-models` skill /
`ai-asset-generation` Step 6.6).

| Overlay | When | Example |
|---|---|---|
| Keyword caption | during each feature beat | "HIDDEN POCKETS", "ONE-HAND POUR" |
| Size reference | during the fit / turn-around beat | "5'4" / Size: M" |
| Color swatches | during the CTA / closer | options shown as swatches |

Plan which beat each overlay lands on; queue them for `libi.add_overlay({ kind: "text" })`.
The hook and CTA beats almost always get one. Keep the video frame itself
text-free.

---

### Layer 6: Tone & pacing

Pick one persona from the [script-craft.md](script-craft.md) tone bank
(enthusiastic expert / hype / cool recommender all fit this format) and carry it
through. **Mandatory pacing cue** — but for this style the cue is "fast but
clear", not "leave long silences": e.g. "talks quickly but enunciates, moves with
purpose, no fumbling." Even fast formats need an explicit pacing line so the model
doesn't garble the speech.

---

### Layer 7: Technical quality

```
The lighting is {{LIGHT_TYPE}} — {{LIGHT_QUALITY}}.
The image is {{CAMERA_QUALITY}} — {{CAMERA_DETAILS}}.
The sound is {{AUDIO_SOURCE}} — {{AUDIO_DETAILS}}.
```

**Lighting:** bright, even, residential — natural daylight from windows is ideal.
**Camera:** phone quality but steady and well-framed, slightly more polished than
raw UGC. **Audio:** direct phone mic, clear voice, quiet room.

---

## Complete template

```
15 seconds UGC style {{CONTENT_TYPE}} video, filmed on smartphone, {{LIGHTING_SOURCE}},
{{CAMERA_ANGLE}}. A {{AGE_RANGE}} {{GENDER}} with {{HAIR}}, {{SKIN_DETAILS}},
wearing/holding the @Image1 ({{PRODUCT_DESCRIPTION}}) — {{FIT_OR_USE_DETAILS}}; the
product from @Image1 and the outfit stay unchanged across all cuts. Standing in
{{SPACE}} — {{BG_1}}, {{BG_2}}, {{ATMOSPHERE}}, background slightly out of focus.

The video opens with {{PRONOUN}} {{HOOK_ACTION}}: "{{HOOK_LINE}}"

Jump cut — {{BEAT_2_FRAMING}}, {{PRONOUN}} {{BEAT_2_DEMO}}: "{{BEAT_2_DIALOGUE}}"

Jump cut — {{BEAT_3_FRAMING}}, {{PRONOUN}} {{BEAT_3_ACTION}}: "{{KICKER_LINE}}" {{CLOSING_ACTION}}.

Throughout the video, the tone is {{TONE_EMOTIONS}} — {{TONE_BEHAVIOR}}. {{PACING_CUE}}.

The lighting is {{LIGHT_TYPE}} — {{LIGHT_QUALITY}}. The image is {{CAMERA_QUALITY}}
— {{CAMERA_DETAILS}}. The sound is {{AUDIO_SOURCE}} — {{AUDIO_DETAILS}}.

(Keyword caption / size / swatch overlays added later via libi.add_overlay({ kind: "text" }) —
no readable text in the generated video.)
```

---

## Worked example — cordless personal blender (single 15s clip)

```
15 seconds UGC style feature walkthrough video, filmed on smartphone, bright
natural daylight from a large window, casual handheld selfie angle. A woman in her
late 20s with straight blonde hair in a ponytail, natural skin with a slight shine
on the forehead, holding the @Image1 (ZIP Cordless Blender — slim matte sage-green
bottle with a clear base, magnetic charging puck, USB-C port) — bottle in one
hand; the product from @Image1 stays unchanged across all cuts. Standing in her
kitchen — a counter with a fruit bowl behind her, cabinets, warm morning light,
background slightly out of focus.

The video opens with her holding the blender up, big smile: "This is the only
blender I've used in a month, and it doesn't even plug in."

Jump cut — closer to the lens, she drops a few frozen berries in, snaps the lid on,
and presses the top button once — the base whirs and the fruit blends in seconds:
"One button, fully cordless, charges over USB-C and it actually crushes frozen
stuff."

Jump cut — she pops the base off, tips it to show it's empty and clean, then taps
the bottle against her palm: "Rinses in two seconds. Link's in my bio — these keep
selling out." She shrugs and the video cuts.

Throughout the video, the tone is confident, excited, knowledgeable — she presents
each feature like an obvious win, demonstrates without fumbling, no hype, just
certainty. She talks quickly but enunciates clearly, moving with purpose between
each demo, never rushing past the action.

The lighting is bright natural daylight from the window, filling the kitchen
evenly. The image is natural phone quality, not color graded but well-exposed,
steady handheld with slight movement when she turns the bottle. The sound is direct
from the phone mic — her voice clear and close, faint blender whir on the demo
beat, no music underneath.

(Keyword captions "ONE-BUTTON" and "USB-C CHARGED" plus a CTA caption added later
via libi.add_overlay({ kind: "text" }) — no readable text in the generated video.)
```

---

## Adaptation checklist

- [ ] **15 seconds** — every clip is a single Seedance 2.0 prompt
- [ ] **Max 3 beats per clip** — hook, feature demo, kicker
- [ ] **Max 2–3 spoken lines** — more dialogue → split into another clip
- [ ] **Every feature beat has a physical demonstration** — no talking-only beats
- [ ] **Hook is a bold claim** — superlative, confident, no hedging
- [ ] **Person is wearing/using the product from frame 1** — no unboxing, no reveal
- [ ] **Framing changes every beat** — tighter, wider, close-up, turn-around
- [ ] **Setting is simple** — 2 background details max, slightly out of focus
- [ ] **Pacing cue included** — fast-but-clear, explicit (mandatory)
- [ ] **Multi-clip series planned** — 4+ features → split across 2–3 clips
- [ ] **Overlay plan** — captions/size/swatches queued for `libi.add_overlay({ kind: "text" })`; NO in-video text
- [ ] **Platform rules** — 100–260 words, `@Image1`, consistency anchor, motion adverbs, no forbidden words — see the Seedance 2.0 platform guide in the `ai-video-models` skill
