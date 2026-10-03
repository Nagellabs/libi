<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling. -->

# Seedance 2.0 — prompt rules

How Seedance reads a prompt, whatever the genre. Genre recipes (UGC, product hero, walkthrough, reveal, lookbook) sit on top of this and live in the creation skill that calls it. Endpoint ids and input names are in the provider reference; confirm them with the schema tool before submitting.

## Two endpoints, different inputs

- **image-to-video** takes ONE start frame and an optional end image. It has no token mechanism and no audio input: the start frame already is the reference, so do not write `@Image1` into its prompt (it is noise).
- **reference-to-video** takes arrays: images cited as `@Image1`, `@Image2`…, audio as `@Audio1`…, video as `@Video1`… Cite each supplied file exactly once, in the order you passed it, and state the invariant in words next to the token: "the same woman from `@Image1` in every cut", "keep the voice from `@Audio1`". Audio alone is rejected: an audio reference needs at least one image or video beside it.

Reference audio is a voice conditioner, not an overlay. How to use it across clips is in `references/voice.md`.

## Writing the prompt

- **Length 100–260 words.** Shorter drifts and goes vague; longer loses the key details.
- **Order: Subject, Action, Camera, Style, Constraints.** Subject = age, clothing, expression, posture, product. Action = present tense, one primary movement per shot. Camera = framing plus movement. Style = lighting, colour, atmosphere. Constraints = "maintain face consistency", "steady motion", "no distortion".
- **Motion needs a degree and a direction** ("slowly picks up the bottle with her right hand and turns it toward the camera"): slowly, gently, quickly, casually, deliberately. A still carries no intensity, so "moves" is never enough.
- **Anchor what must not change** in words: "the product stays visually unchanged in every shot", "keep the outfit unchanged across all cuts".
- **Style: one concrete look**, such as documentary, photorealistic, handheld, dramatic, premium. Prefer it, and named light and materials, to quality adjectives ("cinematic", "stunning", "8k"), which pull toward generic stock. UGC formats additionally ban a fixed word list (the craft reference in the `ugc-product-video` skill, which scopes it per format).
- **Exclusions go in the positive.** The prose prompt has no negative field: describe the thing you want ("a bottle with a small unbranded label area").
- **No in-video text**: leave signs, labels and captions out of the prompt and add text later as an overlay (`ai-asset-generation` owns the rule).

## Beats and duration

Duration is continuous from 4 to 15 seconds (check the schema). One prompt can hold several jump-cut beats; write them as an ordered list of actions with a pacing cue and a camera note each, and keep each to one main action:

```
A guy sits in his car holding an electrolyte packet. Medium shot, dashboard light.
Then he slowly pours it into his water bottle and shakes it. Close-up on hands.
Then he takes a sip, pauses, nods with raised eyebrows. Back to medium shot.
Finally he holds the packet up to the camera, half-smile. "Yeah, these are legit."
```

**Do not use `[00:00]` timecodes.** Seedance does not honour exact timestamps, and a block of them reads as rushed. Pacing words ("then", "pauses", "slowly") and the number of beats do that job. Two to four beats suit a 15 s clip. (Timestamp brackets are a full Veo feature, see `veo.md`.)

A line of dialogue goes in the prompt as `She says: "…"` and only in a clip generated with native audio on (see `references/voice.md`).

## First/last frame

Seedance takes the end image as a parameter on the image-to-video endpoint, not as a separate endpoint. Use it where start and end state must be exact (see `references/physical-action.md`). The field name is in the provider reference.

## Iterating

Change one thing per re-run. Action right but framing off: adjust camera only. Pacing rushed: cut dialogue or drop a beat. Product drifts: add an anchor. Motion stiff: add degree adverbs.

## Before submitting

Word count in band; order Subject to Constraints; every action has a degree and direction; invariants anchored; tokens only on reference-to-video; one concrete style; no readable text requested; no timecodes; duration and beat count fit the spoken words.
