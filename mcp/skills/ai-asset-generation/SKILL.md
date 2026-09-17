---
name: ai-asset-generation
description: "Produce ONE AI asset (image / video / audio / 3D) via a generation MCP (fal.ai, etc.) — the call + save layer: discover provider, pick model, read schema, disclose cost, build the prompt, run + poll, and import the file with provenance. Also owns the two universal video invariants: no in-video text, native audio on. The realism-image craft and the physical-action/FLF craft live in their own skills (realistic-image-generation, physical-action-video); the keyframe→clip WORKFLOW belongs to the Storyboard."
when_to_use: User asks to generate / create / make an image, video, audio clip, voiceover, sound effect, music, or 3D asset using AI — or an orchestration/storyboard skill needs to actually produce one asset. Triggers on phrases like "generate an image of", "make a video of", "create a sound effect", "design a logo".
tags:
  - generation
---

# AI Asset Generation (produce one asset — the call + save layer)

## Provider gate — read this first

You need a **image** provider. libi generates no media itself.

1. **Check your tool list.** If you already have a provider that can do image, use it.
   If this skill ships a reference for it — `references/providers/<id>.md` under this
   skill, where `<id>` is the provider's catalog id (`fal`, `elevenlabs`, `higgsfield`,
   `ace-step`, `kokoro`, `whisper`) — **read that file and follow it**. If there is no
   reference file for your provider, use the provider's own tool docs (its
   `get_model_schema` / `list_models` / equivalent) and keep to the capability and
   constraint rules in this skill. **libi's own extension tools count as a provider**
   for their kind — `libi.generate_music` (music), `libi.generate_speech` (voice),
   `libi.analysis_transcribe_audio` (transcription), `libi.remove_background` (matting,
   not generation). Prefer them by default: they are free and on-device. If one answers
   `needs_install`, follow its install flow (`libi.get_install_plan` / the download
   tools) instead of switching provider.
2. **If you have none** — no remote provider tool and no libi extension for image — call
   `libi.suggest_provider({ kind: "image" })`, tell the user what it showed, and
   **stop**. Do not improvise a provider, do not ask for an API key, and do not fall
   back to a tool that cannot do image.
   If it answers `status: "none"`, there is nothing to connect: everything libi knows of
   for image is already connected or already installed, and its `covered` list names it.
   Do not open anything or ask for a key — use what `covered` names, or, if that
   cannot do what was asked, say plainly what libi cannot do.

`libi.list_providers()` gives you the same picture without putting a card in the chat — use it
for a general "what's connected?". When the user asks about a provider that is not in your tool
list, call `libi.suggest_provider` instead, so the chat shows the buttons to connect it.

**This skill dispatches four kinds.** Substitute the kind the current request actually
needs before you run the gate: `image` · `video` · `music` · `voice` (and `sfx` for a
sound effect). Speech and music have libi's own on-device extensions — Kokoro
(`voice`) and ACE-Step (`music`) — so for those two the gate usually resolves without
any remote provider at all; see Steps 1.6 and 1.7.

This skill is the **mechanics** layer: how to actually call a generation model and save the
result. It does NOT own the video WORKFLOW (which asset to make when, keyframe→clip sequencing) —
that is the **`using-storyboard`** skill. It also does not own the deep craft — those live in
focused skills the orchestration pulls:

- **`realistic-image-generation`** — how to make a good realistic image / keyframe (the realism
  model picker — its provider reference names the model — anti-AI-look tokens,
  selfie/demographic templates, anatomy plausibility + validation).
- **`physical-action-video`** — how to make a hard physical-manipulation beat survive (FLF-first,
  prompt decomposition, model-escalation ladder, editorial fallback).

What stays HERE: provider/model/cost mechanics, prompt building, run/poll, import + provenance,
and the two **universal video invariants** (no in-video text; native audio on — Step 6.6).

> **Related:** If the request features a recurring character or item — a named person, a specific product, a recurring prop, regardless of video type — check the `using-character-library` skill first and proactively surface any catalog match. The cross-piece catalog may already have a representative image you can use as a reference for image-to-image or character-consistent generation, saving a fresh generation entirely.

Use this skill any time the user asks to generate visual, audio, or 3D content with AI. Do not call generation-MCP tools directly — work the steps below in order so the user gets a usable asset on the first or second try instead of burning credits on prompt drift.

## Step 1 — Confirm the provider for this modality

The provider gate above already decided *which* provider you use. Confirm it can do the
modality this request needs, and note what libi supplies on-device regardless of provider:

| Modality | Where it comes from |
| --- | --- |
| image | your connected `image` provider |
| video | your connected `video` provider |
| audio: speech / voiceover | **local Kokoro TTS (default, free, on-device — `libi.generate_speech`)**; a `voice` provider on explicit request or for cloning |
| audio: SFX | your connected `sfx` provider |
| music | **local ACE-Step (default, free, on-device — `libi.generate_music`)**; a `music` provider on explicit request |
| 3D | your connected `image`/`video` provider, if it hosts a 3D model |

If the gate sent you to `libi.suggest_provider`, you already stopped. Do not restart the
flow by guessing a provider here.

## Step 1.6 — Separate voiceover track uses local TTS by default

> **Read Step 6.6 first.** A separate voiceover track is NOT the default for an AI
> video that has a speaking presenter — those clips carry **native audio** (`generate_audio
> = true`, see Step 6.6). Step 1.6 is only for a *standalone* spoken track: narration over
> b-roll, an explicit "add a voiceover" request, or the opt-in replacement when the user
> toggled native audio off.

For a standalone narration / voiceover track the default speech provider is local
Kokoro TTS (free, on-device). **Whether a generated video should get a separate spoken
track at all is owned by the `voiceover-production` skill** (its answer is normally no —
an AI clip's voice comes from the generation), and deliberately re-voicing a video that
already exists, including which voice provider suits the format, is
**`voice-replacement`**. Load the one that fits rather than deciding here.

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
   size from the payload (~8.3 GB) and get approval**, then call
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

Ask your provider what it has, don't guess: read `references/providers/<id>.md` for the
model-picking procedure, or the provider's own discovery/schema tools when this skill ships
no reference for it. Show the user the top 1–3 candidates with a cost tier and a one-line
summary; let them pick or accept the first.

> **Exception — realism images.** For a photoreal person / creator portrait / keyframe, do
> NOT let a provider's recommendation tool choose. Load **`realistic-image-generation`** —
> it owns the model picker, and its own `references/providers/<id>.md` names the model to
> confirm.

For a voice provider, the model is usually implicit; pick the **voice** instead (the
provider's voice-list tool).

## Step 4 — Quantity

Ask how many variants to generate (default 1 for video/audio, 4 for image). Skip if the user already specified.

## Step 5 — Cost

Default message:

> "This will cost credits from {provider}."

If the user asks for an estimate: use the provider's pricing tool first (`references/providers/<id>.md`
names it), and its public pricing page as a fallback. Multiply by quantity and **always
disclose that a page-derived number is an estimate.** Keep the tier label the pricing tool
returned — Step 9 reuses it verbatim in `costEstimate.tier`.

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
- **Continuity references** — if the user has a character, product, or style reference image, ask them to upload it (use `libi.upload_file`). A hosted model that takes image/audio inputs (`image_urls`, `audio_urls`) needs a **public `https` URL**, so a LOCAL libi file has to reach the provider's CDN first.
  - **Use your provider's own upload tool** (fal's `upload_file`, or whatever the provider documents) and pass the URL it returns. Your provider reference file, when this skill ships one for your provider, names the exact tool.
  - **A REMOTE (HTTP) provider MCP cannot read a local path** — fal's hosted `upload_file` returns `Cannot read local files from a remote MCP server`. When that happens you have three honest options, in order: use a locally-running (stdio) provider MCP whose upload tool can read the path; pass a URL that is already public; or **tell the user you cannot get the local file to the provider and ask how they'd like to proceed**. Only public `https` URLs work as inputs.
  - **NEVER do the upload yourself.** Do NOT read `FAL_KEY` (or any provider key) out of the database, env, settings, or shell; do NOT request a signed upload URL or `PUT`/`curl` bytes to provider storage; do NOT set an `Authorization` header. Provider credentials stay inside the provider's own MCP — handling raw keys yourself is a security breach, even with good intent.
- **Negative prompts** — if the model supports them, ask what to avoid.

## Step 6.5 — Realistic images / keyframes → `realistic-image-generation`

When the asset is a **realistic image** — a photoreal person, a creator portrait (mandatory for
`ugc-product-video` Stage 1), a character/product reference, or an FLF start/end keyframe — load
the **`realistic-image-generation`** skill and follow it. It owns the model picker (the strongest
realism-and-anatomy model your provider has, named in its `references/providers/<id>.md` — do NOT
let a provider's recommendation tool downgrade it), the anti-"AI-look" banned tokens + the
negative-prompt rule, the UGC selfie + demographic templates, and the mandatory
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

Skip the approval gate if the user's memories opt out (a rule they saved in their memories file — shown under `## Memories` at the bottom of your instructions, editable on the Instructions page).

**Model-specific prompt templates live with the model.** Per-engine grammar is in the
**`ai-video-models`** skill; anything specific to how *your provider* frames a prompt is in
`references/providers/<id>.md` under this skill. Read the one that applies before composing —
never wing a prompt from memory.

## Step 8 — Run

- Short jobs (image, single audio) usually run synchronously.
- Long jobs (video, training, batch image) are submit-then-poll. **Poll with `libi.sleep`**
  (`libi.sleep({ seconds: 20, reason: "waiting for <endpoint> to finish" })`) — it is
  server-side, AbortSignal-aware, and emits progress every 5 s. Do NOT use `Terminal sleep N`
  (tool-call timeouts) or `ScheduleWakeup` (can fail to re-fire — that caused a 3-hour
  ghost-wait in QA).
- **Model ids are usually operation-specific.** Submit the FULL id including its operation
  suffix; a bare model-family id 404s on most providers.

Your provider's exact tool names, poll cadence and endpoint-id shape are in
`references/providers/<id>.md`. If the job fails, show the provider's error message
verbatim and ask the user how to proceed (retry, refine, or stop).

## Step 9 — Import the result

Each provider returns a URL or base64 payload.

- If you have base64 → `libi.save_asset({ pieceId, name, mimeType, dataBase64 })`.
- If you have a URL → download to a temp path with `fetch` (or fal's download tool if available), then `libi.upload_file({ pieceId, filePath, aiGeneration })`.

Set the `name` to something descriptive (`"ugc-hook-shot.mp4"`, not `"output.mp4"`).

**Grouping related assets into a folder:** when a flow produces MULTIPLE related files (an extend chain, several variants of one beat, a batch of takes), create one folder up front via `libi.create_asset_folder({ pieceId, name })` and pass its `folderId` to every `libi.upload_file` call. Each file is its own standalone asset; the folder just keeps the related set together. A SINGLE standalone file needs no folder — upload it to the scope root (omit `folderId`). The composition references whichever individual file you choose, by `fileId`. See the `using-asset-folders` skill for the full workflow.

### MANDATORY — pass `aiGeneration` on every AI-sourced upload

`libi.upload_file` accepts an `aiGeneration` object that populates the asset preview Generation tab and enables the "Fetch actual cost" button later. **Always pass it for AI-generated files.** Skipping it means the file looks like a plain upload to the rest of the app — no Generation tab, no cost-fetch, no lineage in the UI.

Shape (capture the timestamps yourself around the submit → poll → download arc — clock
starts when you submit, stops when the file is local):

| field | value |
|---|---|
| `provider` | the provider's catalog id (`fal`, `elevenlabs`, …) |
| `model` | the exact endpoint id you submitted |
| `prompt` | the full engineered prompt, verbatim |
| `costEstimate` | `{ amount, currency, tier }` — `tier` is the pricing tool's own label |
| `startedAt` / `completedAt` | ISO, before submit / after the download finishes |
| `durationMs` | `completedAt - startedAt` |
| `providerJobId` | the provider's request id |
| `attemptNumber` | 0 = first attempt; bump on regen |

A filled-in example for your provider is in `references/providers/<id>.md`.

`costEstimate` comes from the provider's pricing tool earlier in Step 5; reuse that exact tier label. `attemptNumber` is 0 for the first attempt — increment when you regenerate the same beat with a tightened prompt.

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
- The skill never bakes in price tables — they go stale. Always derive from the provider's pricing tool or page (see `references/providers/<id>.md`).
- Approval prompts can be skipped per-step if the user's memories explicitly opt out (a saved rule in their memories file).
- **Tracking.** To follow a moving subject in a generated video (blur, label, pin an overlay), see the `using-object-tracking` skill after importing the clip.
