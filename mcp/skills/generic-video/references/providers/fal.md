# fal — provider reference for `generic-video`

`generic-video` owns the intake and the build flow; it needs one fal-specific thing.

## Verifying a model

Before you commit to a model in the intake, confirm it at runtime:

1. `recommend_model` — sanity-check the pick against the user's stated intent. Do not use it
   to choose a realism image model; `video-generation-craft`'s `references/realistic-images.md`
   and `references/providers/fal.md` own that and say why.
2. `get_model_schema` — confirm the inputs you plan to pass exist (first/last-frame support,
   audio input, the aspect-ratio enum, the duration cap).
3. `get_pricing` — get the per-call cost so the intake can disclose it.

The endpoint ids for each engine are in `video-generation-craft`'s `references/providers/fal.md`
(one table, not repeated here). The call mechanics (`run_model` / `submit_job` / `check_job`,
the `libi.sleep` poll cadence, cost disclosure, import and provenance) are
`ai-asset-generation`'s `references/providers/fal.md`.
