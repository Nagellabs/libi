# fal — provider reference for `ugc-product-video`

The concrete fal endpoints this skill's routes and model policy use. The creative craft —
ad formats, beat sheets, the dialogue gate, forbidden words, the Stage 4.5 validation gate —
is in `SKILL.md` and its `prompts/` and applies on any provider. The call mechanics
(`run_model` / `submit_job` / `check_job`, the `libi.sleep` poll cadence, cost disclosure,
import + provenance) are `ai-asset-generation`'s `references/providers/fal.md`; the full
per-engine endpoint table (Seedance / Veo / Kling input keys, the `fast` tiers, local files
as inputs) is `ai-video-models`' `references/providers/fal.md`; the first-last-frame default
and the escalation ladder for a manipulation beat are `physical-action-video`'s
`references/providers/fal.md`. This file names only what the UGC routes need.

## The RECOMMENDED model (maintainer-updated 2026-09-09)

```
RECOMMENDED: bytedance/seedance-2.0
Rationale: strongest 2026 UGC physics + native audio + image/end-image FLF.
```

This is what `RECOMMENDED_VIDEO_MODEL = provider-default` in `SKILL.md` resolves to on
fal. To change YOUR default, fork the skill and rewrite that line in the fork's
`SKILL.md` with `libi.update_skill` — not this file: no `libi.*` tool can write under
`references/`, and a raw filesystem edit here never re-syncs the agent workspace.

> The value above is the model **family** — when generating, call the suffixed endpoint
> `bytedance/seedance-2.0/image-to-video` (default) or
> `bytedance/seedance-2.0/reference-to-video`; passing the bare id (no operation suffix) to
> a run/submit tool 404s on fal.

## Verifying the model

Before generating, confirm the pick at runtime:

- `recommend_model` — sanity-check the pick against the brief.
- `get_model_schema` — confirm inputs and FLF support.
- `get_pricing` — get the number the cost gate discloses.

Do NOT use `recommend_model` / `search_models` to choose the **realism image** model; the
`realistic-image-generation` skill's own fal reference owns that and says why.

## Production routes

| Route | fal endpoint |
|---|---|
| **A** — character-swap on source | `fal-ai/wan/v2.2-14b/animate/replace` (no other strong option) |
| **B** — restyle on source | `decart/lucy-restyle` (cheap, $0.01/sec) or `fal-ai/wan/v2.2-a14b/video-to-video` (strength controllable) |
| **C** — AI infills that mimic the source | `fal-ai/veo3.1/fast/image-to-video` (identity-filter avoided via image-to-video + action-only prompts) |
| **D** — generate from scratch with an extend chain | `fal-ai/veo3.1/fast/extend-video` — the only proven extend-capable model on fal today |
| **E** — any i2v model the user picked that lacks extend | kling, hunyuan, etc. |
| character beat with voice carry | `bytedance/seedance-2.0/reference-to-video` (native audio + voice carry) |
| faceless product / b-roll beat | `fal-ai/veo3.1/fast/image-to-video` |
| physical-manipulation beat | first-last-frame — `physical-action-video`'s `references/providers/fal.md` names the default endpoint and the escalation ladder; do not re-state the id here |

**Route A/B inputs are the trimmed source segment.** Upload it to fal CDN via `fal-ai.upload_file`
→ segment URL, then pass it as `video_url`. Route A takes `reference_image_url` = the character
ref portrait from Stage 1. Route B's `decart/lucy-restyle` output is silent — Lucy drops the
audio track; Wan v2v passes audio through.

**Route C local inputs** (the new character's start frame as `@Image1`, the main character's
voice sample as `@Audio1`): both LOCAL files → the fal MCP's own upload tool first — NEVER
read `FAL_KEY` or `curl` fal storage yourself.

**veo3.1/fast prompt format (Fast ≠ full Veo 3.1):** feed ONE continuous action description.
Do NOT use timestamp-bracketed multi-beat decomposition (`[00:00-00:02] …`) — the Fast
endpoint misparses the brackets as missing-attachment refs and returns `no_media_generated`
/ Unprocessable Entity (a failed, unbilled round-trip). Timestamp decomposition is a
full-Veo-3.1 feature only.

**The extend chain returns the FULL clip on each call — do NOT trim.** Veo 3.1's
`extend-video` endpoint returns the full chain on every call, not just the new tail. So if
your bootstrap was 8 s and you extend by 7 s, the return is a single 15-second file containing
the full bootstrap+extension. Each extend call takes `source_video_url` = the previous
extend's output (or the bootstrap clip on the first iteration).

## Extend support

If the picked model is NOT `fal-ai/veo3.1/fast/extend-video`, call `get_model_schema` on it
and look for an extend / continue / video-to-video capability. If it has none, offer the
user (a) switch to `fal-ai/veo3.1/fast/extend-video` (recommended — the proven path,
regenerate from the bootstrap) or (b) stay on their model and take Path E. You can also
inspect your own tool list for a fal tool name matching `*extend*`, `*continue*` or
`*video-to-video*` — one fewer artifact and no codec mismatch.

## Polling and provenance

Wait via `check_job`, fetch the result URL, download to a temp path. Between `check_job` polls
use `libi.sleep({ seconds: 20 })` — see the `ai-asset-generation` skill's fal reference for the
full cadence and the `aiGeneration` provenance example (`provider: "fal"`, `model:` the exact
endpoint id you submitted — e.g. `fal-ai/wan/v2.2-14b/animate/replace` on route A,
`fal-ai/veo3.1/fast/image-to-video` for the bootstrap and `fal-ai/veo3.1/fast/extend-video`
for every extend take on route D — `costEstimate:` from `get_pricing`, `providerJobId:` fal's
`request_id`).

## Music

`local-music` (free, ACE-Step, on-device) is the default. A paid alternative is a `music`
provider's own tool — ElevenLabs `compose_music`, or a fal audio model. Add the result via
`libi.audio_add_clip` with `kind: "standalone"`.
