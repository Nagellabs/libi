# fal — provider reference for `ai-video-models`

One place for the fal-hosted ids behind the engine guides in `prompts/`. The prompt
grammar for each engine is in its own guide and is the same wherever the engine is hosted;
what changes per provider is what you call and what the input keys are named. The call
mechanics themselves (`run_model` / `submit_job` / `check_job`, the `libi.sleep` poll
cadence, cost disclosure, provenance) are `ai-asset-generation`'s
`references/providers/fal.md` — this file only maps engine → endpoint.

**Always verify at runtime.** Availability, schemas and pricing drift — `get_model_schema`
before assuming a parameter exists, `get_pricing` before disclosing a cost. Never trust a
hardcoded id as ground truth; better models ship every few weeks.

## Seedance 2.0

**Native audio: YES** (`generate_audio`, defaults **true**) — the spoken voice is baked
into the generation, and the reference endpoint below is what carries it across clips.

- **`bytedance/seedance-2.0/image-to-video`** — the default. ONE start frame (`image_url`)
  + optional `end_image_url` (first-last-frame), `prompt`, `duration` (4–15s),
  `resolution`, `aspect_ratio`, `generate_audio` (defaults **true**). **No reference-token
  mechanism and no audio input** — it animates the single start frame.
- **`bytedance/seedance-2.0/reference-to-video`** — the multi-reference endpoint, and the
  only Seedance endpoint where `@Image1` / `@Audio1` tokens mean anything. Three reference
  modalities, each cited by token in the prompt (verified live fal 2026-06-08):
  `image_urls` (JPEG/PNG/WebP, up to 9, `@Image1`…), `audio_urls` (**MP3/WAV, up to 3,
  combined duration ≤15s, ≤15 MB/file**, `@Audio1`…), and `video_urls` (MP4/MOV, up to 3,
  **combined 2–15s, <50 MB total, ~480–720p each**, `@Video1`…). **Total files across all
  modalities ≤12.** A reference *guides* the generation — audio is a voice **conditioning**
  reference (under `generate_audio: true` the model produces lip-synced speech in that voice),
  NOT a literal audio overlay. **Hard rule: if you pass `audio_urls` you MUST also pass at
  least one `image_urls` or `video_urls` entry — audio alone is rejected.** Use this endpoint
  to bind multiple reference images, to carry a voice across multi-clip generations, or to
  carry the original creator's voice into a stitch's faceless AI inserts (the Seedance guide's
  "Native audio + multi-clip voice carry").

**Cheaper "fast" tier.** Each of the two above has a real lower-cost variant —
**`bytedance/seedance-2.0/fast/image-to-video`** and
**`bytedance/seedance-2.0/fast/reference-to-video`** (verified live, ~half the price,
identical input shape incl. `generate_audio` / `end_image_url` / `duration`). These are the
right pick for an **eval / draft pass** on a tight budget — surface the choice + price to
the user (don't silently downgrade for hero/final work).
⚠️ **Known issue (2026-06-06):** a real-AI run on the `fast/image-to-video` endpoint came
back COMPLETED but its *result* 404'd via the fal MCP (the result URL dropped the
`bytedance/` vendor segment), so no usable clip landed. The endpoint is real — this is a
fal-client/result-fetch issue. Apply the **completed-but-empty guard** from the Seedance
guide, and if a fast job comes back empty, fall back to the standard (non-`fast`) endpoint
rather than re-spending on the same path.

**Endpoint paths are exact — do NOT invent tier/segment variants.** Use ONLY the four ids
above (verify each with `get_model_schema` before `submit_job` — a 404 / empty schema means
the path is wrong; never submit to an unconfirmed id).

## Veo 3.1

**Native audio: YES** — Veo 3.1 generates synchronized audio; specify dialogue and ambience
in the prompt (see the `model-veo-3-1` guide).

- **`fal-ai/veo3.1/fast/image-to-video`** — the cheap i2v tier.
- **`fal-ai/veo3.1/fast/first-last-frame-to-video`** — the dedicated FLF endpoint (same
  $0.10–0.15/s tier as i2v — verify via `get_pricing`). `veo3.1/lite/…` exists too.
- **`fal-ai/veo3.1/fast/extend-video`** — the proven extend-capable endpoint on fal.
- **Timestamp brackets DON'T work on veo3.1/fast.** The Fast endpoint misparses
  `[00:00-00:02] …` segments as missing-attachment refs and fails `no_media_generated`.
  Timestamp decomposition is a **full-Veo-3.1** feature only.

## Kling

**Native audio: NO** — Kling generates picture only, so a Kling clip needs its audio from
somewhere else. It is not a carrier for the `@Audio1` voice carry.

- **`fal-ai/kling-video/o1/image-to-video`** — start = `start_image_url`,
  end = `end_image_url`. This is Kling's FLF path. Kling 2.5 Turbo also exposes
  start/end — confirm the exact field shape via `get_model_schema` before assuming.

## Other endpoints these guides reach

- **`fal-ai/wan-flf2v`** — Wan's dedicated first-last-frame endpoint.
- **`openai/gpt-image-2`** — the realism image default (see the
  `realistic-image-generation` skill's own fal reference).

## FLF is a capability, surfaced two ways

Always confirm via `get_model_schema` before assuming:

- **Dedicated endpoint:** Veo `fal-ai/veo3.1/fast/first-last-frame-to-video`
  (`first_frame_url` + `last_frame_url`, both required); Kling
  `fal-ai/kling-video/o1/image-to-video` (`start_image_url` + `end_image_url`); Wan
  `fal-ai/wan-flf2v` (`start_image_url` + `end_image_url`, both required).
- **Parameter on the i2v endpoint:** Seedance `bytedance/seedance-2.0/image-to-video`
  takes an `end_image_url` (no separate endpoint).

**The keyframe field names differ per engine — there is no universal `end_image_url`.**
Veo's dedicated FLF endpoint takes neither `image_url` nor `end_image_url`. Always read
the schema you are about to call (`get_model_schema`) and use ITS spelling. When picking a
model, look for EITHER a `*first-last-frame*` endpoint OR an `end_image` / `end_image_url`
/ second-image input in the schema.

## Local files as inputs

A hosted endpoint needs a public `https` URL. Put a local libi file on fal's CDN with
**your fal MCP's own upload tool**, then pass the URL it returns. NEVER read `FAL_KEY` from
the DB/env/shell or `PUT`/`curl` bytes to fal storage yourself. If a remote (HTTP) fal MCP
refuses a local path (`Cannot read local files from a remote MCP server`), say so and ask
the user how to proceed — do not improvise an upload.
