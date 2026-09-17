# fal — provider reference for `music-creation`

Paid music generation on fal, for specific style models (Stable Audio and similar). The
shared call *discipline* — the `libi.sleep` polling cadence on a long job, cost disclosure
before the first paid call, import + `aiGeneration` provenance — is `ai-asset-generation`'s
`references/providers/fal.md`; only what music generation adds is below.

## Picking and running a model

Discover the current model rather than trusting a hardcoded name — music models come and
go on fal faster than this file is updated.

- Find the model with `recommend_model` / `search_models`, confirm its inputs with
  `get_model_schema`, and price it with `get_pricing` before disclosing.
- **Known-good starting point (maintainer-updated 2026-09-09):**
  `fal-ai/stable-audio-25/text-to-audio` — text-to-music, ~$0.2 **per generation** (not per
  second), length on `seconds_total`. Treat it as a candidate to confirm with
  `get_model_schema` + `get_pricing`, never as a default to call blind: if it has moved,
  the discovery step above is the answer and this line is the stale thing.
- Run it with `run_model` (short) or `submit_job` + `check_job` (long) — poll with
  `libi.sleep`, see the `ai-asset-generation` skill's fal reference for the cadence.
- Import the result and add it with `libi.audio_add_clip`.

## When to reach for it

Reach for fal only when the user explicitly wants a specific style model. Local ACE-Step
(`libi.generate_music`) is free, on-device and the default.
