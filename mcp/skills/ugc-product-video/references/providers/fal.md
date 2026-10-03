# fal — provider reference for ugc-product-video

The fal endpoints the UGC routes use. The craft, formats and gates are provider-neutral and live in `SKILL.md` and `prompts/`. Call mechanics (`run_model`, `submit_job`, `check_job`, polling, cost disclosure, import and provenance) are `ai-asset-generation`'s `references/providers/fal.md`; the engine endpoint map, first/last-frame input names and the realism image model are `video-generation-craft`'s `references/providers/fal.md`. This file names only what the routes need.

## The recommended model

```
RECOMMENDED: bytedance/seedance-2.0
Rationale: strong UGC physics, native audio, image and end-image first/last frame.
```

(maintainer-updated 2026-09-09.) This is what `RECOMMENDED_VIDEO_MODEL = provider-default` in `SKILL.md` resolves to on fal. To change YOUR default, fork the skill and rewrite that line in the fork's `SKILL.md` with `libi.skill` action `update`; no `libi.*` tool can write under `references/`, and a raw filesystem edit never re-syncs the agent workspace. The value is a model family: call the operation-suffixed endpoint (`bytedance/seedance-2.0/image-to-video` by default, `bytedance/seedance-2.0/reference-to-video` for voice carry or multiple references); a bare family id 404s.

Before generating, confirm the pick: `recommend_model` to sanity-check it against the brief, `get_model_schema` for inputs and first/last-frame support, `get_pricing` for the number the cost gate discloses. Do not use `recommend_model` or `search_models` to choose the realism image model (`video-generation-craft` says why).

## Endpoints by route

| Route | Endpoint |
| --- | --- |
| Swap the presenter | `fal-ai/wan/v2.2-14b/animate/replace` (input `video_url` and `reference_image_url`) |
| Restyle | `decart/lucy-restyle` (cheap; its output is silent) or `fal-ai/wan/v2.2-a14b/video-to-video` (strength controllable; audio passes through) |
| Stitch: talking beat with a voice carry | `bytedance/seedance-2.0/reference-to-video` |
| Stitch: faceless product or b-roll beat | `fal-ai/veo3.1/fast/image-to-video`, one continuous action description; timestamp brackets fail on the Fast tier with `no_media_generated` (an unbilled round trip) |
| Fresh, fully AI, one clip | the recommended model's image-to-video |
| Fresh, extend chain | `fal-ai/veo3.1/fast/extend-video`: it returns the full chain on every call (a bootstrap of 8 s extended by 7 s returns one 15 s file), so never trim it. `source_video_url` is the previous return. |
| Physical-manipulation beat | the first/last-frame endpoint in `video-generation-craft`'s provider reference |

Segments for swap, restyle and stitch are local files: trim them, then put them on fal with the fal MCP's own upload tool, and never read `FAL_KEY` or push bytes to fal storage yourself (the same applies to the `@Image1` start frame and `@Audio1` sample).

If the picked model has no extend, `get_model_schema` it for an extend, continue or video-to-video input, or look for a fal tool named `*extend*`, `*continue*` or `*video-to-video*`. With none, offer a switch to the extend endpoint above (regenerate from the bootstrap) or the multi-clip route.

## Music

Free on-device generation is the default. A paid alternative is a `music` provider's own tool: ElevenLabs music (`creative_generate_in_flow` with `node_type: "music"`, `generations_count: 1`), or a fal audio model. Add the result with `libi.audio_add_clip`, `kind: "standalone"`.
