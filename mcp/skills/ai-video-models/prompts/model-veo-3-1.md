# Model — Veo 3.1 fast

Alternative model — used when the user overrides the Seedance 2.0 default. See
SKILL.md model-selection policy.

Veo 3.1 fast (`fal-ai/veo3.1/fast/*`) is a strong i2v/text-to-video option with
synchronized audio generation. Verify capabilities + pricing at runtime via fal
`recommend_model` / `get_model_schema` / `get_pricing` — never trust a hardcoded
model id; better models ship every few weeks.

Banned tokens (script + visual layers): see the `forbidden-words.md` prompt in the
`ugc-product-video` skill. Paraphrase any banned token in the brief before composing.

## 7-layer prompt ordering (compose in THIS order)

Veo responds dramatically better when layers appear in this sequence — it weights
early tokens most heavily. **Length target: 100–200 words** (above ~400 chars Veo
prioritizes elements unpredictably; under ~100 chars yields generic output).

1. **Camera & lens** — shot type + movement + lens. "Handheld medium shot, 35mm,
   subtle bob"; "tight tracking shot, 85mm, no cuts"; "slow dolly-in, 24mm wide".
2. **Subject** — lock the subject at the very start. Front-load identifying
   details (age, gender, hair, key clothing) so Veo doesn't drift on continuity.
   Reference the character image if provided.
3. **Action & physics** — ONE dominant action per clip. Veo handles "she unscrews
   the cap" cleanly; "she walks in, unscrews the cap, sips, walks out" causes
   drift. Split multi-action shots into multiple clips and concat.
4. **Environment** — location, time-of-day, weather, props in shot.
5. **Lighting** — be specific. "Low warm side light from frame-right", "soft
   north-window key", "neon-mixed sodium streetlight from frame-left".
6. **Style & texture** — film stock or color grade. "Shot on Kodak Portra 400,
   fine grain, warm grade", or "crisp digital, cool grade, slight film emulation".
7. **Audio** — Veo 3.1 generates synchronized audio. Specify dialogue (if any),
   foley (footsteps, cap-screw, pour), ambient (room tone, city hum), music tag
   (none / minimal pad / energetic).

## No text in the video (all paths, no exceptions)

Veo reliably breaks on rendered text — letters scramble, signs look fake, and it
sometimes burns in subtitles/captions unprompted. Append to EVERY prompt:

> `no on-screen text, no subtitles, no captions, no signs, no labels in the
> background, no readable text on any object`

If a beat needs text (product name, CTA, end-card), generate the clip text-free
and add it afterward as a libi text overlay via `libi.add_overlay({ kind: "text" })`.

## Timestamp brackets — full-Veo-3.1 only, NOT Fast

Timestamp-bracket decomposition (`[00:00-00:02] …` one shot + one action per
bracket) is a **full Veo 3.1** feature. The **Fast** endpoint misparses brackets
as missing-attachment refs and fails `no_media_generated`. On Fast, use a single
transition sentence (and prefer FLF for manipulation beats — below).

## FLF for manipulation beats

For a physical manipulation (applying, pouring, gripping-and-releasing), pin the
END state with first-last-frame so the model is forced to *arrive* at the final
state instead of improvising the object away mid-motion. Endpoint:
`fal-ai/veo3.1/fast/first-last-frame-to-video` (same tier as i2v — confirm via
`get_pricing`). Generate clean start + end keyframes, Vision-Read both before
spending video credits, then describe only the transition. Prefer a 4s clip over
8s for the manipulation beat.

## Worked example — UGC body shot

> "Tight medium shot, 50mm lens, slight handheld bob. Subject: 30-year-old man
> with a short dark beard, white tee, light jeans (same character as reference
> image). Action: he picks up the AquaFlow bottle from a wooden desk and tilts it
> slightly toward camera — the glowing blue cap catches the light. Environment:
> small home office, mid-morning. Lighting: warm window light from frame-right,
> soft fill from a desk lamp on frame-left. Style: photorealistic, shallow depth
> of field, fine film grain. Audio: subtle ambient room tone, a soft click as he
> sets it down. 6 seconds, 9:16 vertical. No on-screen text, no captions, no
> labels."

Negative prompt (when the model exposes one): `text overlay, subtitles, illegible
logos, malformed hands, extra fingers, anatomically wrong, watermark, low
resolution`.
