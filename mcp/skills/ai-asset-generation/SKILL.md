---
name: ai-asset-generation
description: "Produce ONE AI asset (image / video / audio / 3D) via a generation MCP (fal.ai, etc.) — the call + save layer: discover provider, pick model, read schema, disclose cost, build the prompt, run + poll, and import the file with provenance. Also owns the two universal video invariants: no in-video text, native audio on. The realism-image craft and the physical-action/FLF craft live in their own skills (realistic-image-generation, physical-action-video); the keyframe→clip WORKFLOW belongs to the Storyboard."
when_to_use: User asks to generate / create / make an image, video, audio clip, voiceover, sound effect, music, or 3D asset using AI — or an orchestration/storyboard skill needs to actually produce one asset. Triggers on phrases like "generate an image of", "make a video of", "create a sound effect", "design a logo".
tags:
  - generation
---

# AI Asset Generation (produce one asset — the call + save layer)

This skill is the **mechanics** layer: how to actually call a generation model and save the
result. It does NOT own the video WORKFLOW (which asset to make when, keyframe→clip sequencing) —
that is the **`using-storyboard`** skill. It also does not own the deep craft — those live in
focused skills the orchestration pulls:

- **`realistic-image-generation`** — how to make a good realistic image / keyframe (gpt-image-2
  picker, anti-AI-look tokens, selfie/demographic templates, anatomy plausibility + validation).
- **`physical-action-video`** — how to make a hard physical-manipulation beat survive (FLF-first,
  prompt decomposition, model-escalation ladder, editorial fallback).

What stays HERE: provider/model/cost mechanics, prompt building, run/poll, import + provenance,
and the two **universal video invariants** (no in-video text; native audio on — Step 6.6).

> **Related:** If the request features a recurring character or item — a named person, a specific product, a recurring prop, regardless of video type — check the `using-character-library` skill first and proactively surface any catalog match. The cross-piece catalog may already have a representative image you can use as a reference for image-to-image or character-consistent generation, saving a fresh generation entirely.

Use this skill any time the user asks to generate visual, audio, or 3D content with AI. Do not call generation-MCP tools directly — work the steps below in order so the user gets a usable asset on the first or second try instead of burning credits on prompt drift.

## Step 1 — Discover providers

Call `libi.list_mcp_servers`. From the result, identify enabled servers that match the requested modality:

| Modality            | Known providers                                          |
| ------------------- | -------------------------------------------------------- |
| image               | fal-ai                                                   |
| video               | fal-ai                                                   |
| audio: speech / voiceover | **local-tts (default, free, on-device)**, elevenlabs (opt-in / cloning) |
| audio: SFX                | elevenlabs, fal-ai                                       |
| music                     | **local-music (default, free, on-device)**, elevenlabs / licensed (opt-in) |
| 3D                  | fal-ai                                                   |

If no provider is enabled for the requested modality, tell the user:

> "I don't see a generation MCP enabled for {modality}. Open Settings → MCP Servers to enable fal.ai (you'll need a fal API key from https://fal.ai/dashboard/keys)."

Then call `libi.show_mcp_settings({ mcpId: "fal-ai" })` and stop.

## Step 1.6 — Separate voiceover track uses local TTS by default

> **Read Step 6.6 first.** A separate voiceover track is NOT the default for an AI
> video that has a speaking presenter — those clips carry **native audio** (`generate_audio
> = true`, see Step 6.6). Step 1.6 is only for a *standalone* spoken track: narration over
> b-roll, an explicit "add a voiceover" request, or the opt-in replacement when the user
> toggled native audio off.

For a standalone narration / voiceover track the default speech provider is local
Kokoro TTS (free, on-device). **UGC voice + voiceover-over-the-whole-video is owned
by the `voiceover-production` skill** (Kokoro is never the UGC voice; ElevenLabs,
ASK if no key) — load it rather than deciding here.

1. Call `libi.generate_speech({ text, pieceId })`. Voice defaults to
   `af_heart`. Pass `withTimestamps: true` when you'll build caption/timeline
   overlays from the result's `words` array.
2. If it returns `status: "needs_install"`, call
   `libi.get_install_plan({ mcpId: "local-tts" })`, follow it (it calls
   `libi.tts_download_model()`), then retry the same `generate_speech` call.
3. To offer or change the voice, call `libi.tts_list_voices` and pass
   `voice`. Skip Steps 3–5 (model pick / quantity / cost) — local TTS has no
   per-call cost. Continue at Step 9 (Import) — `generate_speech` already
   returns `{ file: <FileRecord> }`, so no separate import step is needed.

SFX and music still follow the normal provider flow below.

For the native audio on generated *video* clips (distinct from a separate TTS voiceover track), see **Native audio default** in Step 6.6.

## Step 1.7 — Music uses local generation by default

For background music / score, the default is **local ACE-Step** — free,
on-device, no API key, Apache-2.0. Do **not** route music to a paid
provider unless the user explicitly asks or supplies their own licensed
track.

1. Call `libi.generate_music({ prompt, durationSeconds?, pieceId })`.
   Duration defaults to ~30s. Pass `lyrics` for sung vocals or
   `instrumental: true` for a bed.
2. If it returns `status: "needs_install"`, **tell the user the download
   size from the payload (~5.5 GB) and get approval**, then call
   `libi.get_install_plan({ mcpId: "local-music" })`, follow it (it calls
   `libi.music_download_model()`), and retry.
3. If it returns `status: "confirm_duration"`, tell the user the
   `estimatedSeconds` and re-call with `confirm: true` (the job is
   cancellable).
4. If it returns `status: "model_load_failed"`, call
   `libi.music_download_model({ force: true })`, then retry once.
5. Use `libi.music_list_styles` for style hints. Skip Steps 3–5 (model
   pick / quantity / cost) — local music has no per-call cost. The result
   is a stored audio file; add it with `libi.add_audio_track`.

Paid/licensed music follows the normal provider flow only on explicit
request.

## Step 2 — Choose the provider

If multiple enabled providers support the modality, ask the user which one. If only one matches, use it without asking.

## Step 3 — Choose the model

For fal.ai: call the provider's `recommend_model` tool with the user's intent (e.g. "photorealistic talking-head video, 9:16, 6 seconds"). Show the top 1–3 results with their cost tier and one-line summary. Let the user pick or accept the first.

> **Exception — realism images.** For a photoreal person / creator portrait / keyframe, do NOT
> use `recommend_model` / `search_models` to pick the model — the default is `openai/gpt-image-2`
> and those tools downgrade it. Load **`realistic-image-generation`** for the model picker.

For ElevenLabs (audio only): the model is implicit; pick the voice instead (see ElevenLabs MCP `list_voices`).

## Step 4 — Quantity

Ask how many variants to generate (default 1 for video/audio, 4 for image). Skip if the user already specified.

## Step 5 — Cost

Default message:

> "This will cost credits from {provider}."

If the user asks for an estimate, do this in order:

1. Try the provider's pricing tool (fal.ai exposes `get_pricing`). Report the per-call cost it returns.
2. If no tool is available, fetch the provider's pricing page (`https://fal.ai/pricing` for fal). Find the per-model price; multiply by quantity. Always disclose this is an estimate.

## Step 6 — Prompt engineering

Ask the user only the questions you don't already have answers to from prior turns. Use this structured set:

- **Subject** — who or what is in the asset?
- **Action** — what is happening?
- **Environment** — where, time of day, weather, indoor/outdoor?
- **Style** — photorealistic / cinematic / illustrated / 3D / specific artist references?
- **Lighting** — golden hour / neon / soft studio / harsh midday?
- **Camera** (video only) — lens (35mm / 85mm / wide), angle (eye-level / low / overhead), movement (handheld / static / dolly-in / orbit)?
- **Mood** — energetic / calm / mysterious / playful?
- **Aspect ratio + resolution + duration** — for video: 9:16 vertical, 1:1 square, or 16:9 landscape; resolution; clip length in seconds.
- **Continuity references** — if the user has a character, product, or style reference image, ask them to upload it (use `libi.upload_file`). For fal models that accept image/audio inputs (`image_urls`, `audio_urls`), the model needs a fal-hosted `https` URL, so a LOCAL libi file must reach the fal CDN first.
  - **To put a local libi file on the fal CDN, call `libi.upload_file_to_fal({ fileId })`** — it returns a fal `https://…fal.media/…` URL (cached on the file, so repeat calls are free). The FAL key is handled **server-side**; you never see or send it. Pass the returned URL as the model's `image_urls`/`audio_urls` input. This is the ONLY sanctioned way to upload a local reference.
  - **NEVER do the fal upload yourself.** Do NOT read `FAL_KEY` (or any provider key) out of the database, env, settings, or shell; do NOT request a signed upload URL or `PUT`/`curl` bytes to fal storage; do NOT set an `Authorization` header. Provider credentials stay inside the server/MCP boundary — handling raw keys yourself is a security breach, even with good intent. The fal-ai MCP's own `upload_file` also fails on local paths (`Cannot read local files from a remote MCP server`) — use `libi.upload_file_to_fal` instead. Only fal-hosted URLs (or other public `https` URLs) work as fal inputs.
- **Negative prompts** — if the model supports them, ask what to avoid.

## Step 6.5 — Realistic images / keyframes → `realistic-image-generation`

When the asset is a **realistic image** — a photoreal person, a creator portrait (mandatory for
`ugc-product-video` Stage 1), a character/product reference, or an FLF start/end keyframe — load
the **`realistic-image-generation`** skill and follow it. It owns the model picker (gpt-image-2
default — do NOT let `recommend_model`/`search_models` downgrade it), the anti-"AI-look" banned
tokens + Flux negative prompts, the UGC selfie + demographic templates, and the mandatory
prompt-plausibility (anatomy) pre-check + post-generation image validation. The image is the
foundation of the whole video (FLF / i2v only animate the still you give them), so do not wing it
from memory here.

## Step 6.6 — Universal video generation rules (no in-video text · native audio)

These two rules apply to EVERY AI video generation, on every path and every orchestration skill.
(Physical-action *decomposition* and the FLF *manipulation* ladder are craft — they live in
**`physical-action-video`**; see Step 6.7 below.)

### MANDATORY — no text in generated video (applies to ALL prompts, every path)

Current SOTA video models (Veo 3.1, Sora, Kling, Hunyuan) reliably break on text rendering — letters scramble, words swap, signs look fake. The failure is per-frame visible and was the second issue surfaced in the v2.1 round-2 AquaFlow QA: a product-name fragment on the bottle scrambled letters across the chain.

**Rule:** include in EVERY video prompt some variant of:

> `no on-screen text, no captions, no signs, no labels in the background, no readable text on any object`

Place it in the negative-prompt field when the model supports one (Flux, Hunyuan); otherwise append it as a clause to the positive prompt.

**If a beat needs text** (product name visible on packaging, CTA, beat caption, end-card title, etc.):
- Generate the video text-free.
- After Stage 4.5 passes, add the text as a libi text overlay via `libi.add_overlay({ kind: "text" })`.
- Stage 8 verify gate (in `ugc-product-video`) checks that planned `textOverlay` fields on beats have corresponding `add_overlay (kind "text")` calls — see that skill's Stage 8.

**No exceptions.** This applies to paths A / B / C / D / E identically. Even if the source clip in path A has visible text, the wan-animate-replace output will degrade that text — accept the trade or mask via overlay.

### Native audio default — generate video clips WITH voice (universal, every skill)

**This is the single source of truth for AI-video audio. It applies to EVERY orchestration skill
that generates AI video — `ugc-product-video`, `generic-video`, `music-video-creation`,
`mimic-video` — not just one route. Those skills reference this rule; they do not override it.**

When generating **any AI video clip on a model with native audio** (Seedance 2.0, Veo 3.1):
- **Default `generate_audio = true`.** If the beat has dialogue or a speaking presenter, the voice
  is generated natively, baked into the clip. Do NOT set `generate_audio = false` to "keep it
  clean" or to "add the voice later" — a talking beat with no voice is a defect, not a clean
  result. Generate the native voice first, then let the user judge it.
- **Toggle-off is an explicit user opt-in, not your default.** The user may say "make it silent"
  or "I'll add my own voiceover" — only then set `generate_audio = false` and add a separate voice
  overlay with a different model. Defaulting to silent + a separate VO wastes a generation and
  breaks the user's mental model.
- **A separate / replacement voice is opt-in**, not the first pass — only when the native voice is
  poor or the user wants a cloned/branded voice. Re-voicing a finished video (clone or new voice,
  with lip-sync) is owned by the **`voice-replacement`** skill (user-triggered); the generation-time
  native-vs-carry policy is `voiceover-production`. Don't decide audio replacement here.
- **Silent beats are fine when the beat is silent by design** (pure b-roll / product macro with no
  spoken line) — this rule targets spoken beats, not ambient-only shots. A silent beat still leaves
  `generate_audio = true` so ambient/SFX is rendered; just write no dialogue.

**Prompt ↔ audio coherence (mandatory).** If you write spoken lines in a prompt (`She says: "…"`),
the clip MUST be `generate_audio = true`. Never write dialogue into a clip you are silencing — the
prompt and the flag would contradict each other (this exact mistake shipped a silent ad whose
prompts were full of spoken lines).

**Multi-clip voice consistency (target exceeds the model's single-clip max — e.g. a 30s ad = 2
clips).** Native audio is generated per clip, so the voice timbre can differ between clips.
For multi-clip voice consistency, the orchestration decision (carry the voice via
`reference-to-video` `@Audio1` — never mute + TTS) lives in the **`voiceover-production`**
skill. Load it; do not re-decide audio policy here.

The ONLY case that mutes audio is stitching real **source footage** (a stitch route's source clips
carry their own un-unifiable audio) — that is about *source* audio, never a reason to silence an
*AI* generation. The orchestration of any voiceover that spans such a stitch is owned by
**`voiceover-production`**.

### Banned tokens — text-request patterns

Reject any user-supplied prompt language that requests in-video text. Paraphrase before engineering the final prompt:

| User wrote | Replace with |
|---|---|
| "with the brand name AquaFlow on the bottle" | "[bottle with a small unbranded label area]" + queue `libi.add_overlay({ kind: "text" })` for "AquaFlow" on the beat |
| "captions reading 'stays cold 24h'" | omit from video prompt; queue `libi.add_overlay({ kind: "text" })` for the caption |
| "sign on the wall says 'OPEN'" | omit; if the sign has narrative weight, add as image overlay or text overlay post-gen |
| "she holds a phone showing the email 'order confirmed'" | omit the email text; phone is fine, screen contents are an overlay added after |

These are not generic — these are documented failure cases from the v2.1 round 2 review.

## Step 6.7 — Physical-action / manipulation beats → `physical-action-video`

When a beat is a **physical action / manipulation** (filling, opening, pouring, applying, peeling,
pressing, twisting, gripping-and-releasing, writing, cutting) — i.e. `physicalActionVerification`
beats in `ugc-product-video` — load the **`physical-action-video`** skill and follow it. Frame
analysis cannot validate motion, so it owns the defenses: prompt decomposition (3–5 one-verb
sub-steps, object anchoring, affordance pre-conditions), the FLF-first approach + per-model FLF
shapes, the model-escalation ladder, the editorial before/after fallback, and the levers that keep
isolated clips looking like one video. Do not re-derive this craft here.

## Step 7 — Build the prompt

Compose a detailed, structured prompt — never a one-line summary. Show it to the user for approval before running. A good image prompt looks like:

> "Photorealistic medium close-up of a 30-year-old woman with short dark hair, wearing a navy raincoat, walking through a Tokyo alley at dusk. Neon signs reflect on wet pavement. Shot on 50mm lens, shallow depth of field, cinematic color grade. Mood: introspective, moody."

A good video prompt adds camera language and timing:

> "Handheld 6-second clip. Subject: same woman. Action: she stops, looks up at a neon sign, then keeps walking left frame. Camera: subtle handheld bob, no cuts. Aspect: 9:16. Lighting: continues the dusk-neon palette."

### Veo 3.1 fast — model-specific prompt template

When the chosen model is `veo3.1-fast` / `veo3-fast` (default for UGC video as of 2026-05), use this exact 7-layer ordering. The model responds dramatically better when the layers appear in this order. Length target: **100-200 words** (Veo 3.1 prioritizes elements unpredictably above ~400 chars; under 100 chars yields generic results).

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

Skip the approval gate if the user's memories opt out (a rule they saved in their memories file — shown under `## Memories` at the bottom of your instructions, editable on the Instructions page).

## Step 8 — Run

- Short jobs (image, single audio): provider's `run_model` (synchronous).
- Long jobs (video, training, batch image): provider's `submit_job` then poll `check_job` every 5 seconds until `status === "completed"`.
- **Endpoint ids are operation-specific.** Submit to the FULL endpoint id including its operation suffix (e.g. `bytedance/seedance-2.0/image-to-video`), never a bare model-family id — a family id without the operation suffix 404s on fal.

If the job fails, show the provider's error message verbatim and ask the user how to proceed (retry, refine, or stop).

### Use `libi.sleep` between polls — do NOT use Terminal sleep or ScheduleWakeup

When polling a long-running provider job (e.g. fal-ai `check_job`, elevenlabs job status), wait via `libi.sleep({ seconds: 20, reason: "waiting for fal-ai/<endpoint> to finish" })` between checks. This is server-side, AbortSignal-aware, and emits progress notifications every 5 s. Do NOT use `Terminal sleep N` (can hit tool-call timeouts on long waits) or `ScheduleWakeup` (can fail to re-fire — caused the v2 round-1 3-hour ghost-wait). Recommended cadence:

- First 5 polls: `libi.sleep({ seconds: 20 })` between each call (covers most veo3.1-fast jobs)
- Polls 5-15: `libi.sleep({ seconds: 30 })`
- Beyond: `libi.sleep({ seconds: 60 })` and consider asking the user before continuing

Most fal video jobs complete in 60-150 s. If a job is still IN_QUEUE after 5 min, surface it to the user.

## Step 9 — Import the result

Each provider returns a URL or base64 payload.

- If you have base64 → `libi.save_asset({ pieceId, name, mimeType, dataBase64 })`.
- If you have a URL → download to a temp path with `fetch` (or fal's download tool if available), then `libi.upload_file({ pieceId, filePath, aiGeneration })`.

Set the `name` to something descriptive (`"ugc-hook-shot.mp4"`, not `"output.mp4"`).

**Grouping related assets into a folder:** when a flow produces MULTIPLE related files (an extend chain, several variants of one beat, a batch of takes), create one folder up front via `libi.create_asset_folder({ pieceId, name })` and pass its `folderId` to every `libi.upload_file` call. Each file is its own standalone asset; the folder just keeps the related set together. A SINGLE standalone file needs no folder — upload it to the scope root (omit `folderId`). The composition references whichever individual file you choose, by `fileId`. See the `using-asset-folders` skill for the full workflow.

### MANDATORY — pass `aiGeneration` on every AI-sourced upload

`libi.upload_file` accepts an `aiGeneration` object that populates the asset preview Generation tab and enables the "Fetch actual cost" button later. **Always pass it for AI-generated files.** Skipping it means the file looks like a plain upload to the rest of the app — no Generation tab, no cost-fetch, no lineage in the UI.

Shape (capture the timestamps yourself around the `submit_job` → `check_job` → `download` arc — clock starts when you submit, stops when the file is local):

```jsonc
aiGeneration: {
  provider: "fal-ai",                    // MCP id (matches mcp_servers.id)
  model: "fal-ai/veo3.1/fast",           // exact model id you submitted
  prompt: "<the full engineered prompt verbatim>",
  costEstimate: { amount: 0.50, currency: "USD", tier: "veo3.1-fast/720p/9:16" },
  startedAt: "2026-05-27T11:00:00.000Z", // ISO, before submit_job
  completedAt: "2026-05-27T11:00:42.000Z", // ISO, after the download finishes
  durationMs: 42000,                     // completedAt - startedAt
  providerJobId: "req_abc123",           // fal request_id from submit_job
  attemptNumber: 0                       // 0 = first attempt; bump on regen
}
```

`costEstimate` comes from the provider's `get_pricing` tool earlier in Step 5; reuse that exact tier label. `attemptNumber` is 0 for the first attempt — increment when you regenerate the same beat with a tightened prompt.

### Then append the notes lineage line

**Always append a notes line via `libi.update_file_notes` after the save.** Include model, retry index, parent file id (if this is a retry / extension), an 8-hex prompt-hash, and the validation summary if you ran Stage 4.5 validation (see the `ugc-product-video` skill). Format:

```
<ISO timestamp> | model=<id> | retry=<n> | parent=<fileId|null> | prompt-hash=<8 hex> | validation=<ok|minor|reject>
```

The aiGeneration structured field and the notes line are complementary: aiGeneration is the machine-readable provenance shown in the UI; the notes line is the human-readable diff-friendly log that other skills (`ugc-product-video`, retry loops) read to pick canonical takes.

## Step 10 — Iterate or finish

Show the imported file to the user. **Put the salient result in front of them** with `libi.show_in_chat({ fileId, caption })` so the generated image/video/audio renders inline in the chat (an image gets a click-to-enlarge thumbnail; video/audio get an inline player). Show the *one* that matters — the accepted/selected take — not every candidate in a batch. (If `show_in_chat` isn't in your tool list you're on a terminal/CLI surface; use `libi.show_asset` + state the URL instead.) Then offer:

- **Regenerate with refinements** — "Want me to tighten the lighting or change the camera move?" Refine the prompt and rerun from Step 8.
- **Accept** — confirm done. Optionally `libi.show_asset({ pieceId, fileId })` to focus the editor.

## Grouping takes and variants into a folder

When the user's intent is "another take of the same thing" (same subject, different rendering), or when a prompt is ambiguous and you'd normally generate 2–3 variants, each output is its own standalone asset — there is no "option" or "default" anymore. To avoid flooding the piece with loose files, group the related set in a folder: call `libi.create_asset_folder({ pieceId, name })` once, then import each file with that `folderId` (`libi.upload_file({ ..., folderId })`). The composition references whichever individual file you pick, by `fileId`; swap that `fileId` to change which take is used. See the `using-asset-folders` skill for the full workflow.

## Notes

- Never call generation tools without going through this flow. The cost of a bad prompt is real money.
- The skill never bakes in price tables — they go stale. Always derive from the provider's pricing tool or page.
- Approval prompts can be skipped per-step if the user's memories explicitly opt out (a saved rule in their memories file).
- **Tracking.** To follow a moving subject in a generated video (blur, label, pin an overlay), see the `using-object-tracking` skill after importing the clip.
