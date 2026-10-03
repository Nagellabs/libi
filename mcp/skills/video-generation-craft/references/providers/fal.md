# fal — provider reference for video-generation-craft

The fal endpoint ids and input names behind the engine guides, the first/last-frame table, the realism image model and the engines a hard beat escalates through. The prompt grammar for each engine is in its own guide and is the same wherever the engine is hosted. The call mechanics (`run_model`, `submit_job`, `check_job`, polling, cost disclosure, import and provenance) are in `ai-asset-generation`'s `references/providers/fal.md`; this file only maps engine to endpoint.

**Verify at runtime.** Availability, schemas and prices drift and better models ship every few weeks: `get_model_schema` before assuming an input exists, `get_pricing` before disclosing a cost. Treat any id written here as a hint. Submit only to an id the schema tool confirms; a 404 or an empty schema means the path is wrong. Never invent a tier or segment variant.

## Seedance 2.0

**Native audio: YES** (`generate_audio`, default true). The reference endpoint below is what carries a voice across clips.

- `bytedance/seedance-2.0/image-to-video` is the default: one start frame (`image_url`), optional `end_image_url` for first/last frame, `prompt`, `duration` (4 to 15 s), `resolution`, `aspect_ratio`, `generate_audio`. No reference tokens and no audio input.
- `bytedance/seedance-2.0/reference-to-video` is the only endpoint where `@Image1`, `@Audio1`, `@Video1` mean anything: `image_urls` (up to 9), `audio_urls` (MP3 or WAV, up to 3, combined at most 15 s, at most 15 MB each), `video_urls` (MP4 or MOV, up to 3, combined 2 to 15 s, under 50 MB, 480 to 720p each); at most 12 files across all three. A reference guides generation (audio conditions the voice, it is not an overlay). **Passing `audio_urls` without at least one image or video reference is rejected.**
- A cheaper `fast` tier of each exists (`bytedance/seedance-2.0/fast/image-to-video`, `bytedance/seedance-2.0/fast/reference-to-video`) with the same inputs: fine for a draft or eval pass on a tight budget; tell the user the choice and price, and do not downgrade final work silently. If a fast job completes but its result URL 404s, treat it as failed and run the standard endpoint rather than re-spending on the same path.

## Veo 3.1

**Native audio: YES.** Specify dialogue and ambience in the prompt.

- `fal-ai/veo3.1/fast/image-to-video` is the cheap image-to-video tier.
- `fal-ai/veo3.1/fast/first-last-frame-to-video` is the dedicated first/last-frame endpoint; confirm its price with `get_pricing`.
- `fal-ai/veo3.1/fast/extend-video` extends a clip (how its return is handled is in `ugc-product-video`'s provider reference).
- Timestamp brackets are a full-model feature and fail on the Fast tier (see `references/engines/veo.md`).

## Kling

**Native audio: NO.** Picture only; it cannot carry a voice.

- `fal-ai/kling-video/o1/image-to-video` is its first/last-frame path (`start_image_url`, `end_image_url`). Other Kling tiers expose start and end too; check the schema.

## First/last frame: the input names

A first/last-frame call is either a dedicated endpoint or an end-image input on the ordinary image-to-video endpoint. **The input names differ per engine, and there is no universal `end_image_url`.** Passing the wrong name drops both keyframes silently and you get an unanchored clip. Read the schema you are about to call with `get_model_schema` and use its spelling.

| Engine | Endpoint | Inputs |
| --- | --- | --- |
| Veo | `fal-ai/veo3.1/fast/first-last-frame-to-video` | `first_frame_url` and `last_frame_url`, both required, with `prompt` |
| Kling | `fal-ai/kling-video/o1/image-to-video` | `start_image_url` and `end_image_url` |
| Wan | `fal-ai/wan-flf2v` | `start_image_url` and `end_image_url`, both required |
| Seedance | `bytedance/seedance-2.0/image-to-video` | `image_url` plus `end_image_url` (no separate endpoint) |

When choosing a model, look for either a first/last-frame endpoint or an `end_image` or second-image input in the schema.

## Escalation ladder for a hard beat

A starting guess, not a ranking: find the current strongest with `recommend_model`, `search_models`, `get_model_schema` and `get_pricing` (query for first-last-frame, fine object manipulation, hands).

- **Tier 0:** `fal-ai/veo3.1/fast/first-last-frame-to-video` with the prompt discipline in `references/physical-action.md`.
- **Tier 1:** Kling start/end frame, for hands, close-ups and object permanence.
- **Tier 2:** Seedance 2.0, strong physics, first/last frame through `end_image_url`.

## Realism images

`openai/gpt-image-2` is the default for any realism image: the strongest at realism, prompt adherence and correct anatomy (hands, fingers), and it is hosted on fal, so it uses the fal sign-in and needs no separate OpenAI key. It takes no negative-prompt field; phrase exclusions positively. `openai/gpt-image-2/edit` does a masked inpaint or outpaint to fix one region instead of re-rolling.

**Do not let `recommend_model` or `search_models` choose the image model.** They rank by capability and novelty, and on live fal they put other models first for a UGC portrait without mentioning this one; an agent that took the top hit shipped a mangled hand. Use `get_model_schema` and `get_pricing` only to confirm availability and price. Only if the schema shows it unavailable, fall to `fal-ai/nano-banana-2` or `fal-ai/flux-2-pro` (weaker adherence and anatomy), or `fal-ai/flux-pro/v1.1-ultra` with `raw: true` for a candid look. Do not use `fal-ai/flux/dev`.

Flux models take a negative-prompt field. Supply:

```
plastic skin, waxy skin, airbrushed, smooth skin, symmetric face, perfect teeth,
glossy, 3d render, cgi, illustration, painting, oversaturated, bokeh blur,
studio backdrop, professional headshot, model pose, AI generated, beauty filter, HDR
```

## Checking generated video

`fal-ai/video-understanding` runs the physics check on a clip; run it on your own fal tools and save the verdict with `libi.analysis_save` action `summary` (the `video-analysis` skill's paid flow).

## Local files as inputs

A hosted endpoint needs a public https URL. Put a local libi file on fal's CDN with the fal MCP's own upload tool and pass the URL it returns. Never read `FAL_KEY` from the database, environment or shell, and never PUT or curl bytes to fal storage yourself. If a remote fal MCP refuses a local path ("Cannot read local files from a remote MCP server"), say so and ask the user how to proceed; do not improvise an upload.
