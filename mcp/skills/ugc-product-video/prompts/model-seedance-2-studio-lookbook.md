<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling (ai-asset-generation flow, fal-ai model ids, libi.upload_file). -->

# Studio lookbook — Seedance 2.0

**Use when:** a polished product showcase that feels like a short brand film — one
person, one product, shown across multiple styled looks against a clean studio
backdrop. The voice **narrates over** the visuals (voiceover, NOT lip-synced to
camera). Best for clothing, footwear, bags, watches — anything that benefits from
being styled multiple ways.

**Read first:** the Seedance 2.0 platform guide from the **`ai-video-models`** skill
(`model-seedance-2` — platform rules) and [forbidden-words.md](forbidden-words.md). Voiceover
tone + read-aloud timing draw on [script-craft.md](script-craft.md) — reference it, don't
duplicate it.

## What defines this style

It sits between raw UGC and a polished commercial, borrowing credibility from
both:

1. **Visual-first storytelling.** Unlike UGC where the person talks to camera,
   here the visuals lead and the voice follows — the narrator describes what
   you're seeing or what the next cut shows. The product is the main character.
2. **Multi-look versatility.** The same product is shown in 2–3 styling
   combinations to prove it's versatile. The person changes tops/footwear between
   cuts; the **product stays constant** — it's the thread connecting every shot.
3. **Behind-the-scenes authenticity.** The video deliberately reveals the studio
   setup — lights, camera rig, seamless backdrop, monitor. A trust signal that
   says "yes, this is produced, we're not pretending it's casual."

## The 7 layers

```
 1. FORMAT HEADER       — duration, style, lighting approach
 2. PERSON + STYLING    — the model, base look, outfit changes
 3. STUDIO SETTING      — backdrop + the visible BTS elements
 4. SHOT SEQUENCE       — what the camera shows, in order
 5. VOICEOVER SCRIPT    — narration over the visuals (NOT lip-synced)
 6. TONE & PACING       — mood, rhythm, energy arc (→ script-craft.md)
 7. TECHNICAL QUALITY   — lighting, camera, color, audio
```

---

### Layer 1: Format header

```
15 seconds {{CONTENT_TYPE}} video, {{CAMERA_SYSTEM}}, {{LIGHTING_SETUP}}, clean studio backdrop.
```

| Variable | Options |
|---|---|
| `CONTENT_TYPE` | brand lookbook, product showcase, studio campaign, styled editorial |
| `CAMERA_SYSTEM` | filmed on a cinema camera with shallow depth of field, filmed on a DSLR with natural motion, shot on a smartphone with a stabilizer — more polished than UGC |
| `LIGHTING_SETUP` | large softbox key with a white seamless backdrop, natural studio window light on white, overhead paper lantern with soft fill — soft, even, flattering |

---

### Layer 2: Person + styling

The person is a model / brand ambassador, not a "creator talking to their phone."
They move deliberately, pose naturally, and **don't acknowledge the camera.**

```
A {{AGE_RANGE}} {{GENDER}} with {{HAIR}}, {{FACIAL_DETAILS}}, {{BUILD}}, wearing {{LOOK_1_DESCRIPTION}} with the @Image1 ({{PRODUCT_DESCRIPTION}}).
```

| Variable | How to fill |
|---|---|
| `AGE_RANGE` | man in his early 30s, woman in her late 20s — slightly more "editorial" than typical UGC |
| `HAIR` | longer hair pulled back, short textured crop, natural curls — styled but not over-done |
| `BUILD` | lean build, athletic build, medium build — helps fit description |
| `LOOK_1_DESCRIPTION` | the "base" outfit around the product (plain white tee, dark trousers, etc.) |
| `PRODUCT_DESCRIPTION` | full name, color, key construction — **stays constant across looks** |

**Multi-look styling bank** (product constant, surrounding pieces change):

| Look | Top | Footwear | Vibe |
|---|---|---|---|
| **Casual workwear** | plain white tee, cap backwards | suede / work boots | rugged, everyday |
| **Smart casual** | chambray shirt, sleeves rolled | leather boots / white sneakers | polished, weekend |
| **Cold weather** | chunky knit, beanie | rain / hiking boots | outdoor, layered |
| **Minimal** | fitted black tee, no hat | clean white sneakers | modern, urban |

Anchor: "the @Image1 product stays unchanged across every look; only the
surrounding styling changes."

---

### Layer 3: Studio setting

```
Shot in a {{STUDIO_TYPE}} — {{BACKDROP}}, {{BTS_ELEMENT}}.
```

| Variable | Options |
|---|---|
| `STUDIO_TYPE` | small photo studio, converted loft studio, bright garage studio — a real space, not a corporate set |
| `BACKDROP` | white seamless paper, off-white muslin, light grey backdrop — clean, lets the product pop |
| `BTS_ELEMENT` | a large softbox at the edge of frame, a camera rig on a tripod in the foreground, hardwood floor past the seamless edge, a monitor showing the live feed — **include 1–2, they're the authenticity anchor** |

---

### Layer 4: Shot sequence

3–4 shot types per 15s clip. Shots do NOT sync to dialogue — the voiceover runs
continuously while the visuals cut between angles.

**Shot type bank:**

| Shot | Shows | Purpose |
|---|---|---|
| Seated inspect | person on a stool, holding/examining the product | relationship to product |
| Full-body standing | wearing the product, hands at sides / in pockets | overall fit + silhouette |
| Turn / walk | turns to show side/back, or walks a few steps | how it moves on the body |
| Waist-down fit | cropped at the waist, fit on legs/lower body | detail on fit, break line, hem |
| Extreme close-up | fabric, stitching, rivets, hardware | proves quality |
| Rack display | product on a rack/hanger, colorways shown | shows the range |
| BTS reveal | wide shot of the full studio — lights, camera, backdrop | authenticity signal |
| Outfit change | same person, different styling around the same product | proves versatility |

**15-second frameworks:**

| Clip type | Shot 1 (~4s) | Shot 2 (~4s) | Shot 3 (~4s) | Shot 4 (~3s) |
|---|---|---|---|---|
| **Hero intro** | seated inspect | full-body standing | extreme close-up | BTS reveal |
| **Versatility** | full-body Look A | turn/walk | full-body Look B | waist-down fit |
| **Detail focus** | rack display | extreme close-up | waist-down fit | full-body standing |

Include at least one BTS shot and at least one extreme close-up.

---

### Layer 5: Voiceover script (NOT lip-synced)

The person doesn't talk to camera — they pose, turn, and inspect while a voice
narrates over the top.

```
Voiceover: "{{OPENING_LINE}}. {{FEATURE_LINE}}. {{CLOSER_LINE}}."
```

**Voiceover rules:** first person but NOT to camera — it's narration, not
conversation; conversational but slightly more polished than raw UGC; names the
product by full name at least once; hits 1–2 specific features; closes with the
brand or where to buy; pacing relaxed and measured (size it with the
[script-craft.md](script-craft.md) word-count table — 2–3 sentences max for 15s).

> **libi audio note:** because the voiceover is not lip-synced, you can either let
> Seedance generate the narration audio, or generate the video with ambient-only
> audio and lay a separately generated / recorded voiceover as a standalone audio
> clip in libi (`libi.audio_add_clip`). The standalone route gives crisper,
> re-recordable narration — see `production-routes.md` for the per-path audio
> policy. State which route you're taking in the beat plan.

---

### Layer 6: Tone & pacing

Pick one persona (considered appreciation / quiet pride / aspirational everyday —
the measured end of the [script-craft.md](script-craft.md) bank) and carry it
through. **Mandatory pacing cue:** shots linger 3–4s (longer than UGC jump cuts);
the person moves slowly and deliberately; the voiceover is unhurried. Include the
explicit cue ("warm and unhurried, leaving room between lines").

---

### Layer 7: Technical quality

```
The lighting is {{LIGHT_SETUP}} — {{LIGHT_QUALITY}}.
The image is {{CAMERA_QUALITY}} — {{CAMERA_DETAILS}}.
The sound is {{AUDIO_TYPE}} — {{AUDIO_DETAILS}}.
```

**Lighting:** large softbox, soft even illumination, slightly warm. **Camera:**
cinema-quality, shallow DoF on close-ups, earth-tone palette. **Audio:** voiceover
recorded/laid separately, clean and close-mic'd, subtle ambient music underneath.

---

## Complete template

```
15 seconds {{CONTENT_TYPE}} video, {{CAMERA_SYSTEM}}, {{LIGHTING_SETUP}}, clean
studio backdrop. A {{AGE_RANGE}} {{GENDER}} with {{HAIR}}, {{FACIAL_DETAILS}},
{{BUILD}}, wearing {{LOOK_DESCRIPTION}} with the @Image1 ({{PRODUCT_DESCRIPTION}});
the @Image1 product stays unchanged across every look, only the styling changes.
Shot in a {{STUDIO_TYPE}} — {{BACKDROP}}, {{BTS_ELEMENT}}.

{{SHOT_1_TYPE}} — {{SHOT_1_DESCRIPTION}}.

Cut to {{SHOT_2_TYPE}} — {{SHOT_2_DESCRIPTION}}.

Cut to {{SHOT_3_TYPE}} — {{SHOT_3_DESCRIPTION}}.

Voiceover: "{{VO_LINE_1}}. {{VO_LINE_2}}. {{VO_LINE_3}}."

Throughout the video, the tone is {{TONE_EMOTIONS}} — {{VISUAL_BEHAVIOR}}.
{{PACING_CUE}}. The voiceover is {{VOICE_QUALITY}}.

The lighting is {{LIGHT_SETUP}} — {{LIGHT_QUALITY}}. The image is {{CAMERA_QUALITY}}
— {{CAMERA_DETAILS}}. The sound is {{AUDIO_TYPE}} — {{AUDIO_DETAILS}}.
```

---

## Worked example — wool overshirt (versatility framework)

```
15 seconds brand lookbook video, filmed on a cinema camera with shallow depth of
field, large softbox key light with a white seamless backdrop, clean studio
backdrop. A man in his early 30s with a short textured crop and a trimmed beard,
clean skin with natural complexion, lean build, wearing a plain white tee and dark
selvedge jeans with the @Image1 (FORGE Wool Overshirt — heathered charcoal, corozo
buttons, twin chest pockets, raw-edge hem); the @Image1 overshirt stays unchanged
across every look, only the styling around it changes. Shot in a converted loft
studio — off-white muslin backdrop, a large softbox visible at the edge of frame,
hardwood floor peeking past the seamless edge.

He stands full-body with the overshirt open over the white tee, hands in his
pockets, looking slightly off-camera with a relaxed, easy posture.

Cut to a slow turn — he rotates to show the back yoke and the twin chest pockets,
the wool draping naturally as he moves.

Cut to a second look — now the overshirt is buttoned over a chunky cream knit, a
beanie added; he slowly adjusts the collar, the styling shifted to cold-weather.

Cut to an extreme close-up — the heathered wool texture fills the frame, a corozo
button and the raw-edge hem catching the soft warm light.

Voiceover: "I wanted one layer that works open over a tee or buttoned over a knit.
The FORGE Wool Overshirt does both — the wool's heavy enough to hold its shape but
soft enough to wear all day. Find it at forge dot co."

Throughout the video, the tone is confident, thoughtful, measured — he handles the
overshirt with care, moves slowly between poses, each shot lingers. He never looks
straight at the lens. The pacing is unhurried, leaving room between lines. The
voiceover is warm and steady, like someone describing a favorite piece they reach
for every week.

The lighting is a large softbox creating soft even illumination, slightly warm
tone. The image is cinema-quality, shallow depth of field on the close-up,
earth-tone color palette. The sound is voiceover laid separately, clean and
close-mic'd, with subtle acoustic guitar underneath. (Voiceover added as a
standalone libi audio clip via libi.audio_add_clip; the video is generated with
ambient-only audio.)
```

---

## Adaptation checklist

- [ ] **15 seconds** — every clip is a single Seedance 2.0 prompt
- [ ] **3–4 shots per clip** — each lingers ~3–4 seconds
- [ ] **Voiceover, not talking to camera** — narration over the visuals, no lip-sync
- [ ] **Max 2–3 voiceover sentences** — measured pace (size via script-craft.md)
- [ ] **At least one BTS element** — studio light, camera rig, or seamless edge visible
- [ ] **Product stays constant across looks** — only surrounding styling changes
- [ ] **At least one extreme close-up** — fabric / stitching / hardware / construction
- [ ] **Shot types vary** — full-body, turn, waist-down, close-up, rack, BTS
- [ ] **Person doesn't talk to camera** — poses, turns, inspects, moves
- [ ] **Audio route chosen** — Seedance narration vs standalone `libi.audio_add_clip` voiceover (stated in plan)
- [ ] **Pacing cue** — explicit, unhurried (mandatory)
- [ ] **Platform rules** — 100–260 words, `@Image1`, consistency anchor, motion adverbs, no forbidden words, no in-video text — see the Seedance 2.0 platform guide in the `ai-video-models` skill
