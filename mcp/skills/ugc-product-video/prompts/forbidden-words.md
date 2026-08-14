# Forbidden words — single source of truth

This is the canonical banned-token list for UGC video work. Every other prompt
file (the Seedance platform guide in `ai-video-models`, the use-case formulas, `script-craft.md`,
`copywriting-angles.md`) references this file rather than re-listing tokens. The
`ai-asset-generation` skill carries the same image-layer list — keep them in sync
by editing here.

## The rule

1. Read the user's brief. If it contains any forbidden token, **paraphrase it
   into a visual specific before composing** — never pass the token straight into
   a model prompt.
2. To exclude something, prefer the model's **negative-prompt field** when it has
   one (Flux image models, some video models). When the model has no negative
   field (e.g. `gpt-image-2`, Seedance 2.0 prose prompts), **phrase the exclusion
   positively** — describe the real thing you want, not the thing you don't
   ("natural skin with visible pores", not "no plastic skin").
3. These bans apply to BOTH the spoken script layer and the visual prompt layer.

## Banned tokens

These words are so over-represented in AI-promoted captions that they anchor
models toward the plastic "AI look" or generic ad-speak. Strip them.

```
Script + visual layer (from arcads):
  cinematic, professional, stunning, 8k, studio, perfect

Image layer (from realistic-image-generation):
  beautiful, perfect, masterpiece, hyperrealistic, ultra-detailed,
  award-winning, flawless, studio lighting, golden hour
```

`golden hour` is a cliché that now triggers the AI aesthetic — name the actual
light instead ("low warm side light through a west window").

## Substitution table

When a banned token appears in the brief, replace it with a concrete specific:

| Banned | Replace with |
|---|---|
| `cinematic` | `dramatic`, `premium`, or name the actual look (`handheld doc`, `shallow depth`) |
| `professional` | `real`, `candid`, `clean` |
| `studio lighting` / `studio` | `natural window light`, `bathroom vanity light`, `overhead kitchen light` |
| `stunning` / `beautiful` | describe the subject concretely (`warm`, `glowing skin`, `clean lines`) |
| `8k` / `ultra-detailed` / `hyperrealistic` | `photorealistic`, `true-to-life skin texture`, `natural phone quality` |
| `perfect` / `flawless` | `natural`, `lived-in`, `real` (imperfection is the point in UGC) |
| `masterpiece` / `award-winning` | drop entirely — adds nothing, anchors the AI look |
| `golden hour` | name the light: `low warm side light`, `late-afternoon glow through blinds` |

## Why this matters

UGC sells on authenticity. The words above push the model toward glossy,
over-graded, "ad" output — the exact opposite of a real person filming on their
phone. Specificity (materials, light source, real skin cues) always beats an
adjective. See [script-craft.md](script-craft.md) for the dialogue-layer
equivalent and the Seedance 2.0 platform guide in the `ai-video-models` skill for how
the platform guide enforces this in the adaptation checklist.
