# fal — provider reference for `realistic-image-generation`

The realism model to use on fal, and why fal's own discovery tools must not pick it.
The craft — banned tokens, the selfie and demographic templates, the anatomy pre-check,
the A/B/C validation rubric — is in `SKILL.md` and applies whatever the provider. The
call itself (schema, cost disclosure, run, import + provenance) is
`ai-asset-generation`'s `references/providers/fal.md`.

## The realism model

**`openai/gpt-image-2` is the hardened default for any realism image — do NOT let
`recommend_model` OR `search_models` downgrade it.** Image models are the foundation of
the whole video (FLF and i2v only interpolate/animate the still you give them), so a weak
or wrong keyframe poisons everything downstream. gpt-image-2 is the strongest at realism,
prompt-adherence, and — critically — **correct anatomy** (hands, fingers). A weaker model
botched the anatomy in a real run (a nail file rendered passing *through* a finger),
which is exactly why this is not negotiable.

Order of preference (gpt-image-2 first, always):

1. **`openai/gpt-image-2`** — OpenAI's GPT Image 2, **hosted on fal** (uses your fal
   key — does NOT require a separate `OPENAI_API_KEY`). Strongest realism +
   prompt-adherence + the only model that reliably renders correct anatomy and on-image
   text. There's also `openai/gpt-image-2/edit` (masked inpaint/outpaint) for fixing one
   bad region instead of re-rolling. No negative-prompt field — phrase exclusions
   positively. **This is the default for any realism image — the FIRST image-generation
   call in any UGC/realism flow MUST target `openai/gpt-image-2`; pick it without asking
   `recommend_model` / `search_models` which model to use.**
2. **`fal-ai/nano-banana-2` / `fal-ai/flux-2-pro`** — capable, but weaker prompt-adherence
   and anatomy than gpt-image-2 (nano-banana-2 mangled a hand-with-file macro in QA;
   flux-2-pro produced an anatomically-impossible "palms-out showing fingernails" image).
   Use only if gpt-image-2 is unavailable.
3. **`fal-ai/flux-pro/v1.1-ultra`** with `raw: true` — proven previous-generation candid
   look.

Do NOT use `fal-ai/flux/dev`.

## Why not the recommendation tools

`recommend_model` AND `search_models` optimize for "a model that can do the task" or
"what's newest/trendy," NOT for top realism — on **live fal** both surface
`fal-ai/nano-banana-2` (and Flux variants) at the top for a UGC portrait and never even
mention gpt-image-2. An agent that "preferred the recommendation" / "took the top search
hit" shipped the mangled-hand image, and a real-mode run on 2026-06-06 picked
nano-banana-2 from `search_models` without surfacing gpt-image-2 at all. **Do NOT call
`recommend_model` or `search_models` to CHOOSE the realism image model — you already know
it's `openai/gpt-image-2`. Use the fal tools only to confirm gpt-image-2's live
availability + price (`get_model_schema` / `get_pricing`), never to pick a different model
over it.** Only fall to the alternates above if `get_model_schema` shows gpt-image-2 is
genuinely unavailable on the account.

**Budget vs. quality — surface it, don't silently downgrade.** The keyframes are the
foundation, so they're the highest-leverage place to spend. gpt-image-2 costs more than
flux-2-pro. If the user gave a tight budget, do NOT just quietly pick flux-2-pro — state
the choice in one line ("I'll use gpt-image-2 for the keyframes — strongest realism, ~$X
each; or flux-2-pro to save ~$Y if you'd rather keep it cheap") and let them decide.
Default to gpt-image-2 when budget isn't a stated constraint.

## Negative prompts (Flux models)

Flux models take a separate negative-prompt field. Supply:

```
plastic skin, waxy skin, airbrushed, smooth skin, symmetric face,
perfect teeth, glossy, 3d render, cgi, illustration, painting,
oversaturated, bokeh blur, studio backdrop, professional headshot,
model pose, AI generated, deepfake, instagram filter, beauty filter, HDR
```

`gpt-image-2` doesn't accept negative prompts — for it, phrase every exclusion positively
(e.g. "with realistic skin texture and visible pores", not "no plastic skin").

## Fixing one region instead of re-rolling

When validation grades a C for one localized flaw, `openai/gpt-image-2/edit` does a masked
inpaint/outpaint — cheaper and less disruptive than a full regeneration. Loop until A/B;
each attempt counts against `batchCap`.
