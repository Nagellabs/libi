# fal — provider reference for `voiceover-production`

Which kind of generation carries a voice. The audio DECISION — native audio always, carry
vs a fresh voice, the always-ask stitch gate, matching the source speaker's delivery — is
in `SKILL.md` and holds on any provider that can condition a generation on a reference
audio clip.

## Two endpoints, and only one of them can carry a voice

Seedance is served here as two endpoints that are not interchangeable:

- The **image-to-video** one animates a SINGLE start frame. It has no reference tokens and no audio
  input, so there is nothing for `@Audio1` to mean. This is the default for a first clip.
- The **reference-to-video** one takes reference ARRAYS — images cited in the prompt as
  `@Image1`… and audio cited as `@Audio1`… — and under `generate_audio: true` speaks the
  new lines in the referenced voice. Moving to this endpoint IS the carry; there is no
  parameter you can add to the first one to get it.

**A call that passes audio references and no image or video reference is rejected.** So the
`@Audio1` sample always ships alongside the beat's start frame as `@Image1` — which is what
you want anyway, since the beat needs a face as well as a voice.

## Where the ids and the limits live

The exact endpoint ids, their input key names, the per-modality limits (how many reference
files, how long, how large) and the cheaper fast tier are the **`ai-video-models`** skill's
`references/providers/fal.md`, which is the one place fal's engine→endpoint map is kept.
The `@Image1` / `@Audio1` prompt grammar is that skill's `model-seedance-2` guide. Read
them before you call anything — do not reconstruct an id from this file, and verify the
schema at runtime rather than trusting any written-down id.

Uploading the extracted sample and the start frames is the same rule as every other local
input on this provider: your fal MCP's own upload tool, never a key you read yourself. That
rule is in the same `ai-video-models` reference, under local files as inputs.
