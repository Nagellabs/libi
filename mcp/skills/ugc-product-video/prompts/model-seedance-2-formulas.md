---
prompt_kind: model-guide
model: Seedance 2.0
---

<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling. -->

# Seedance 2.0 ad formulas

One prompt recipe per ad format. Pick the format with [ad-formats](ad-formats.md), then read the shared rules and only that format's section. The engine's own prompt rules (reference tokens, prompt order, word band, motion adverbs, no timecodes) are in the `video-generation-craft` skill's Seedance reference; the realism cues and banned words are in [craft](../references/craft.md); tone and the pacing cue are in [script-craft](script-craft.md).

## Shared by every format

- Every prompt is ONE clip of up to 15 s (no-dialogue formats use all 15), 100 to 260 words, in the order Subject, Action, Camera, Style, Constraints. Beats are jump cuts inside it, written as ordered actions with pacing cues, not timecodes.
- Open with a format header (duration, style, device or camera, lighting source), end with a technical block (lighting, image quality, sound), and carry an invariant anchor for the product ("the product stays unchanged in every shot").
- The product reference: on the reference endpoint cite it as `@Image1` once; on the plain image-to-video endpoint there are no tokens, so describe the product as it appears in the start frame.
- Every prompt carries an explicit pacing cue. Spoken formats need one for speech speed; slow formats need one for camera speed.
- No readable text in the video. Taglines, keyword captions, CTAs and brand lockups are queued as text overlays and added after validation; plan which beat each lands on so the final verify can confirm it.
- Spoken lines go in the prompt as `She says: "…"` and only in a clip with native audio on. Size them with the word-count table in [craft](../references/craft.md).
- Before submitting: word count, order, a degree and direction on every motion, anchor present, no banned word for this format (the list is scoped per format in craft), no in-video text, beat count matches the duration.

## UGC selfie (and talking-head testimonial)

**Use when** a real person filmed a casual selfie review or testimonial: spontaneous, imperfect, human. Stack nine layers in order; skip one and it falls apart.

1. **Format header**: `{{DURATION}} UGC style {{CONTENT_TYPE}} video, filmed on smartphone, {{LIGHTING_SOURCE}}, {{CAMERA_ANGLE}}.` Content types: skincare review, unboxing, morning routine, haul, first impression, honest review, tutorial, day in my life. Name the light *source* (bedroom window, bathroom vanity, overhead kitchen light, car dashboard), not "good lighting". Angles: handheld selfie, phone propped on the counter, mirror selfie, webcam, phone in one hand walking.
2. **Person**: natural-language age, casual hair, comfort clothes, and two or three skin-reality cues from [craft](../references/craft.md).
3. **Setting**: a lived-in room with three or four named objects (bedroom: books, plants on the sill, clothes on a chair; kitchen: coffee mug, cutting board, light through the blinds; car: coffee in the cupholder, parking lot through the windshield) and an atmosphere word.
4. **Product introduction**: how it enters the frame: held up to camera (review), already mid-use (tutorial), pulled out of the box (unboxing), next to the face (results). Keep the product anchor.
5. **Script beats**: each beat is one jump cut, `Quick jump cut — {{FRAMING}}, {{ACTION}}: "{{LINE}}"`, or silent. Arc: setup, demonstration, proof, verdict. Use the framing and beat table in [ad-formats](ad-formats.md); vary the framing every beat (closer, extreme close-up, phone propped with the reflection visible, leaning in, a final hold-up). At least one silent beat.
6. **Tone direction**: exactly one persona from the [script-craft](script-craft.md) bank, carried through, with the pacing cue.
7. **Edit style**: "Each jump cut is slightly closer or at a different angle, as if she filmed several takes and edited the best bits." Variants: quick TikTok cuts between close-ups and mediums; one long take with a hard cut or two.
8. **Technical flaws**, all three sub-blocks, tuned to the setting: light (`no ring light, no filters`, slightly overexposed from the window, one side of the face in shadow); camera, two or three of natural phone quality not colour graded, slight motion blur, soft focus, visible grain in the dark, auto white-balance shift between cuts; sound (direct from the phone mic, room ambience, no music).
9. **Vibe statement**: one sentence anchor, `The overall feel is {{ADJ}}, {{ADJ}}, {{ADJ}} — {{relatable metaphor}}.`

Worked example (kitchen, skeptic converted):

```
15 seconds UGC style honest review video, filmed on smartphone, overhead kitchen light
with morning daylight through the blinds, phone propped on the counter. A woman in her
early 30s with a messy bun, natural skin with visible pores and a hint of shine on the
forehead, wearing an oversized grey sweatshirt, in her small apartment kitchen — a coffee
mug by the sink, a half-cut lemon on a board, a glass water bottle, cluttered and real.
She picks up the hydration stick pack (slim white, teal accent stripe) and turns it slowly
toward the camera; the product stays unchanged in every shot.

The video opens with her holding the pack up, raised eyebrows: "Okay, I did not think a
powder packet would change my mornings, but here we are."

Quick jump cut — closer to the lens, she slowly tears it open and pours it into the glass
bottle, watching it dissolve: "It actually dissolves, no chalky clumps at the bottom."

Jump cut — extreme close-up of her taking a slow sip, pausing, nodding to herself.

Jump cut — back to the propped angle, she taps the empty pack on the counter with a
half-smile: "Yeah, I'm restocking these." She shrugs and the video cuts.

The tone is surprised, impressed, almost reluctant; she pauses mid-sentence as if
reconsidering. The pacing is unhurried: she leaves a beat of silence after each sentence.
Each jump cut is slightly closer or at a different angle, morning light shifting between
takes. The lighting is uneven kitchen light, bright on the window side. The image is natural
phone quality, slight warm cast, soft focus. The sound is direct from the phone mic, faint
fridge hum, no music. The overall feel is honest, low-key, convincing — a friend who was a
skeptic admitting she got it wrong.
```

## Product hero

**Use when** there is no person and the product is the star, shot like a movie poster: moody light, one deep backdrop colour, elemental interaction. Best for beverages, supplements, cosmetics, gadgets, anything with strong packaging.

- **The product is the hero in every shot** (macro of the label, a low angle looking up, a wide hero composition) and stays nearly still while the world around it moves.
- **Elements create the action.** Primary and secondary motion by product: beverage (water splash, rain, pour; condensation, ice, droplets frozen in the air), supplement (powder explosion, dust; particles catching light), skincare (cream swirl, liquid drip, mist; dewy droplets), tech (sparks, light trails; reflections, lens flare, smoke), food (steam, sizzle; condensation, crumbs).
- **Stage**: one dominant backdrop colour (deep blue gradient, matte black void, teal-to-black, warm amber), often a gradient; a reflective surface (wet black marble, sheet of ice, mirror-like wet floor) that doubles the product's presence.
- **Product line**: full name, shape, colours, label design, material, surface details (condensation, frost, matte finish) and condition (ice cold, freshly opened).
- **Shots**: three or four that escalate from tight and tactile to wide and heroic. Bank: extreme close-up or macro; a hand grab (the only human element, for scale); a dramatic low or tilted angle; the hero composition (centred, full label, the poster frame); slow-motion splash; a final hero hold of three or four seconds. Every camera move is slow and deliberate.
- **Overlay plan**: end on a held hero shot with clean negative space (top third or centre) for a tagline of four to eight words and a CTA; note which shot is the tagline hold and which the CTA hold.
- **Technical**: high contrast, product the brightest thing in frame, tack-sharp label, slow-motion on splashes, smooth movement, no shake, deep saturated backdrop with neutral product tones. Sound is a music bed plus foley (ice cracking, splash, can crack): no voice, no dialogue.

Prompt skeleton: `15 seconds {{CONTENT_TYPE}} video, {{CAMERA_STYLE}}, {{MOOD}}. The product ({{full description}}), {{surface}}, {{condition}}; the product and its label stay unchanged across every shot. Set against a {{BACKDROP}} on a {{SURFACE}}. {{PRIMARY ELEMENT}}, {{SECONDARY ELEMENT}}.` then one sentence per shot (`Extreme close-up — …`, `Cut to a dramatic low angle — …`, `Hero composition — … held steady with clean negative space for a tagline`), then the technical block.

## Feature walkthrough

**Use when** a person is wearing or using the product and speed-runs its features, proving each with their hands. It is not a review: no skeptic arc, no before and after; the person loves it from frame one.

- **Show, don't tell.** Every feature claim is a physical action (hidden pockets: she reaches in; stretch: she pulls the waistband). No talking-only feature beats. Bank: pockets (reach in, show depth), stretch (pull, show snap-back), hood (pull up), softness (run a hand across, bunch it), fit (turn around, pull at the sides), closure (zip up and down), weight (lift, let drop), mechanisms (trigger the latch in one motion).
- **Three beats per clip**: hook (a bold, confident claim, about 4 s, one punchy sentence), feature demo (one or two features, about 7 s, one or two short sentences), kicker (reaction, verdict or CTA, about 4 s). Three or four short lines is the ceiling. One of the three beats may be a silent demo, at beat two. More than two features means more clips, each a different slice (hero, features, fit and CTA).
- **Person and product together** from frame one, no unboxing: a light touch of skin cues (one or two), the product wearing or in hand, an anchor for both the product and the outfit across cuts.
- **Setting**: simple and residential (living room, bedroom, hallway, kitchen), at most two background details, slightly out of focus.
- **Dialogue**: confident, not questioning; specific (names the materials and design choices); "this" and "these" while pointing; the last beat carries urgency ("selling out", "link in bio").
- **Pacing cue is fast but clear** ("talks quickly but enunciates, moves with purpose, no fumbling"), not long silences.
- **Overlay plan**: keyword captions during each feature beat ("HIDDEN POCKETS"), a size reference on the fit beat, colour swatches on the closer; the hook and CTA beats nearly always get one.
- **Technical**: bright even daylight, phone quality but steady and slightly more polished than raw UGC, direct phone mic, quiet room.

## Premium reveal

**Use when** a dark-background product launch or "introducing the next generation" announcement: no person, no spoken dialogue, the product emerging from a black void, slow moves, premium material close-ups, a narrative told by text.

- **Void stage**: pure black (not dark grey), dramatic rim light by default. Never describe a visible light source (no lamps, softboxes, windows): the light simply exists, which keeps the floating-in-void illusion.
- **Product**: form, material and exactly how light touches it. Pairings: brushed metal with rim light catching the grain, polished or chrome with sharp reflections sliding across, matte plastic with soft diffused highlights, glass with refraction and caustics, fabric with raking light.
- **The text tension.** This format's identity is text as narrative, but generated text warps. Loose atmospheric phrasing may be left to the model, treated as unreliable; the product name, brand lockup, CTA and any claim or number go on as text overlays on held frames. Always queue the brand name and CTA as overlays. Narrative structures (at most three lines, each under eight words, centre or upper third): introduction (INTRODUCING, category claim, name), superlative (bold claim, proof, name), question (what if, answer, name), feature stack.
- **Reveal sequence**: two or three distinct views. Opening: rise from below, fade from dark, rotate in, or zoom out from an extreme close-up. Moves: slow 360 orbit, push-in, overhead descent, slow pan across surface detail. Every move lasts three to five seconds, with degree adverbs (slowly, deliberately, gracefully). Optional variant lineup (top-down, side by side, or a morph) with size labels as overlays.
- **Beats without timecodes**: a tease (the product partly visible, emerging from darkness, about the first quarter), the reveal (full product, camera moving around it, about the middle half), and a close (final hero angle held with clean negative space for the lockup). Leave at least a second of pure black at the end. The format reads as ordered actions, never `[00:00]` blocks.
- **Technical**: edge light from behind plus a soft single-side fill, true product colours with slightly boosted contrast, ultra-clean sharp focus (the opposite of UGC), no grain, smooth dolly feel, 9:16 with the product centred and generous black above and below. A launch series is three clips: announcement, features, lineup.

## Studio lookbook

**Use when** a polished, brand-film product showcase: one person, one product, several styled looks on a clean studio backdrop, narrated by a voice over the visuals. Best for clothing, footwear, bags, watches.

- **Visuals lead, the voice follows.** The person is a model: deliberate, posing, **never looking at the lens**. The narrator describes what you see or what the next cut shows.
- **Multi-look**: the product stays constant and unchanged; only the surrounding styling changes between looks (casual workwear: white tee and boots; smart casual: chambray and sneakers; cold weather: chunky knit and beanie; minimal: fitted black tee and clean sneakers). Two or three looks per clip.
- **Visible behind-the-scenes element** (one or two): a softbox at the edge of frame, a camera rig on a tripod, the hardwood floor past the seamless edge, a monitor with the live feed. It is the authenticity anchor.
- **Shots**: three or four, each lingering three or four seconds. Bank: seated inspect, full-body standing, turn or walk, waist-down fit, extreme close-up of fabric or hardware, rack display, studio reveal, outfit change. Include one studio-reveal shot and one extreme close-up.
- **Voiceover**: first person but not to camera; conversational and slightly more polished than raw UGC; names the product in full once; one or two specific features; closes with the brand or where to buy; relaxed pace, two or three sentences for 15 s. The narration is spoken natively in the clip by default. A separately recorded voiceover is the user's opt-in; in that case the clip carries no dialogue and keeps its ambient audio. State the route in the beat plan.
- **Pacing cue**: shots linger, the person moves slowly, the voiceover is unhurried ("warm and unhurried, leaving room between lines").
- **Technical**: large softbox, soft even slightly warm light on a white seamless or off-white muslin backdrop, cinema-quality image with shallow depth of field on close-ups, earth-tone palette, clean close-mic'd voice with subtle ambient music.
