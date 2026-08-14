<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling (ai-asset-generation flow, fal-ai model ids, libi.upload_file). -->

# Product hero — Seedance 2.0

**Use when:** a dramatic, no-person showcase where the product itself is the
star — shot like a movie poster, with moody lighting, a colored backdrop, and
elemental interaction (water splash, ice, mist, dust, sparks, smoke). Best for
beverages, supplements, cans, bottles, cosmetics, tech gadgets — anything with
strong packaging.

**Read first:** the Seedance 2.0 platform guide from the **`ai-video-models`** skill
(`model-seedance-2` — platform rules) and [forbidden-words.md](forbidden-words.md) (ban list —
for hero work use `dramatic` or `premium`, never `cinematic`).

## What defines this style

No person on screen. The product is the only subject and the entire visual
language makes it larger than life.

1. **The product is the hero.** Every shot is framed around it — macro of the
   label, dramatic angles looking up at it, wide hero compositions. The camera
   treats the product the way a portrait photographer treats a face.
2. **Elemental interaction creates the action.** With no person doing things, the
   energy comes from the environment — water splashing, rain, condensation
   beading, ice cracking, mist swirling. The product stays mostly static while
   the world around it moves.
3. **Dramatic lighting and color set the mood.** One deep background color, the
   product spot-lit, high contrast. Shadows and highlights give it weight.

## The 6 layers

```
 1. FORMAT HEADER       — duration, visual style, camera type
 2. PRODUCT             — what it looks like, how it's positioned
 3. ENVIRONMENT         — backdrop color, surface, elemental effects
 4. SHOT SEQUENCE       — angles, movements, compositions
 5. OVERLAY PLAN        — tagline / CTA (added in libi, NOT in-video)
 6. TECHNICAL QUALITY   — lighting, camera movement, color grade, audio
```

---

### Layer 1: Format header

```
15 seconds {{CONTENT_TYPE}} video, {{CAMERA_STYLE}}, {{MOOD_DESCRIPTOR}}.
```

| Variable | Options |
|---|---|
| `CONTENT_TYPE` | product hero, beverage commercial, premium product showcase, brand film |
| `CAMERA_STYLE` | slow-motion macro photography, dramatic product photography, high-speed product photography |
| `MOOD_DESCRIPTOR` | dark and dramatic, moody and premium, bold and energetic, clean and minimal |

No-dialogue style → default to **15s**.

---

### Layer 2: Product

```
The @Image1 ({{PRODUCT_DESCRIPTION}}) — {{SURFACE_DETAILS}}, {{CONDITION_DETAILS}}.
```

| Variable | How to fill |
|---|---|
| `PRODUCT_DESCRIPTION` | full name + shape, size, colors, label design, material — be very specific, it's the only thing on screen |
| `SURFACE_DETAILS` | condensation droplets on the surface, frost forming on the edges, matte finish absorbing the light |
| `CONDITION_DETAILS` | ice cold, freshly opened, sealed and pristine, slightly wet from condensation |

Add a consistency anchor: "the product from @Image1 and its label stay unchanged
across every shot."

---

### Layer 3: Environment

```
Set against a {{BACKDROP}} on a {{SURFACE}}. {{ELEMENTAL_EFFECT_1}}, {{ELEMENTAL_EFFECT_2}}.
```

| Variable | Options |
|---|---|
| `BACKDROP` | deep blue gradient, matte black void, dark teal-to-black gradient, warm amber glow, ice-white backdrop — one dominant color, often a gradient |
| `SURFACE` | dark reflective surface, wet black marble, sheet of ice, matte black platform, mirror-like wet surface — **reflective surfaces double the product's presence** |
| `ELEMENTAL_EFFECT_1` | the PRIMARY motion (water splashing around the product, rain onto the can, mist swirling at the base, ice cracking) |
| `ELEMENTAL_EFFECT_2` | the SECONDARY detail (droplets suspended mid-air, light refracting through droplets, surface ripples spreading, frost crystals forming) |

**Element bank by product type:**

| Product type | Primary element | Secondary element |
|---|---|---|
| **Beverage / can / bottle** | water splash, rain, pour into a glass | condensation, ice, droplets frozen in air |
| **Supplement / powder** | powder explosion, dust cloud | particles catching the light, settling slowly |
| **Skincare / cosmetic** | cream swirl, liquid drip, mist | dewy droplets, light refraction |
| **Tech / gadget** | sparks, light trails, electricity | reflections, lens flare, drifting smoke |
| **Food** | steam, sizzle, drip | condensation, crumbs, splatter |

---

### Layer 4: Shot sequence

3–4 shots that escalate in drama — typically tight/tactile → wide/heroic.

**Shot type bank:**

| Shot | Shows | Purpose |
|---|---|---|
| Extreme close-up / macro | label detail, surface texture, condensation | opener — texture sells quality |
| Grab / interaction | a hand reaching in, water displaced | the only human element — gives scale |
| Dramatic angle | product from below or tilted, effects falling | larger-than-life |
| Hero composition | product centered, full label visible | the money shot — poster frame |
| Slow-motion splash | element hitting the surface | pure spectacle |
| Hero hold | hero composition held 3–4s | closing frame for the overlay |

**15-second frameworks:**

| Sequence | Shot 1 (~3s) | Shot 2 (~3s) | Shot 3 (~4s) | Shot 4 (~5s) |
|---|---|---|---|---|
| **Escalating drama** | macro close-up | hand grab + splash | dramatic low angle with rain | hero comp (hold for overlay) |
| **Reveal build** | blurred product in ice | focus pulls to a sharp label | splash / pour moment | multi-variant hero (hold) |
| **Pure spectacle** | slow-mo splash | dramatic angle, rain pouring | quick cut to a second variant | hero lineup (hold) |

Every camera move is **slow and deliberate** — degree adverbs required.

---

### Layer 5: Overlay plan — tagline / CTA (libi, not in-video)

The arcads original baked text into the video. In libi you do **not** — generated
text warps and fails Stage 4.5. Instead:

1. Compose the hero clip with **no readable text**, ending on a held hero shot
   that leaves clean negative space (top third or centre) for a caption.
2. After Stage 4.5 passes, add the tagline + CTA as libi text overlays via
   `libi.add_overlay({ kind: "text" })`, timed to the held frames.

**Tagline rules (for the overlay you'll add):** short, punchy, 4–8 words; often a
contrast or juxtaposition; bold sans-serif, white or gold. Plan it now, render it
later.

> Note in your beat plan which shot is the "tagline hold" and which is the "CTA
> hold" so Stage 8's verify gate can confirm the overlays were added.

---

### Layer 6: Technical quality

```
The lighting is {{LIGHT_SETUP}} — {{LIGHT_QUALITY}}.
The image is {{CAMERA_QUALITY}} — {{CAMERA_DETAILS}}.
The color grade is {{COLOR_GRADE}}.
The sound is {{AUDIO_TYPE}} — {{AUDIO_DETAILS}}.
```

**Lighting:** high contrast, dramatic shadows; the product is the brightest thing
in frame. **Camera:** high-end product-photography quality, tack-sharp focus on
the label, slow-motion capture on splash/water, very smooth movement, no shake.
**Color grade:** deep saturated backdrop with neutral product tones — the product
pops against the environment. **Audio:** music bed + foley (ice cracking, water
splash, can crack). No voice, no dialogue.

---

## Complete template

```
15 seconds {{CONTENT_TYPE}} video, {{CAMERA_STYLE}}, {{MOOD_DESCRIPTOR}}. The
@Image1 ({{PRODUCT_DESCRIPTION}}) — {{SURFACE_DETAILS}}, {{CONDITION_DETAILS}};
the product and its label from @Image1 stay unchanged across every shot. Set
against a {{BACKDROP}} on a {{SURFACE}}. {{ELEMENTAL_EFFECT_1}}, {{ELEMENTAL_EFFECT_2}}.

{{SHOT_1_TYPE}} — {{SHOT_1_DESCRIPTION}}.

Cut to {{SHOT_2_TYPE}} — {{SHOT_2_DESCRIPTION}}.

Cut to {{SHOT_3_TYPE}} — {{SHOT_3_DESCRIPTION}}.

{{SHOT_4_TYPE}} — {{SHOT_4_DESCRIPTION}}, held steady with clean negative space
for a tagline. (No readable text in the video — tagline + CTA added later via
libi.add_overlay({ kind: "text" }).)

The lighting is {{LIGHT_SETUP}} — {{LIGHT_QUALITY}}. The image is {{CAMERA_QUALITY}}
— {{CAMERA_DETAILS}}. The color grade is {{COLOR_GRADE}}. The sound is {{AUDIO_TYPE}}
— {{AUDIO_DETAILS}}.
```

---

## Worked example — vitamin-C facial serum

```
15 seconds premium product showcase video, slow-motion macro photography, moody
and premium. The @Image1 (GLOW LAB Vitamin-C Serum — frosted amber glass dropper
bottle, brushed gold cap, minimal cream label with a thin orange line) — a single
dewy droplet clinging to the dropper tip, the glass cool and pristine; the product
and its label from @Image1 stay unchanged across every shot. Set against a dark
teal-to-black gradient on a mirror-like wet surface. A slow swirl of golden serum
ribbons drifting through the frame behind the bottle, tiny dewy droplets catching
and refracting the light.

Extreme close-up — the dropper tip fills the frame, one amber droplet slowly
swelling and falling, light bending through it.

Cut to a dramatic low angle — the bottle tilted gently toward camera, a thin
ribbon of serum drifting past it, the brushed gold cap catching a soft highlight.

Cut to a slow push-in across the wet surface — the bottle's reflection doubling it
on the mirror-like marble, a few droplets rippling outward.

Hero composition — the bottle centered and upright, the serum swirl settling
behind it, held steady with clean negative space above for a tagline. (No readable
text in the video — tagline and CTA added later via libi.add_overlay({ kind: "text" }).)

The lighting is a single soft spotlight from above with cool rim light on the glass
edges, deep shadows pooling around the base. The image is high-end product
photography, tack-sharp on the dropper, slow-motion capture on the serum and
droplets. The color grade is deep teal shadows with warm amber highlights glowing
from the serum. The sound is a low ambient pad swelling under a soft liquid drip
and a single glass chime at the hero frame, no voice.
```

---

## Adaptation checklist

- [ ] **15 seconds** — single Seedance 2.0 clip
- [ ] **No person in frame** — hands only if needed for a grab/interaction shot
- [ ] **Product is the only subject** — described in full detail
- [ ] **Elemental interaction specified** — something MOVES (water/ice/mist/smoke/sparks/swirl)
- [ ] **Backdrop is a single deep color** — not white, not busy, one moody tone
- [ ] **Surface is reflective** — doubles the product's presence
- [ ] **3–4 shots that escalate** — macro → interaction → dramatic angle → hero
- [ ] **Camera movement is slow + deliberate** — degree adverbs, no fast cuts, no handheld
- [ ] **Overlay plan** — tagline/CTA queued for `libi.add_overlay({ kind: "text" })`; held frame has clean negative space; NO in-video text
- [ ] **Audio is music + foley, no dialogue**
- [ ] **Platform rules** — 100–260 words, `@Image1`, consistency anchor, no forbidden words — see the Seedance 2.0 platform guide in the `ai-video-models` skill
