# fal — provider reference for `ai-asset-generation`

Read this when your `image` / `video` / `sfx` provider is fal. It carries fal's tool
names, endpoint ids, pricing steps and prompt templates. The capability rules,
the universal video invariants (no in-video text, native audio on) and the
import/provenance mechanics stay in `SKILL.md` — follow both.

## Picking a model

Call fal's `recommend_model` tool with the user's intent (e.g. "photorealistic
talking-head video, 9:16, 6 seconds"). Show the top 1–3 results with their cost tier and
one-line summary. Let the user pick or accept the first.

> **Exception — realism images.** For a photoreal person / creator portrait / keyframe, do
> NOT use `recommend_model` / `search_models` to pick the model — the default is
> `openai/gpt-image-2` and those tools downgrade it. Load
> **`realistic-image-generation`** for the model picker, and use `get_model_schema` /
> `get_pricing` only to confirm gpt-image-2's live availability and price.

## Cost

1. Call `get_pricing` for the endpoint. Report the per-call cost it returns.
2. If the tool is unavailable, fetch `https://fal.ai/pricing`, find the per-model price,
   multiply by quantity. Always disclose that this is an estimate.

Reuse the exact tier label `get_pricing` returned as `costEstimate.tier` in the
provenance block (SKILL.md Step 9).

## Running a job

- Short jobs (image, single audio): `run_model` (synchronous).
- Long jobs (video, training, batch image): `submit_job`, then poll `check_job` every
  ~5 seconds until `status === "completed"`.
- **Endpoint ids are operation-specific.** Submit to the FULL endpoint id including its
  operation suffix (e.g. `bytedance/seedance-2.0/image-to-video`), never a bare
  model-family id — a family id without the operation suffix 404s on fal.

If the job fails, show fal's error message verbatim and ask the user how to proceed
(retry, refine, or stop).

### Use `libi.sleep` between polls — do NOT use Terminal sleep or ScheduleWakeup

When polling `check_job`, wait via
`libi.sleep({ seconds: 20, reason: "waiting for fal-ai/<endpoint> to finish" })` between
checks. This is server-side, AbortSignal-aware, and emits progress notifications every
5 s. Do NOT use `Terminal sleep N` (can hit tool-call timeouts on long waits) or
`ScheduleWakeup` (can fail to re-fire — caused the v2 round-1 3-hour ghost-wait).
Recommended cadence:

- First 5 polls: `libi.sleep({ seconds: 20 })` between each call (covers most
  veo3.1-fast jobs)
- Polls 5-15: `libi.sleep({ seconds: 30 })`
- Beyond: `libi.sleep({ seconds: 60 })` and consider asking the user before continuing

Most fal video jobs complete in 60-150 s. If a job is still IN_QUEUE after 5 min, surface
it to the user.

## Provenance

Fill SKILL.md Step 9's `aiGeneration` object with fal's values:

```jsonc
aiGeneration: {
  provider: "fal",                       // the provider catalog id
  model: "fal-ai/veo3.1/fast",           // exact endpoint id you submitted
  prompt: "<the full engineered prompt verbatim>",
  costEstimate: { amount: 0.50, currency: "USD", tier: "veo3.1-fast/720p/9:16" },
  startedAt: "2026-05-27T11:00:00.000Z", // ISO, before submit_job
  completedAt: "2026-05-27T11:00:42.000Z", // ISO, after the download finishes
  durationMs: 42000,                     // completedAt - startedAt
  providerJobId: "req_abc123",           // fal request_id from submit_job
  attemptNumber: 0                       // 0 = first attempt; bump on regen
}
```

`costEstimate` comes from `get_pricing` above; reuse that exact tier label.

## Prompt templates

### Veo 3.1 fast — model-specific prompt template

When the chosen model is `veo3.1-fast` / `veo3-fast` (default for UGC video as of
2026-05), use this exact 7-layer ordering. The model responds dramatically better when the
layers appear in this order. Length target: **100-200 words** (Veo 3.1 prioritizes elements
unpredictably above ~400 chars; under 100 chars yields generic results).

Layers, in order:

1. **Camera & lens** — shot type + movement + lens. Examples: "Handheld medium shot, 35mm lens, subtle bob", "Tight tracking shot, 85mm portrait lens, no cuts", "Slow dolly-in, 24mm wide".
2. **Subject** — lock the subject at the very start of the description. Front-load identifying details (age, gender, hair, key clothing) so Veo doesn't drift on character continuity. Reference the character image if provided.
3. **Action & physics** — ONE dominant action per clip. Veo handles "she unscrews the cap" cleanly; "she walks in, unscrews the cap, takes a sip, walks out" causes drift. Split multi-action shots into multiple clips and concat.
4. **Environment** — location, time-of-day, weather, props in shot.
5. **Lighting** — be specific. "Golden hour rim lighting", "soft north-window studio key", "neon-mixed sodium streetlight from frame-right".
6. **Style & texture** — film stock or color grade. "Shot on Kodak Portra 400 film, fine grain, warm color grade." or "Crisp digital, cool color grade, slight film emulation."
7. **Audio** — Veo 3.1 generates synchronized audio. Specify: dialogue (if any), foley (footsteps, cap-screw, liquid pour), ambient (city hum, café murmur), music tag (none / minimal pad / energetic).

Example UGC body shot:

> "Tight medium shot, 50mm lens, slight handheld bob. Subject: 30-year-old man with a short dark beard, white tee, light jeans (same character as reference image). Action: he picks up the AquaFlow bottle from a wooden desk and tilts it slightly toward camera — the glowing blue cap catches the light. Environment: small home office, mid-morning. Lighting: warm window light from frame-right, soft fill from a desk lamp on frame-left. Style: photorealistic, shallow depth of field, fine film grain. Audio: subtle ambient room tone, a soft click as he sets it down. 6 seconds, 9:16 vertical."

Negative prompt for veo 3.1: pass things to AVOID separately when the model supports it. Common UGC negative prompts: `text overlay, illegible logos, malformed hands, extra fingers, anatomically wrong, watermark, low resolution`.

Sources:
- [Google Cloud — Ultimate prompting guide for Veo 3.1](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1)
- [fal.ai — Veo3 prompt guide](https://fal.ai/learn/devs/veo3-prompt-guide-master-google-video-generation)
- [DeepMind — Veo 3 prompt guide](https://deepmind.google/models/veo/prompt-guide/)

Per-engine prompt grammar for Seedance / Veo / Kling lives in the **`ai-video-models`**
skill; this section is only the template `ai-asset-generation` used to inline.
