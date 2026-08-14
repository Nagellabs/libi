# Model — Kling

Alternative model — used when the user overrides the Seedance 2.0 default. See
SKILL.md model-selection policy.

Kling is the Tier-1 pick for fine manipulation and close-ups: it has the best
2026 hands/close-up fidelity and the strongest object permanence, so it's the
model to escalate to when a beat keeps morphing or losing the product mid-motion.
Verify capabilities + pricing at runtime via fal `recommend_model` /
`get_model_schema` / `get_pricing` — never trust a hardcoded model id; better
models ship every few weeks.

Banned tokens (script + visual layers): see the `forbidden-words.md` prompt in the
`ugc-product-video` skill. Paraphrase any banned token in the brief before composing.

## First-last-frame (FLF) is the primary path

For a manipulation beat, pinning the END state is the structural fix for "object
disappears mid-motion" — Kling is forced to arrive at the final state instead of
improvising. Endpoint: `fal-ai/kling-video/o1/image-to-video`, where:

- `@Image1` = the **start** frame (first image)
- `@Image2` = the **end** frame (last image)

Kling 2.5 Turbo also exposes start/end inputs — confirm the exact field shape via
`get_model_schema` before assuming. Generate clean start + end keyframes, then
**Vision-Read both** and confirm anatomy + product geometry BEFORE spending video
credits — the output is only as stable as the keyframes; flaws compound.

## Three-action maximum per clip

Kling degrades when a single clip stacks too many actions — keep to **three
actions maximum per clip**, ideally ONE dominant action for a manipulation beat.
Split compound actions into separate clips and concat (`libi.concat_videos`).
Always give a terminating motion verb + explicit end state ("presses the strip
flat onto the nail and holds it there") and an object-permanence anchor ("the
named object remains visible in her hand and on the nail throughout; product
shape and label preserved"). Open-ended motion without a termination can hang
Kling generation at 99%.

## B-roll and scene use

Beyond manipulation beats, Kling is a solid choice for b-roll and scene shots
where object permanence and clean close-ups matter (product on a surface, a hand
reaching in, a slow reveal). Keep the product large in frame — small objects
morph — and lock a macro/close shot so it can't drift out of frame. Reuse the
same character/product reference image and repeat the named product verbatim
across clips ("the matte-white nail box", never "the box") so Kling doesn't
re-invent its appearance between independently-generated clips.

Surgical negative prompt (don't over-stuff): `morphing, warping, shifting
textures, flickering, floating objects, object disappearing, distorted label,
extra fingers`.
