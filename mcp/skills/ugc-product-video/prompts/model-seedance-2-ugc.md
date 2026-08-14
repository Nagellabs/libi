<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling (ai-asset-generation flow, fal-ai model ids, libi.upload_file). -->

# UGC selfie formula — Seedance 2.0

**Use when:** a real person filmed a casual selfie review / testimonial on their
phone — any person, any product, any room. The output should feel spontaneous,
imperfect, and human.

**Read first:** the Seedance 2.0 platform guide from the **`ai-video-models`** skill
(`model-seedance-2` — word count, `@Image1`, motion adverbs, style whitelist) and
[forbidden-words.md](forbidden-words.md) for the ban list. Tone, pacing, and the
read-aloud timing discipline live in [script-craft.md](script-craft.md) — that's
the model-agnostic dialogue bank; this file carries only the Seedance-specific
layer guidance.

## The 9 layers (stack in order — skip one and it falls apart)

```
 1. FORMAT HEADER       — duration, style, device, lighting, angle
 2. PERSON              — appearance, skin texture, clothing
 3. SETTING             — lived-in environment, specific clutter
 4. PRODUCT INTRO       — how they hold/show the product to camera
 5. SCRIPT BEATS        — jump-cut scenes with dialogue + actions
 6. TONE DIRECTION      — personality, pacing, energy (→ script-craft.md)
 7. EDIT STYLE          — jump cuts, angles, take selection
 8. TECHNICAL FLAWS     — camera, audio, lighting imperfections
 9. VIBE STATEMENT      — one-sentence emotional anchor
```

---

### Layer 1: Format header

Always leads the prompt. Sets the technical foundation.

```
{{DURATION}} UGC style {{CONTENT_TYPE}} video, filmed on smartphone,
{{LIGHTING_SOURCE}}, {{CAMERA_ANGLE}}.
```

| Variable | Options |
|---|---|
| `DURATION` | size to dialogue via the [script-craft.md](script-craft.md) word-count table; 4–15s, default 15s |
| `CONTENT_TYPE` | skincare review, unboxing, morning routine, haul, get-ready-with-me, first impression, honest review, tutorial, day-in-my-life |
| `LIGHTING_SOURCE` | natural bedroom window light, bathroom vanity mirror light, overhead kitchen light, car dashboard light, subtle desk ring light — name the *source*, not "good lighting" |
| `CAMERA_ANGLE` | casual handheld selfie angle, phone propped on counter, mirror selfie angle, laptop webcam angle, phone in one hand walking |

Always include **at least one silent action beat** (sipping, inspecting,
reacting) regardless of duration — it reads as more authentic than wall-to-wall
talking.

---

### Layer 2: Person — imperfection is the point

```
A {{AGE_RANGE}} {{GENDER}} with {{HAIR}}, {{SKIN_TEXTURE}}, wearing {{CLOTHING}},
```

| Variable | How to fill |
|---|---|
| `AGE_RANGE` | young woman, man in his 30s, college-aged guy — natural language, not exact ages |
| `HAIR` | brown hair pulled back, messy bun, short curly hair, blonde in a claw clip — casual, not salon-perfect |
| `SKIN_TEXTURE` | **always 2–3 reality cues** (see bank) — without them AI defaults to airbrushed |
| `CLOTHING` | casual grey tee, oversized hoodie, tank and shorts, worn-in flannel — comfort clothes, nothing styled |

**Skin reality cue bank** (pick 2–3):
- `natural skin with visible texture`
- `visible pores across nose and cheeks`
- `slight unevenness in skin tone`
- `minor undereye shadows`
- `a hint of shine on the forehead from natural oils`
- `slight pinkness on cheeks and nose`
- `a few expression lines when smiling`
- `light freckles` (if it fits the character)

**Do NOT use:** acne, pimples, breakouts, blemishes, rosacea — **real ≠
dermatological**. Texture cues sell authenticity; skin conditions read as a
casting brief for a problem, not a person.

---

### Layer 3: Setting — 3–4 specific objects

The background sells the authenticity. Name concrete clutter.

```
in {{THEIR_SPACE}} — {{DETAIL_1}}, {{DETAIL_2}}, {{DETAIL_3}}, {{ATMOSPHERE_WORD}} and real.
```

| Setting | Clutter details | Atmosphere |
|---|---|---|
| **Bedroom** | books on shelves, plants on the windowsill, clothes on a chair, fairy lights on the headboard | cozy, lived-in |
| **Bathroom** | towels hanging, bottles on the counter, toothbrush in a holder, foggy mirror edge | steamy, morning |
| **Kitchen** | coffee mug on the counter, cutting board, fruit bowl, light through the blinds | warm, morning routine |
| **Living room** | throw blanket on the couch, remote on a cushion, candle on the table, shoes by the door | relaxed, casual |
| **Car** | coffee in the cupholder, sunglasses on the dash, aux cord hanging, parking lot through the windshield | on-the-go |
| **Desk/office** | laptop half-open, sticky notes, water bottle, headphones over the monitor | work-from-home |
| **Balcony/outdoor** | railing behind, potted plants, trees/city visible, wind moving hair | fresh, late-afternoon |

---

### Layer 4: Product introduction

The bridge from person to pitch — how the product physically enters frame.

```
{{PRONOUN}} holds the @Image1 ({{PRODUCT_DESCRIPTION}}) {{HOW}}.
```

| Style | When | Example |
|---|---|---|
| Show to camera | review, first impression | "holds the bottle up to the camera" |
| Already using | tutorial, routine | "is mid-application, product already on her skin" |
| Unboxing reveal | haul, unboxing | "pulls it out of the box, eyes lighting up" |
| In-hand casual | day-in-my-life | "has it on her lap, picks it up" |
| Before/after | results-focused | "holds it next to her face, turning to show her skin" |

Keep the `@Image1` token and add a consistency anchor
("the product from @Image1 stays unchanged in every shot").

---

### Layer 5: Script beats — the heart of the prompt

Each beat = one jump cut. Arc: **setup → demonstration → proof → verdict.**
Not every beat needs dialogue — silent beats (inspecting, sipping, reacting)
prevent cramming words into the runtime. **Every video has ≥1 silent beat.**

Per beat:
```
{{TRANSITION}} — {{FRAMING_CHANGE}}, {{ACTION}}: "{{DIALOGUE}}"
// or silent:
{{TRANSITION}} — {{FRAMING_CHANGE}}, {{ACTION}}.
```

| Beat | Purpose | Framing | Action |
|---|---|---|---|
| 1 (Hook) | grab attention | looking into camera | expressive opener, holds product up |
| 2 (Show) | product detail | closer to lens | tilts/turns product, shows label/texture |
| 3 (Demo) | proof of use | extreme close-up | applies/uses product, shows consistency |
| 4 (Result) | evidence | mirror / new angle | points at result, before/after |
| 5 (Verdict) | final opinion | back to original angle | holds product up, final line |

For a 4–8s clip pick 2 beats; 6–8s → 2–3; 9–15s → 3–4. Any beat can be spoken or
silent; the total dialogue must fit the runtime read aloud at a relaxed pace.

**Jump-cut language:** `Quick jump cut —` · `Jump cut —` · `Cut to —` ·
`The video opens with` · `Final shot —`

**Framing changes** (vary every beat): closer to the lens · extreme close-up of
the dropper · phone propped, reflection visible · leans into the camera · holds
the product up one final time.

**Dialogue:** casual spoken language, filler words, end mid-thought or on a
laugh — full rules in [script-craft.md](script-craft.md). No forbidden words in
the spoken line either.

---

### Layer 6: Tone direction

One paragraph fixing the emotional texture of the whole video. **Pick exactly one
persona from the [script-craft.md](script-craft.md) tone bank** and carry it
through every beat. The bank gives you emotion words + a behavior description to
drop straight in here.

**Mandatory:** the tone paragraph MUST include an explicit pacing cue — Seedance
defaults to unnaturally fast speech. Use one of the cues from
[script-craft.md](script-craft.md) ("pauses between thoughts…", "leaves a beat of
silence after each sentence…"). A tone paragraph with no pacing cue is incomplete.

---

### Layer 7: Edit style

How the jump cuts relate to each other.

```
Each jump cut is {{ANGLE_VARIATION}}. {{EDIT_FEEL}}.
```

Default: *"Each jump cut is slightly closer or at a different angle, as if she
filmed multiple takes and edited the best bits together."* Variations: quick cuts
between tight close-ups and medium shots (TikTok rhythm); one long take with one
or two hard cuts; get-ready-with-me time-skips per step.

---

### Layer 8: Technical flaws — what makes it real

Include all three sub-blocks every time, tuned to the setting.

```
The lighting is {{LIGHT_TYPE}} — {{LIGHT_FLAW}}.
The image is slightly imperfect — {{CAMERA_FLAW_1}}, {{CAMERA_FLAW_2}}, {{CAMERA_FLAW_3}}.
The sound is {{AUDIO_SOURCE}} — {{AUDIO_DETAILS}}.
```

**Light flaws:** `no ring light, no filters` · `slightly overexposed from the
window` · `one side of the face in shadow`

**Camera flaws** (pick 2–3): `natural phone quality, not color graded` · `slight
motion blur on fast movements` · `soft focus, nothing tack sharp` · `visible grain
in darker areas` · `auto white-balance shift between cuts`

**Audio source:** `direct from the phone mic` (her voice, room ambience, no
music) · `front camera mic` (slightly tinny, room echo) · `car interior
acoustics` (muffled, road noise underneath)

---

### Layer 9: Vibe statement — the north star

One sentence anchoring the whole feel.

```
The overall feel is {{ADJ_1}}, {{ADJ_2}}, {{ADJ_3}} — {{RELATABLE_METAPHOR}}.
```

Examples: *"trustworthy, relatable, real — a friend telling you about something
she genuinely likes."* · *"chaotic, genuine, fun — like a voice memo to her group
chat."* · *"calm, honest, intimate — like overhearing someone's morning
routine."*

---

## Complete template — fill in the `{{VARIABLES}}`

```
{{DURATION}} UGC style {{CONTENT_TYPE}} video, filmed on smartphone,
{{LIGHTING_SOURCE}}, {{CAMERA_ANGLE}}. A {{AGE_RANGE}} {{GENDER}} with
{{HAIR}}, {{SKIN_TEXTURE}}, wearing {{CLOTHING}}, in {{THEIR_SPACE}} —
{{CLUTTER_1}}, {{CLUTTER_2}}, {{CLUTTER_3}}, {{ATMOSPHERE}} and real.
{{PRONOUN}} holds the @Image1 ({{PRODUCT_DESCRIPTION}}) {{PRODUCT_INTRO}};
the product from @Image1 stays unchanged in every shot.

The video opens with {{PRONOUN}} {{HOOK_ACTION}}: "{{HOOK_LINE}}"

Quick jump cut — {{BEAT_2_FRAMING}}, {{BEAT_2_ACTION}}: "{{BEAT_2_DIALOGUE}}"

Jump cut — {{BEAT_3_FRAMING}}, {{BEAT_3_ACTION}}.

Jump cut — {{BEAT_4_FRAMING}}, {{BEAT_4_ACTION}}: "{{BEAT_4_DIALOGUE}}" {{CLOSING_ACTION}}.

Throughout the video, the tone is {{TONE_EMOTIONS}} — {{TONE_BEHAVIOR}}. The
pacing is natural and unhurried — {{PACING_CUE}}. Each jump cut is
{{ANGLE_VARIATION}}. {{EDIT_FEEL}}.

The lighting is {{LIGHT_TYPE}} — {{LIGHT_FLAW}}. The image is slightly imperfect —
{{CAMERA_FLAWS}}. The sound is {{AUDIO_SOURCE}} — {{AUDIO_DETAILS}}.

The overall feel is {{VIBE_ADJECTIVES}} — {{RELATABLE_METAPHOR}}.
```

---

## Worked example — electrolyte hydration sticks (kitchen, skeptic-converted)

```
15 seconds UGC style honest review video, filmed on smartphone, overhead kitchen
light with morning daylight through the blinds, phone propped on the counter. A
woman in her early 30s with a messy bun, natural skin with visible pores and a
hint of shine on the forehead, wearing an oversized grey sweatshirt, in her small
apartment kitchen — a coffee mug by the sink, a half-cut lemon on a board, a
glass water bottle on the counter, cluttered and real. She picks up the @Image1
(RIVR Hydration — slim white stick pack, watermelon-mint flavor, teal accent
stripe) and turns it slowly toward the camera; the product from @Image1 stays
unchanged in every shot.

The video opens with her holding the pack up, raised eyebrows: "Okay, I did not
think a powder packet would change my mornings, but here we are."

Quick jump cut — closer to the lens, she slowly tears the pack open and pours it
into the glass bottle, watching it dissolve: "It actually dissolves, no chalky
clumps at the bottom."

Jump cut — extreme close-up of her taking a slow sip, she pauses, nods to herself.

Jump cut — back to the propped angle, she taps the empty pack against the counter
with a half-smile: "Yeah, I'm restocking these." She shrugs and the video cuts.

Throughout the video, the tone is surprised, impressed, almost reluctant — she
raises her eyebrows, pauses mid-sentence as if reconsidering, sounds like she
can't quite believe it. The pacing is natural and unhurried — she leaves a beat of
silence after each sentence before continuing. Each jump cut is slightly closer or
at a different angle, morning light shifting between takes.

The lighting is uneven kitchen light — bright from the window side, soft shadow on
the other. The image is slightly imperfect — natural phone quality, slight warm
cast, soft focus, not color graded. The sound is direct from the phone mic — her
natural voice, faint fridge hum underneath, no music.

The overall feel is honest, low-key, convincing — a friend who was a skeptic
admitting she got it wrong.
```

---

## Adaptation checklist

- [ ] **Format header** — duration, style, device, lighting source, camera angle
- [ ] **Person** — described with natural imperfections, not a model casting call
- [ ] **Skin texture** — ≥2 reality cues (pores, unevenness, shine, shadows); NO acne/blemishes
- [ ] **Setting** — 3+ specific clutter objects + an atmosphere word
- [ ] **Product intro** — product described concretely, how it enters frame, `@Image1` kept
- [ ] **Script beats** — beat count matches duration; ≥1 silent beat
- [ ] **Dialogue** — fits the runtime read aloud, filler words, ends naturally (see script-craft.md)
- [ ] **Tone direction** — one persona from the script-craft.md bank, carried throughout
- [ ] **Pacing cue** — explicit, present in the tone paragraph (mandatory)
- [ ] **Edit style** — how the cuts relate
- [ ] **Technical flaws** — lighting + camera + audio sub-blocks all present
- [ ] **Vibe statement** — one-sentence emotional metaphor
- [ ] **Platform rules** — 100–260 words, motion adverbs, consistency anchor, no forbidden words, no in-video text (queue `libi.add_overlay({ kind: "text" })`) — see the Seedance 2.0 platform guide in the `ai-video-models` skill
