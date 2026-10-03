# fal — provider reference for `using-storyboard`

The storyboard is deliberately provider-agnostic: `libi.model_schema_cache` action `get` /
`libi.model_schema_cache` action `save` / `libi.set_storyboard_generation` take an arbitrary
`apiUrl` + `model` and validate a spec against a cached copy of *that* API's schema. This
file only says how to fill the cache from fal and which endpoints the worked examples use.
The call mechanics (`run_model` / `submit_job` / `check_job`, the `libi.sleep` polling
cadence, cost disclosure, provenance) are `ai-asset-generation`'s
`references/providers/fal.md`; the realism image model and the per-engine endpoint table are
`video-generation-craft`'s `references/providers/fal.md`.

## Populating the schema cache

When `libi.model_schema_cache({ action: "get", apiUrl, model })` returns `!exists` or `stale`:

1. Call fal's **`get_model_schema`** for that endpoint.
2. **Normalize it to `GenFieldDef[]`** — `{ key, type, required?, options?, min?, max?,
   step?, multiple?, label?, description?, default? }` with
   `type ∈ text|number|boolean|url|enum|image|video|audio|svg|pdf`.
3. `libi.model_schema_cache({ action: "save", apiUrl, model, fields, source? })`.

Use `apiUrl: "https://fal.run"` (or the queue URL you actually submit to) so the cache key
is stable across sessions.

## Sketch-to-keyframe

Register the slot's rendered sketch with `libi.upload_file`, put it and the character
reference on fal's CDN with your fal MCP's own upload tool, then call the masked-edit
endpoint of the realism image model (`openai/gpt-image-2/edit` is the default; confirm it
with `get_model_schema`) with the sketch URL as a **loose composition reference** plus the
character URL and the card's `promptFragment`. Which model to use for realism, and why, is in
`video-generation-craft`'s `references/realistic-images.md`.

## The clip endpoints

Two clip endpoints cover most cards: `bytedance/seedance-2.0/image-to-video` when you have a
keyframe (`image_url`, plus `end_image_url` for first/last frame), and
`bytedance/seedance-2.0/reference-to-video` when a card carries `@Image1` / `@Audio1`
continuity references. Both are hints: confirm with `get_model_schema`. The full endpoint
table is in `video-generation-craft`'s `references/providers/fal.md`.
