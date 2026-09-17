# fal — provider reference for `generic-video`

`generic-video` owns the intake and the build flow; it needs one fal-specific thing.

## Verifying a model

Before you commit to a model in Step 1's intake, confirm it at runtime:

1. `recommend_model` — sanity-check the pick against the user's stated intent. Do NOT use
   it to choose a **realism image** model; `realistic-image-generation` owns that and its
   own fal reference says why.
2. `get_model_schema` — confirm the inputs you plan to pass exist (FLF support, audio
   input, aspect-ratio enum, duration cap).
3. `get_pricing` — get the per-call cost so Step 1 can disclose it.

The endpoint ids for each engine are in the **`ai-video-models`** skill's
`references/providers/fal.md` — one table, not repeated here. The call mechanics
(`run_model` / `submit_job` / `check_job`, the `libi.sleep` poll cadence, cost disclosure,
import + provenance) are `ai-asset-generation`'s `references/providers/fal.md`.
