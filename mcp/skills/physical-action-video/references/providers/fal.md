# fal — provider reference for `physical-action-video`

The concrete endpoints behind this skill's FLF-first approach and its escalation ladder.
The craft — decomposition, object anchoring, terminating verbs, the editorial fallback —
is in `SKILL.md` and applies on any provider. The full per-engine endpoint table is
`ai-video-models`' `references/providers/fal.md`; the call mechanics (`run_model` /
`submit_job` / `check_job`, the `libi.sleep` poll cadence, cost disclosure, import +
provenance) are `ai-asset-generation`'s `references/providers/fal.md`. This file names
only what the ladder needs.

## First-last-frame

The skill's default FLF endpoint is **`fal-ai/veo3.1/fast/first-last-frame-to-video`**
(same $0.10–0.15/s tier as i2v — verify via `get_pricing`).

**FLF is a capability, surfaced differently per model — always confirm via
`get_model_schema` before assuming.** Two shapes exist:

- **Dedicated endpoint:** Veo `fal-ai/veo3.1/fast/first-last-frame-to-video` (and
  `veo3.1/lite/...`) — fields are `first_frame_url` + `last_frame_url`, and BOTH are
  required alongside `prompt`; Kling `fal-ai/kling-video/o1/image-to-video`
  (`start_image_url` + `end_image_url`); Wan `fal-ai/wan-flf2v` (`start_image_url` +
  `end_image_url`, both required).
- **Parameter on the i2v endpoint:** Seedance `bytedance/seedance-2.0/image-to-video`
  takes an `end_image_url` (no separate endpoint).

**The field names differ per engine — there is no universal `end_image_url`.** Veo's
dedicated FLF endpoint does NOT take `image_url`/`end_image_url`; passing those silently
drops both keyframes and you get an unanchored clip. Always read the schema you are about
to call (`get_model_schema`) and use ITS spelling. When picking a model, look for EITHER a
`*first-last-frame*` endpoint OR an `end_image` / `end_image_url` / second-image input in
the schema.

## Timestamp brackets

**Timestamp brackets DON'T work on veo3.1/fast.** The Fast endpoint misparses
`[00:00-00:02] …` segments as missing-attachment refs and fails `no_media_generated`.
Timestamp decomposition (the Veo official guide's technique) is a **full-Veo-3.1** feature
only. On Fast, use FLF + a single transition sentence instead.

The nail-wraps QA that produced this skill sent a fine-manipulation beat text-only to
`veo3.1/fast/image-to-video` with a run-on multi-action prompt and no end-state pin; the
press-on strip wiggled and then disappeared mid-application.

## The escalation ladder

**The model names below are dated examples (2026-05), NOT a fixed ranking — discover the
current strongest one at runtime** via fal `recommend_model` / `search_models` /
`get_model_schema` / `get_pricing` (query for "first-last-frame" / "fine object
manipulation" / "hands"), and prefer whatever fal currently ranks top. Better models ship
every few weeks; never assume a hardcoded id is still best or even present.

- **Tier 0:** `fal-ai/veo3.1/fast/first-last-frame-to-video` + the prompt discipline in
  SKILL.md section B.
- **Tier 1:** **Kling** start/end frame — best 2026 hands/close-up + object-permanence.
  FLF endpoint: `fal-ai/kling-video/o1/image-to-video` (`start_image_url` = start,
  `end_image_url` = end); Kling 2.5 Turbo also exposes start/end.
- **Tier 2:** **Seedance 2.0** (ByteDance, newest, strong physics) — FLF via the
  `end_image_url` param on `bytedance/seedance-2.0/image-to-video`.
- **Ceiling:** Sora 2 Pro (physics leader) — only if confirmed live on fal (reported API
  sunset ~Sept 2026).

## Tool inventory

- Image gen for the start/end keyframes — see the `realistic-image-generation` skill's fal
  reference (`openai/gpt-image-2`).
- `…/first-last-frame-to-video` endpoints, or `end_image_url` on an i2v endpoint, for FLF.
- `recommend_model` / `get_model_schema` / `get_pricing` to find and price the ladder models.
- `fal-ai/video-understanding` for the physics-QA pass (Stage 4.5) — run it on your own fal
  MCP and save the verdict with `libi.analysis_save_summary`; see the `video-analysis`
  skill's flow (B).
