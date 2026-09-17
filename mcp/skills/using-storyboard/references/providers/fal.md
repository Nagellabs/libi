# fal — provider reference for `using-storyboard`

The storyboard is deliberately provider-agnostic: `libi.get_model_schema_cache` /
`libi.save_model_schema_cache` / `libi.set_storyboard_generation` take an arbitrary
`apiUrl` + `model` and validate a spec against a cached copy of *that* API's schema. This
file only says how to fill the cache from fal and which endpoints the worked examples use.
The call mechanics themselves — `run_model` / `submit_job` / `check_job`, the `libi.sleep`
polling cadence, cost disclosure, provenance — are `ai-asset-generation`'s
`references/providers/fal.md`; the realism image picker is `realistic-image-generation`'s;
the per-engine endpoint table is `ai-video-models`'.

## Populating the schema cache

When `libi.get_model_schema_cache({ apiUrl, model })` returns `!exists` or `stale`:

1. Call fal's **`get_model_schema`** for that endpoint.
2. **Normalize it to `GenFieldDef[]`** — `{ key, type, required?, options?, min?, max?,
   step?, multiple?, label?, description?, default? }` with
   `type ∈ text|number|boolean|url|enum|image|video|audio|svg|pdf`.
3. `libi.save_model_schema_cache({ apiUrl, model, fields, source? })`.

Use `apiUrl: "https://fal.run"` (or the queue URL you actually submit to) so the cache key
is stable across sessions.

## Sketch-to-keyframe

Register the slot's rendered sketch with `libi.upload_file`, put it and the character
reference on fal's CDN with your fal MCP's own upload tool, then call
**`openai/gpt-image-2/edit`** with the sketch URL as a **loose composition reference** plus
the character URL and the card's `promptFragment`. `gpt-image-2` is the hardened realism
default — see the `realistic-image-generation` skill's own `references/providers/fal.md`.

## The clip endpoints

The worked examples in `SKILL.md` use Seedance:
`bytedance/seedance-2.0/image-to-video` when you have a keyframe (`image_url`, plus
`end_image_url` for FLF), `bytedance/seedance-2.0/reference-to-video` when a scene carries
`@Image1` / `@Audio1` continuity references. Full endpoint table: the `ai-video-models`
skill's `references/providers/fal.md`.
