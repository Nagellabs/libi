# fal — provider reference for ai-asset-generation

Read this when your `image`, `video` or `sfx` provider is fal: its tool names, polling cadence, pricing steps and a provenance example. The capability rules, the no-text and native-audio invariants and the import mechanics stay in `SKILL.md`; the per-engine endpoint map is `video-generation-craft`'s `references/providers/fal.md`.

## Picking a model

Call fal's `recommend_model` with the user's intent ("photorealistic talking-head video, 9:16, 6 seconds") and show the top one to three results with cost tier and a one-line summary. For a photoreal person, creator portrait or keyframe, do not use `recommend_model` or `search_models` to choose: the realism model is named in `video-generation-craft`, and you only confirm it with `get_model_schema` and `get_pricing`.

## Cost

Call `get_pricing` for the endpoint and report the per-call cost. If it is unavailable, read fal's public pricing page, multiply by quantity and say it is an estimate. Reuse the exact tier label `get_pricing` returned as `costEstimate.tier`.

## Running a job

- Short jobs (an image, a single audio): `run_model`, synchronous.
- Long jobs (video, training, batch images): `submit_job`, then `check_job` until `status === "completed"`.
- Endpoint ids are operation-specific: submit the full id including its operation suffix, for example `bytedance/seedance-2.0/image-to-video`, never a bare family id (it 404s on fal).

Between `check_job` polls wait with `libi.sleep({ seconds: 20, reason: "waiting for the fal job to finish" })` rather than a shell sleep or a self-scheduled wakeup. Cadence: 20 s for the first five polls (most fast-tier video jobs finish within them), 30 s for polls five to fifteen, then 60 s and consider asking the user before continuing. Most video jobs take 60 to 150 s; a job still in the queue after five minutes goes to the user.

## Provenance example

```jsonc
aiGeneration: {
  provider: "fal",
  model: "fal-ai/veo3.1/fast",            // the exact endpoint id you submitted
  prompt: "<the full engineered prompt, verbatim>",
  costEstimate: { amount: 0.50, currency: "USD", tier: "veo3.1-fast/720p/9:16" },
  startedAt: "2026-05-27T11:00:00.000Z",  // before submit_job
  completedAt: "2026-05-27T11:00:42.000Z", // after the download finishes
  durationMs: 42000,
  providerJobId: "req_abc123",             // fal's request_id from submit_job
  attemptNumber: 0
}
```
